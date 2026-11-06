import type { CodeReview, CuratedComment, ReviewEvent, ReviewPullRequest, Severity } from "../types.ts";
import { errorMessage, nowIso, truncate } from "../util.ts";

/** Publishes review comments on a pull request (GitHub, through the GitHub CLI). */
export interface ReviewPublisher {
  /** Why publishing to this pull request is not possible right now; null when it is. */
  unavailable(pr: ReviewPullRequest): Promise<string | null>;
  createReview(pr: ReviewPullRequest, review: NewReview): Promise<CreatedReview>;
  updateReview(pr: ReviewPullRequest, reviewId: number, body: string): Promise<void>;
  updateComment(pr: ReviewPullRequest, commentId: number, body: string): Promise<void>;
  deleteComment(pr: ReviewPullRequest, commentId: number): Promise<void>;
}

export interface NewReview {
  commitId: string;
  body: string;
  event: ReviewEvent;
  comments: Array<{ path: string; line: number; body: string }>;
}

export interface CreatedReview {
  reviewId: number;
  url?: string;
  /** The inline comments as created on the host. */
  comments: Array<{ id: number; path: string; body: string; url?: string }>;
}

/** Thrown by publishers when the host rejects inline comments on lines it does not consider part of the diff. */
export class LineOutsideDiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineOutsideDiffError";
  }
}

export const SEVERITY_TITLES: Record<Severity, string> = { blocker: "Blocker", major: "Major", minor: "Minor", nit: "Nit" };
export const REVIEW_EVENTS: readonly ReviewEvent[] = ["COMMENT", "REQUEST_CHANGES", "APPROVE"];
const FOLLOW_UP_BODY = "Additional review comments.";

/**
 * Lines of each file a pull request comment can be attached to: the new version's lines inside the diff's
 * hunks (added and context lines), which is what hosts accept for inline comments on the changed side.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>();
  let current: Set<number> | null = null;
  let header = false;
  let next = 0;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      header = true;
      current = null;
      next = 0;
      continue;
    }
    if (header) {
      if (line.startsWith("+++ ")) {
        const target = line.slice(4).trim();
        if (target !== "/dev/null") {
          const file = unquote(target).replace(/^b\//, "");
          current = files.get(file) ?? new Set<number>();
          files.set(file, current);
        }
        continue;
      }
      if (!line.startsWith("@@")) continue;
      header = false;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (!current || !next) continue;
    // Added and context lines exist in the new version; removed lines and "\ No newline" markers do not.
    if (line.startsWith("+") || line.startsWith(" ")) current.add(next++);
  }
  return files;
}

/** Git quotes paths with special characters, e.g. "b/caf\303\251.txt". */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const escaped = body[++index] ?? "";
    if (/[0-7]/.test(escaped)) {
      bytes.push(parseInt(body.slice(index, index + 3), 8));
      index += 2;
    } else {
      bytes.push(({ n: 10, t: 9, '"': 34, "\\": 92 } as Record<string, number>)[escaped] ?? escaped.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The text of a comment as it appears on the pull request. */
export function formatComment(comment: Pick<CuratedComment, "severity" | "body">): string {
  return `**${SEVERITY_TITLES[comment.severity]}:** ${comment.body.trim()}`;
}

const location = (comment: Pick<CuratedComment, "file" | "line">) =>
  comment.file ? `\`${comment.file}${comment.line ? `:${comment.line}` : ""}\`` : "General";

/** Whether a comment can be attached to a line of the pull request's diff. */
export function isInline(comment: Pick<CuratedComment, "file" | "line">, anchors: Map<string, Set<number>>): boolean {
  return Boolean(comment.file && comment.line && anchors.get(comment.file)?.has(comment.line));
}

/** The review's own text: the user's summary, then the comments that cannot be attached to a diff line. */
export function mainReviewBody(review: Pick<CodeReview, "body">, bodyComments: readonly CuratedComment[]): string {
  const parts = [(review.body ?? "").trim() || "Review comments below."];
  if (bodyComments.length) {
    parts.push("", "#### Comments outside the changed lines");
    for (const comment of bodyComments) parts.push("", `**${SEVERITY_TITLES[comment.severity]}** · ${location(comment)}`, "", comment.body.trim());
  }
  return parts.join("\n");
}

/** The whole review as Markdown, for hosts the hub cannot publish to (copy and paste it). */
export function reviewMarkdown(title: string, review: CodeReview): string {
  const kept = (review.curated ?? []).filter((comment) => comment.decision === "keep");
  const parts = [`## ${title}`, "", (review.body ?? "").trim()];
  if (kept.length) {
    parts.push("", `### Comments (${kept.length})`);
    for (const comment of kept) parts.push("", `**${SEVERITY_TITLES[comment.severity]}** · ${location(comment)}`, "", comment.body.trim());
  }
  return `${parts.join("\n").trim()}\n`;
}

export interface PublishPlan {
  /** Kept comments with a diff line that are not on the pull request yet. */
  create: CuratedComment[];
  /** Published inline comments whose text or severity changed. */
  update: CuratedComment[];
  /** Published inline comments the user dropped since. */
  remove: CuratedComment[];
  /** Kept comments without a diff line: they live in the main review's text. */
  bodyComments: CuratedComment[];
  mainBody: string;
  /** The main review's text differs from what was published (always true before the first publication). */
  mainChanged: boolean;
}

/** What publishing has to do on the pull request so that it shows the curated review. */
export function planPublication(review: CodeReview, anchors: Map<string, Set<number>>): PublishPlan {
  const curated = review.curated ?? [];
  const main = review.publications?.find((publication) => publication.main);
  const kept = curated.filter((comment) => comment.decision === "keep");
  // A comment published inline stays inline; others go inline when they have a diff line.
  const inline = (comment: CuratedComment) => (comment.published ? comment.published.inline : isInline(comment, anchors));
  const bodyComments = kept.filter((comment) => !inline(comment));
  const mainBody = mainReviewBody(review, bodyComments);
  return {
    create: kept.filter((comment) => inline(comment) && !comment.published),
    update: kept.filter((comment) => comment.published?.inline && comment.published.body !== formatComment(comment)),
    remove: curated.filter((comment) => comment.decision === "drop" && comment.published?.inline),
    bodyComments,
    mainBody,
    mainChanged: !main || main.body !== mainBody,
  };
}

/** Number of changes the pull request does not show yet; null before the review was first published. */
export function pendingChanges(review: CodeReview, anchors: Map<string, Set<number>>): number | null {
  if (!review.publications?.some((publication) => publication.main)) return null;
  const plan = planPublication(review, anchors);
  return plan.create.length + plan.update.length + plan.remove.length + (plan.mainChanged ? 1 : 0);
}

export interface PublishOutcome {
  ok: boolean;
  message: string;
  created: number;
  updated: number;
  deleted: number;
  /** Comments in the review's text (no diff line to attach them to). */
  inBody: number;
  textUpdated: boolean;
  errors: string[];
}

/**
 * Publishes the curated review on the pull request, or brings an earlier publication up to date: the first time
 * it creates the review (inline comments on diff lines, the rest in its text); later it edits changed comments,
 * deletes dropped ones, adds new ones in a follow-up review and updates the review's text. Records what was
 * published on the review. Host errors end up in the outcome, never thrown.
 */
export async function publishReview(
  review: CodeReview,
  pr: ReviewPullRequest,
  publisher: ReviewPublisher,
  anchors: Map<string, Set<number>>,
  commitId: string,
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = { ok: true, message: "", created: 0, updated: 0, deleted: 0, inBody: 0, textUpdated: false, errors: [] };
  const plan = planPublication(review, anchors);
  const at = nowIso();
  const publications = (review.publications ??= []);
  const toInline = (comments: readonly CuratedComment[]) => comments.map((comment) => ({ path: comment.file!, line: comment.line!, body: formatComment(comment) }));
  const markBody = (comments: readonly CuratedComment[]) => {
    for (const comment of comments) comment.published = { inline: false, body: formatComment(comment), at };
  };
  const markInline = (sent: readonly CuratedComment[], created: CreatedReview) => {
    const remaining = [...created.comments];
    for (const comment of sent) {
      const body = formatComment(comment);
      const index = remaining.findIndex((candidate) => candidate.path === comment.file && normalize(candidate.body) === normalize(body));
      const match = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
      comment.published = { inline: true, remoteId: match?.id, url: match?.url, body, at };
    }
  };
  const name = `pull request #${pr.number}`;

  let main = publications.find((publication) => publication.main);
  if (!main) {
    const event = review.event ?? "COMMENT";
    let inline = plan.create;
    let bodyComments = plan.bodyComments;
    let created: CreatedReview;
    try {
      created = await publisher.createReview(pr, { commitId, body: plan.mainBody, event, comments: toInline(inline) });
    } catch (error) {
      if (!(error instanceof LineOutsideDiffError) || !inline.length) return finish(review, outcome, `Could not publish the review on ${name}: ${errorMessage(error)}`, false);
      // The host's diff differs from the local one: put every comment in the review's text instead.
      bodyComments = [...bodyComments, ...inline];
      inline = [];
      try {
        created = await publisher.createReview(pr, { commitId, body: mainReviewBody(review, bodyComments), event, comments: [] });
      } catch (retryError) {
        return finish(review, outcome, `Could not publish the review on ${name}: ${errorMessage(retryError)}`, false);
      }
      outcome.errors.push(`the pull request rejected inline comments (${errorMessage(error)}), so every comment went into the review's text`);
    }
    markInline(inline, created);
    markBody(bodyComments);
    publications.push({ number: pr.number, reviewId: created.reviewId, url: created.url, event, main: true, body: mainReviewBody(review, bodyComments), at });
    outcome.created = inline.length;
    outcome.inBody = bodyComments.length;
    const counts = [`${plural(outcome.created, "inline comment")}`, outcome.inBody ? `${outcome.inBody} in the review's text` : ""].filter(Boolean).join(", ");
    return finish(review, outcome, `Published the review on ${name}: ${counts}`, true);
  }

  for (const comment of plan.update) {
    const body = formatComment(comment);
    if (comment.published?.remoteId === undefined) {
      outcome.errors.push(`${comment.id}: the hub does not know its comment on the pull request, so edit it there`);
      continue;
    }
    try {
      await publisher.updateComment(pr, comment.published.remoteId, body);
      comment.published = { ...comment.published, body, at };
      outcome.updated++;
    } catch (error) {
      outcome.errors.push(`${comment.id}: could not edit the comment (${errorMessage(error)})`);
    }
  }
  for (const comment of plan.remove) {
    if (comment.published?.remoteId === undefined) {
      outcome.errors.push(`${comment.id}: the hub does not know its comment on the pull request, so delete it there`);
      continue;
    }
    try {
      await publisher.deleteComment(pr, comment.published.remoteId);
      comment.published = undefined;
      outcome.deleted++;
    } catch (error) {
      outcome.errors.push(`${comment.id}: could not delete the comment (${errorMessage(error)})`);
    }
  }
  let bodyComments = plan.bodyComments;
  if (plan.create.length) {
    try {
      const created = await publisher.createReview(pr, { commitId, body: FOLLOW_UP_BODY, event: "COMMENT", comments: toInline(plan.create) });
      markInline(plan.create, created);
      publications.push({ number: pr.number, reviewId: created.reviewId, url: created.url, event: "COMMENT", main: false, body: FOLLOW_UP_BODY, at });
      outcome.created = plan.create.length;
    } catch (error) {
      if (error instanceof LineOutsideDiffError) {
        bodyComments = [...bodyComments, ...plan.create];
        outcome.errors.push(`the pull request rejected the new inline comments (${errorMessage(error)}), so they went into the review's text`);
      } else {
        outcome.errors.push(`could not add ${plural(plan.create.length, "new comment")} (${errorMessage(error)})`);
      }
    }
  }
  const mainBody = mainReviewBody(review, bodyComments);
  if (main.body !== mainBody) {
    try {
      await publisher.updateReview(pr, main.reviewId, mainBody);
      main.body = mainBody;
      main.updatedAt = at;
      for (const comment of review.curated ?? []) {
        if (comment.published && !comment.published.inline && !bodyComments.includes(comment)) comment.published = undefined;
      }
      markBody(bodyComments);
      outcome.textUpdated = true;
    } catch (error) {
      outcome.errors.push(`could not update the review's text (${errorMessage(error)})`);
    }
  }
  outcome.inBody = bodyComments.length;
  const changes = [
    outcome.created ? `${outcome.created} added` : "",
    outcome.updated ? `${outcome.updated} edited` : "",
    outcome.deleted ? `${outcome.deleted} deleted` : "",
    outcome.textUpdated ? "review text updated" : "",
  ].filter(Boolean);
  const message = changes.length ? `Updated the review on ${name}: ${changes.join(", ")}` : `Nothing new to publish: ${name} already shows the latest review`;
  return finish(review, outcome, message, true);
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function finish(review: CodeReview, outcome: PublishOutcome, message: string, ok: boolean): PublishOutcome {
  outcome.ok = ok && !outcome.errors.length;
  outcome.message = outcome.errors.length ? `${message}. Problems: ${truncate(outcome.errors.join("; "), 1500)}` : message;
  review.lastPublish = { at: nowIso(), ok: outcome.ok, message: outcome.message };
  return outcome;
}
