import { createHash } from "node:crypto";
import type { CodeReview, CuratedComment, FinalComment, FinalReview, Position, PositionEntry, RequestResponse, ReviewerComment, Severity, SignOff, Verdict } from "../types.ts";
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
  /** `id`: in a revision of a finished review, the comment of the review it keeps or changes (absent for a new one). */
  comments: Array<CommentInput & { sources: string[]; id?: string }>;
  dropped: Array<{ commentId: string; reason: string }>;
  objectionResponses: Array<{ objection: string; response: string }>;
  requestResponses?: RequestResponse[];
}

/** A comment of the review being revised: the lead keeps it by giving its ID (or by repeating it unchanged). */
export interface CarriedComment {
  id: string;
  file?: string;
  body: string;
  sources: readonly string[];
}

export interface FinalOptions {
  /** Revising a finished review: its comments (the user's working copy, and earlier versions of this revision). */
  carried?: readonly CarriedComment[];
  /** The user's change requests the review must answer, and answers an earlier version gave (kept when not repeated). */
  requests?: readonly string[];
  answered?: readonly RequestResponse[];
}

export type SignoffInput = Omit<SignOff, "fallback">;

const MAX_COMMENTS = 60;

const text = (value: unknown, max: number): string => (typeof value === "string" ? truncate(value.trim(), max) : "");
/** The same comment text, whatever its whitespace. */
const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
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
 * `accountable`: comments the final review must account for (reviewer comments that were not withdrawn; in a revision,
 * the comments of the review the user kept); `known`: every reviewer comment ID. In a revision (`options.carried`), a
 * comment keeps one of the review's comments by its `id`, and `dropped` may list the review's comments too.
 */
export function normalizeFinal(input: unknown, accountable: readonly string[], known: readonly string[], options: FinalOptions = {}): FinalInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const changeSummary = text(raw.change_summary, 12_000);
  if (!changeSummary) throw new Error("`change_summary` is required: the final summary of what the change does.");
  const assessment = text(raw.assessment, 8000);
  if (!assessment) throw new Error("`assessment` is required: the overall assessment the change's author will read.");
  const verdict = normalizeVerdict(raw.verdict);
  const knownIds = new Set(known.map(id));
  const carried = new Map((options.carried ?? []).map((comment) => [id(comment.id), comment]));
  const unknown = new Set<string>();
  const claimed = new Set<string>();
  const comments: FinalInput["comments"] = array(raw.comments, "comments").map((item, index) => {
    const comment = normalizeComment(item, `comments[${index}]`);
    const record = (item ?? {}) as Record<string, unknown>;
    let commentId: string | undefined;
    if (carried.size && id(record.id)) {
      commentId = id(record.id);
      if (!carried.has(commentId)) {
        throw new Error(`comments[${index}].id: '${String(record.id)}' is not a comment of the review (${[...carried.keys()].join(", ")}). Give the ID of a comment you keep or change; omit it for a new comment.`);
      }
      if (claimed.has(commentId)) throw new Error(`comments[${index}].id: ${commentId} appears twice. Keep each comment once; merge duplicates into one comment.`);
      claimed.add(commentId);
    }
    const sources = [...new Set(array(record.sources, `comments[${index}].sources`).map(id).filter(Boolean))];
    for (const source of sources) {
      if (carried.has(source) && !knownIds.has(source)) {
        throw new Error(`comments[${index}].sources: ${source} is a comment of the review - give it in \`id\` to keep or change that comment. \`sources\` lists the reviewers' comments (L#, P#).`);
      }
      if (!knownIds.has(source)) unknown.add(source);
    }
    return { ...comment, sources, ...(commentId ? { id: commentId } : {}) };
  });
  // A comment repeated as it was keeps its ID without one; a comment kept by ID keeps the reviewer comments it came from.
  for (const comment of comments) {
    if (!comment.id && carried.size) {
      const same = [...carried.values()].find((candidate) => !claimed.has(id(candidate.id)) && candidate.file === comment.file && sameText(candidate.body, comment.body));
      if (same) {
        comment.id = id(same.id);
        claimed.add(comment.id);
      }
    }
    if (comment.id && !comment.sources.length) comment.sources = [...(carried.get(comment.id)?.sources ?? [])];
  }
  if (comments.length > MAX_COMMENTS) throw new Error(`At most ${MAX_COMMENTS} comments in the final review.`);
  const droppable = new Set([...knownIds, ...carried.keys()]);
  const dropped = array(raw.dropped, "dropped").map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const commentId = id(entry.comment_id);
    if (!droppable.has(commentId)) unknown.add(commentId || "(empty)");
    const reason = text(entry.reason, 2000);
    if (!reason) throw new Error(`dropped[${index}].reason is required: say why the comment is left out.`);
    return { commentId, reason };
  });
  if (unknown.size) throw new Error(`Unknown comment IDs: ${[...unknown].join(", ")}. Use the reviewers' comment IDs from the prompt (${[...droppable].join(", ")}).`);
  const covered = new Set([...comments.flatMap((comment) => [...comment.sources, ...(comment.id ? [comment.id] : [])]), ...dropped.map((entry) => entry.commentId)]);
  const missing = accountable.map(id).filter((commentId) => !covered.has(commentId));
  if (missing.length) {
    throw new Error(
      carried.size
        ? `Account for every comment: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} in no comment of the revised review and not in \`dropped\`. Keep a comment of the review by giving its ID in \`id\`, or drop it with a reason; merge a reviewer comment into a comment (\`sources\`) or drop it.`
        : `Account for every reviewer comment: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} in no final comment's \`sources\` and not in \`dropped\`. Merge each into a comment (list its ID in \`sources\`) or drop it with a reason.`,
    );
  }
  checkVerdict(verdict, comments);
  const objectionResponses = array(raw.objection_responses, "objection_responses")
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return { objection: text(entry.objection, 2000), response: text(entry.response, 4000) };
    })
    .filter((entry) => entry.response);
  const requestResponses = normalizeRequestResponses(raw.request_responses, options);
  return { changeSummary, assessment, verdict, comments, dropped, objectionResponses, ...(requestResponses.length ? { requestResponses } : {}) };
}

const REQUEST_STATUS: Record<string, RequestResponse["status"]> = {
  addressed: "addressed",
  address: "addressed",
  done: "addressed",
  fixed: "addressed",
  resolved: "addressed",
  applied: "addressed",
  accepted: "addressed",
  implemented: "addressed",
  declined: "declined",
  decline: "declined",
  rejected: "declined",
  refused: "declined",
  wont_fix: "declined",
  not_addressed: "declined",
};

/** One answer per change request the review handles (`options.requests`), in their order; earlier answers carry over. */
function normalizeRequestResponses(value: unknown, options: FinalOptions): RequestResponse[] {
  const requests = (options.requests ?? []).map(id);
  if (!requests.length) return [];
  const answers = new Map<string, RequestResponse>();
  for (const [index, item] of array(value, "request_responses").entries()) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const requestId = id(entry.request_id);
    if (!requests.includes(requestId)) {
      throw new Error(`request_responses[${index}]: '${String(entry.request_id ?? "")}' is not one of the user's change requests (${requests.join(", ")}).`);
    }
    const status = REQUEST_STATUS[String(entry.status ?? "").trim().toLowerCase().replace(/['’]/g, "").replace(/[\s-]+/g, "_")];
    if (!status) throw new Error(`request_responses[${index}].status must be "addressed" or "declined".`);
    const note = text(entry.note, 4000);
    if (!note) throw new Error(`request_responses[${index}].note is required: say what the review now does for the request, or why you decline it.`);
    answers.set(requestId, { requestId, status, note });
  }
  for (const answer of options.answered ?? []) if (!answers.has(id(answer.requestId))) answers.set(id(answer.requestId), answer);
  const unanswered = requests.filter((requestId) => !answers.has(requestId));
  if (unanswered.length) {
    throw new Error(
      `Answer every change request of the user in \`request_responses\`: ${unanswered.join(", ")} ${unanswered.length === 1 ? "has" : "have"} no answer. Use "addressed" with what the review now does for it, or "declined" with the reason.`,
    );
  }
  return requests.map((requestId) => answers.get(requestId)!);
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

/** The revision when the lead reviewer never submits one: the review stays as the user had it. */
export function fallbackRevision(workingCopy: readonly CuratedComment[], previous: FinalReview | undefined): FinalInput {
  return {
    changeSummary: previous?.changeSummary ?? "",
    assessment: previous?.assessment ?? "The lead reviewer did not revise the review.",
    verdict: previous?.verdict ?? "approve",
    comments: workingCopy.map((comment) => ({ id: comment.id, severity: comment.severity, file: comment.file, line: comment.line, body: comment.body, sources: [...comment.sources] })),
    dropped: [],
    objectionResponses: [],
  };
}

/** An earlier version of the final review as a submission: kept when the lead does not submit a new one. */
export function finalAsInput(final: FinalReview): FinalInput {
  return {
    changeSummary: final.changeSummary,
    assessment: final.assessment,
    verdict: final.verdict,
    comments: final.comments.map((comment) => ({ ...comment, sources: [...comment.sources] })),
    dropped: [...final.dropped],
    objectionResponses: [],
    ...(final.requestResponses?.length ? { requestResponses: final.requestResponses } : {}),
  };
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

/**
 * The final review from the lead's submission. Comments are numbered R1, R2... in order - except in a revision of a
 * finished review (`used`: every R# the review has had), where a comment the lead kept or changed keeps its ID and a
 * new one gets the next free number, so the user's decisions and the pull request's comments stay attached to it.
 */
export function toFinalReview(input: FinalInput, fallback = false, used?: Iterable<string>): FinalReview {
  let next = used ? nextFinalNumber([...used, ...input.comments.map((comment) => comment.id ?? "")]) : 1;
  const comments: FinalComment[] = input.comments.map(({ id: kept, ...comment }, index) => ({ id: used ? (kept ?? `R${next++}`) : `R${index + 1}`, ...comment }));
  return {
    changeSummary: input.changeSummary,
    assessment: input.assessment,
    verdict: input.verdict,
    comments,
    dropped: input.dropped,
    ...(input.objectionResponses.length ? { objectionResponses: input.objectionResponses } : {}),
    ...(input.requestResponses?.length ? { requestResponses: input.requestResponses } : {}),
    ...(fallback ? { fallback: true } : {}),
  };
}

/** Next free number for the final review's comment IDs (R1, R2...). */
export function nextFinalNumber(ids: Iterable<string>): number {
  let max = 0;
  for (const value of ids) {
    const match = /^R(\d+)$/.exec(value);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** The peer reviewer's objection to one comment of the final review, when it did not sign off. */
function objectionTo(signoff: SignOff | undefined, commentId: string): string {
  if (!signoff || signoff.agreed) return "";
  return signoff.objections
    .filter((entry) => entry.commentId === commentId)
    .map((entry) => entry.issue)
    .join("\n\n");
}

/** The user's working copy of the final review: every comment kept, with the peer reviewer's objection to it, if any. */
export function curate(final: FinalReview, signoff: SignOff | undefined): CuratedComment[] {
  return final.comments.map((comment) => {
    const objection = objectionTo(signoff, comment.id);
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

/** A comment's text, severity or place changed. */
function changed(before: Pick<CuratedComment, "body" | "severity" | "file" | "line">, after: Pick<FinalComment, "body" | "severity" | "file" | "line">): boolean {
  return !sameText(before.body, after.body) || before.severity !== after.severity || before.file !== after.file || before.line !== after.line;
}

/** Left out by an earlier revision rather than by the user: a revision that includes it again brings it back. */
const removedByRevision = (comment: CuratedComment): boolean => comment.decision === "drop" && comment.revision?.change === "removed";

/**
 * What a revision is written from: the comments of the user's working copy, their text and the user's decisions
 * (not what is on the pull request, which a revision keeps either way).
 */
export function workingCopyBasis(workingCopy: readonly CuratedComment[]): string {
  const content = workingCopy.map((comment) => [comment.id, comment.decision, comment.severity, comment.file ?? null, comment.line ?? null, comment.body]);
  return createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16);
}

/** What a revision changed compared with the review the user had: comments it added (or brought back), changed, or removed (of those the user kept). */
export interface RevisionChanges {
  added: FinalComment[];
  revised: Array<{ comment: FinalComment; before: CuratedComment }>;
  removed: CuratedComment[];
}

export function revisionChanges(workingCopy: readonly CuratedComment[], final: FinalReview): RevisionChanges {
  const byId = new Map(workingCopy.map((comment) => [comment.id, comment]));
  const added: FinalComment[] = [];
  const revised: RevisionChanges["revised"] = [];
  for (const comment of final.comments) {
    const before = byId.get(comment.id);
    if (!before || removedByRevision(before)) added.push(comment);
    else if (changed(before, comment)) revised.push({ comment, before });
  }
  const kept = new Set(final.comments.map((comment) => comment.id));
  const removed = workingCopy.filter((comment) => comment.decision === "keep" && !kept.has(comment.id));
  return { added, revised, removed };
}

/**
 * The user's working copy after a revision for their change requests: the revised review's comments - one it keeps
 * as it was keeps the user's decision and edit, a changed or new one starts as kept, and so does one an earlier
 * revision had removed - then the comments it removed that the user had kept or that are on the pull request, as
 * dropped (so the next publish removes them there). Publication records stay with their comments, so publishing
 * updates the pull request in place.
 */
export function reviseCurated(
  workingCopy: readonly CuratedComment[],
  final: FinalReview,
  signoff: SignOff | undefined,
  requests: readonly string[],
): { curated: CuratedComment[]; changes: RevisionChanges } {
  const byId = new Map(workingCopy.map((comment) => [comment.id, comment]));
  const curated: CuratedComment[] = final.comments.map((comment) => {
    const before = byId.get(comment.id);
    const objection = objectionTo(signoff, comment.id);
    const base: CuratedComment = {
      id: comment.id,
      severity: comment.severity,
      file: comment.file,
      line: comment.line,
      body: comment.body,
      sources: comment.sources,
      decision: "keep",
      ...(objection ? { objection } : {}),
      ...(before?.addedByUser ? { addedByUser: true } : {}),
      ...(before?.published ? { published: before.published } : {}),
    };
    if (!before) return { ...base, revision: { requests: [...requests], change: "added" } };
    if (removedByRevision(before)) {
      return { ...base, ...(before.original && !changed(before, comment) ? { original: before.original } : {}), revision: { requests: [...requests], change: "added", restored: true } };
    }
    if (!changed(before, comment)) return { ...base, decision: before.decision, ...(before.original ? { original: before.original } : {}) };
    return {
      ...base,
      revision: { requests: [...requests], change: "revised", previous: { body: before.body, severity: before.severity, file: before.file, line: before.line } },
    };
  });
  const kept = new Set(final.comments.map((comment) => comment.id));
  for (const before of workingCopy) {
    if (kept.has(before.id) || (before.decision === "drop" && !before.published)) continue;
    const rest: CuratedComment = { ...before };
    delete rest.objection;
    delete rest.revision;
    if (before.decision === "drop") {
      // Dropped by the user and still on the pull request: the next publish removes it.
      curated.push(rest);
      continue;
    }
    const reason = final.dropped.find((entry) => entry.commentId === before.id)?.reason;
    curated.push({ ...rest, decision: "drop", revision: { requests: [...requests], change: "removed", ...(reason ? { reason } : {}) } });
  }
  return { curated, changes: revisionChanges(workingCopy, final) };
}

/** Text published with the comments, until the user edits it. */
export function defaultReviewBody(final: FinalReview): string {
  return final.assessment.trim();
}
