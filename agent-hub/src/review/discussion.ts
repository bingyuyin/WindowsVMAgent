import type { CodeReview, CuratedComment, FinalComment, FinalReview, Position, PositionEntry, ReviewerComment, Severity, SignOff, Verdict } from "../types.ts";
import { truncate } from "../util.ts";
import { normalizeSeverity, normalizeVerdict } from "../workflow/submissions.ts";

/**
 * Validation for the code review reviewers' submissions (submit_findings, submit_positions, submit_final_review,
 * submit_signoff). Errors are returned to the agent as a failed tool call, so they read as instructions.
 */

export interface CommentInput {
  severity: Severity;
  file?: string;
  line?: number;
  body: string;
}

export interface FindingsInput {
  changeSummary: string;
  assessment: string;
  verdict: Verdict;
  comments: CommentInput[];
}

export interface PositionsInput {
  summary: string;
  responses: PositionEntry[];
  updates: Array<{ commentId: string; action: "withdraw" | "revise"; note: string; body?: string; severity?: Severity; line?: number }>;
  newComments: CommentInput[];
}

export interface FinalInput {
  changeSummary: string;
  assessment: string;
  verdict: Verdict;
  comments: Array<CommentInput & { sources: string[] }>;
  dropped: Array<{ commentId: string; reason: string }>;
  objectionResponses: Array<{ objection: string; response: string }>;
}

export type SignoffInput = Omit<SignOff, "fallback">;

const MAX_COMMENTS = 60;

const text = (value: unknown, max: number): string => (typeof value === "string" ? truncate(value.trim(), max) : "");
const id = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toUpperCase();
const array = (value: unknown, key: string): unknown[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be an array.`);
  return value;
};

export function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/^[ab]\//, "");
}

function normalizeComment(item: unknown, key: string): CommentInput {
  const comment = (item ?? {}) as Record<string, unknown>;
  const body = text(comment.body, 8000);
  if (!body) throw new Error(`${key}.body is required: describe the problem and the expected fix.`);
  const line = Number(comment.line);
  return { severity: normalizeSeverity(comment.severity), file: normalizePath(comment.file), line: Number.isInteger(line) && line > 0 ? line : undefined, body };
}

function checkVerdict(verdict: Verdict, comments: readonly CommentInput[]): void {
  if (verdict === "request_changes" && !comments.length) {
    throw new Error("request_changes needs at least one comment that says what must change. Add the comments, or use approve.");
  }
  if (verdict === "approve" && comments.some((comment) => comment.severity === "blocker" || comment.severity === "major")) {
    throw new Error("You approved but listed blocker/major comments. Use request_changes, or downgrade them to minor/nit if they do not block merging.");
  }
}

export function normalizeFindings(input: unknown): FindingsInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const changeSummary = text(raw.change_summary, 12_000);
  if (!changeSummary) throw new Error("`change_summary` is required: describe what the change does (purpose, main changes by area, risks).");
  const assessment = text(raw.assessment, 8000);
  if (!assessment) throw new Error("`assessment` is required: give your overall assessment of the change.");
  const verdict = normalizeVerdict(raw.verdict);
  const comments = array(raw.comments, "comments").map((item, index) => normalizeComment(item, `comments[${index}]`));
  if (comments.length > MAX_COMMENTS) throw new Error(`At most ${MAX_COMMENTS} comments: keep the ones that matter most.`);
  checkVerdict(verdict, comments);
  return { changeSummary, assessment, verdict, comments };
}

const POSITION_ALIASES: Record<string, Position> = {
  agree: "agree",
  agreed: "agree",
  accept: "agree",
  accepted: "agree",
  valid: "agree",
  "+1": "agree",
  disagree: "disagree",
  disagreed: "disagree",
  reject: "disagree",
  rejected: "disagree",
  object: "disagree",
  invalid: "disagree",
  refine: "refine",
  refined: "refine",
  amend: "refine",
  modify: "refine",
  partially_agree: "refine",
  partial: "refine",
};

/**
 * `peerIds`: the other reviewer's comments, each needing a response; `ownIds`: the reviewer's own comments,
 * which it may withdraw or revise.
 */
export function normalizePositions(input: unknown, peerIds: readonly string[], ownIds: readonly string[]): PositionsInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const summary = text(raw.summary, 6000);
  if (!summary) throw new Error("`summary` is required: sum up where you agree and disagree with the other reviewer.");
  const peer = new Set(peerIds.map(id));
  const own = new Set(ownIds.map(id));
  const responses: PositionEntry[] = [];
  for (const [index, item] of array(raw.responses, "responses").entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const commentId = id(entry.comment_id);
    if (!peer.has(commentId)) {
      if (own.has(commentId)) throw new Error(`responses[${index}]: ${commentId} is your own comment; change your own comments in \`own_updates\`.`);
      throw new Error(`responses[${index}]: unknown comment ID '${String(entry.comment_id)}'. Respond to the other reviewer's comments: ${[...peer].join(", ")}.`);
    }
    const position = POSITION_ALIASES[String(entry.position ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")];
    if (!position) throw new Error(`responses[${index}].position must be "agree", "disagree" or "refine".`);
    const note = text(entry.note, 4000);
    if (!note) throw new Error(`responses[${index}].note is required: give your reasoning (point to the code).`);
    const suggestedBody = text(entry.suggested_body, 8000) || undefined;
    const suggestedSeverity = entry.suggested_severity === undefined || entry.suggested_severity === null || entry.suggested_severity === "" ? undefined : normalizeSeverity(entry.suggested_severity);
    responses.push({ commentId, position, note, ...(suggestedBody ? { suggestedBody } : {}), ...(suggestedSeverity ? { suggestedSeverity } : {}) });
  }
  const answered = new Set(responses.map((response) => response.commentId));
  const missing = [...peer].filter((commentId) => !answered.has(commentId));
  if (missing.length) {
    throw new Error(`Missing responses for: ${missing.join(", ")}. Give one response (agree, disagree or refine, with a note) for every comment of the other reviewer.`);
  }
  const updates: PositionsInput["updates"] = [];
  for (const [index, item] of array(raw.own_updates, "own_updates").entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const commentId = id(entry.comment_id);
    if (!own.has(commentId)) throw new Error(`own_updates[${index}]: '${String(entry.comment_id)}' is not one of your comments (${[...own].join(", ") || "none"}).`);
    const action = String(entry.action ?? "").trim().toLowerCase();
    if (action !== "withdraw" && action !== "revise") throw new Error(`own_updates[${index}].action must be "withdraw" or "revise".`);
    const note = text(entry.note, 4000);
    if (!note) throw new Error(`own_updates[${index}].note is required: say why.`);
    const body = text(entry.body, 8000) || undefined;
    const severity = entry.severity === undefined || entry.severity === null || entry.severity === "" ? undefined : normalizeSeverity(entry.severity);
    const line = Number(entry.line);
    const revisedLine = Number.isInteger(line) && line > 0 ? line : undefined;
    if (action === "revise" && !body && !severity && !revisedLine) {
      throw new Error(`own_updates[${index}]: a revision needs the new \`body\`, \`severity\` or \`line\`.`);
    }
    updates.push({ commentId, action, note, body, severity, line: revisedLine });
  }
  const newComments = array(raw.new_comments, "new_comments").map((item, index) => normalizeComment(item, `new_comments[${index}]`));
  if (newComments.length > MAX_COMMENTS) throw new Error(`At most ${MAX_COMMENTS} new comments.`);
  return { summary, responses, updates, newComments };
}

/**
 * `accountable`: reviewer comments the final review must account for (all that were not withdrawn); `known`:
 * every reviewer comment ID.
 */
export function normalizeFinal(input: unknown, accountable: readonly string[], known: readonly string[]): FinalInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const changeSummary = text(raw.change_summary, 12_000);
  if (!changeSummary) throw new Error("`change_summary` is required: the final summary of what the change does.");
  const assessment = text(raw.assessment, 8000);
  if (!assessment) throw new Error("`assessment` is required: the overall assessment the change's author will read.");
  const verdict = normalizeVerdict(raw.verdict);
  const knownIds = new Set(known.map(id));
  const unknown = new Set<string>();
  const comments = array(raw.comments, "comments").map((item, index) => {
    const comment = normalizeComment(item, `comments[${index}]`);
    const sources = [...new Set(array((item as Record<string, unknown> | null)?.sources, `comments[${index}].sources`).map(id).filter(Boolean))];
    for (const source of sources) if (!knownIds.has(source)) unknown.add(source);
    return { ...comment, sources };
  });
  if (comments.length > MAX_COMMENTS) throw new Error(`At most ${MAX_COMMENTS} comments in the final review.`);
  const dropped = array(raw.dropped, "dropped").map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const commentId = id(entry.comment_id);
    if (!knownIds.has(commentId)) unknown.add(commentId || "(empty)");
    const reason = text(entry.reason, 2000);
    if (!reason) throw new Error(`dropped[${index}].reason is required: say why the comment is left out.`);
    return { commentId, reason };
  });
  if (unknown.size) throw new Error(`Unknown comment IDs: ${[...unknown].join(", ")}. Use the reviewers' comment IDs from the prompt (${[...knownIds].join(", ")}).`);
  const covered = new Set([...comments.flatMap((comment) => comment.sources), ...dropped.map((entry) => entry.commentId)]);
  const missing = accountable.map(id).filter((commentId) => !covered.has(commentId));
  if (missing.length) {
    throw new Error(
      `Account for every reviewer comment: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} in no final comment's \`sources\` and not in \`dropped\`. Merge each into a comment (list its ID in \`sources\`) or drop it with a reason.`,
    );
  }
  checkVerdict(verdict, comments);
  const objectionResponses = array(raw.objection_responses, "objection_responses")
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return { objection: text(entry.objection, 2000), response: text(entry.response, 4000) };
    })
    .filter((entry) => entry.response);
  return { changeSummary, assessment, verdict, comments, dropped, objectionResponses };
}

export function normalizeSignoff(input: unknown, known: readonly string[]): SignoffInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const value = raw.agree;
  const agreed = value === true || (typeof value === "string" && ["true", "yes", "agree", "approve", "approved"].includes(value.trim().toLowerCase()));
  if (value === undefined || value === null) throw new Error("`agree` is required: true when you accept the final review as a whole, otherwise false with objections.");
  const summary = text(raw.summary, 6000);
  if (!summary) throw new Error("`summary` is required: say why you accept the final review or what is wrong with it.");
  const knownIds = new Set(known.map(id));
  const objections = array(raw.objections, "objections").map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const issue = text(entry.issue, 4000);
    if (!issue) throw new Error(`objections[${index}].issue is required: say what is wrong and what the final review should do instead.`);
    const commentId = id(entry.comment_id) || undefined;
    if (commentId && !knownIds.has(commentId)) throw new Error(`objections[${index}]: unknown comment ID '${String(entry.comment_id)}'. Use a final comment ID (R1, R2...) or a reviewer comment ID.`);
    return { ...(commentId ? { commentId } : {}), issue };
  });
  if (!agreed && !objections.length) throw new Error("agree is false but no objections are listed: add one objection per problem, or agree.");
  return { agreed, summary, objections: agreed ? [] : objections };
}

// ---- Fallbacks (a reviewer never called its submit tool) -------------------------------------------

export function fallbackFindings(lastMessage: string | undefined): FindingsInput {
  return {
    changeSummary: "",
    assessment: truncate((lastMessage ?? "").trim() || "The reviewer produced no findings.", 6000),
    verdict: "approve",
    comments: [],
  };
}

/** The hub's own consolidation when the lead reviewer never submits one: every comment that was not withdrawn. */
export function fallbackFinal(review: CodeReview, leadSummary: string | undefined): FinalInput {
  const comments: FinalInput["comments"] = [];
  for (const comment of review.comments) {
    if (comment.withdrawn) continue;
    const existing = comments.find((candidate) => candidate.file === comment.file && candidate.line === comment.line && candidate.body === comment.body);
    if (existing) {
      existing.sources.push(comment.id);
      continue;
    }
    comments.push({ severity: comment.severity, file: comment.file, line: comment.line, body: comment.body, sources: [comment.id] });
  }
  const blocking = comments.some((comment) => comment.severity === "blocker" || comment.severity === "major");
  return {
    changeSummary: leadSummary ?? "",
    assessment: "The lead reviewer did not consolidate the review, so it lists every comment either reviewer kept after the discussion.",
    verdict: blocking ? "request_changes" : "approve",
    comments,
    dropped: [],
    objectionResponses: [],
  };
}

export function fallbackSignoff(): SignOff {
  return { agreed: false, summary: "The peer reviewer did not sign off on the final review.", objections: [], fallback: true };
}

// ---- State -------------------------------------------------------------------------------------------

/** Next free number for a reviewer's comment IDs (L for the lead reviewer, P for the peer reviewer). */
export function nextCommentNumber(comments: readonly ReviewerComment[], prefix: string): number {
  let max = 0;
  for (const comment of comments) {
    if (!comment.id.startsWith(prefix)) continue;
    const number = Number(comment.id.slice(prefix.length));
    if (Number.isInteger(number) && number > max) max = number;
  }
  return max + 1;
}

export function toFinalReview(input: FinalInput, fallback = false): FinalReview {
  const comments: FinalComment[] = input.comments.map((comment, index) => ({ id: `R${index + 1}`, ...comment }));
  return {
    changeSummary: input.changeSummary,
    assessment: input.assessment,
    verdict: input.verdict,
    comments,
    dropped: input.dropped,
    ...(input.objectionResponses.length ? { objectionResponses: input.objectionResponses } : {}),
    ...(fallback ? { fallback: true } : {}),
  };
}

/** The user's working copy of the final review: every comment kept, with the peer reviewer's objection to it, if any. */
export function curate(final: FinalReview, signoff: SignOff | undefined): CuratedComment[] {
  return final.comments.map((comment) => {
    const objection =
      signoff && !signoff.agreed
        ? signoff.objections
            .filter((entry) => entry.commentId === comment.id)
            .map((entry) => entry.issue)
            .join("\n\n")
        : "";
    return {
      id: comment.id,
      severity: comment.severity,
      file: comment.file,
      line: comment.line,
      body: comment.body,
      sources: comment.sources,
      decision: "keep" as const,
      ...(objection ? { objection } : {}),
    };
  });
}

/** Text published with the comments, until the user edits it. */
export function defaultReviewBody(final: FinalReview): string {
  return final.assessment.trim();
}
