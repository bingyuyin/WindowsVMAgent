import type { ReviewSubmissionInput, WorkSubmissionInput } from "../agents/driver.ts";
import { SEVERITIES, type Severity, type Verdict } from "../types.ts";
import { truncate } from "../util.ts";

/**
 * Validation for agent submissions. Errors thrown here are returned to the agent as a failed
 * tool call, so messages are written as instructions the model can act on.
 */

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "blocker",
  blocking: "blocker",
  high: "major",
  important: "major",
  medium: "minor",
  moderate: "minor",
  low: "nit",
  style: "nit",
  suggestion: "minor",
  info: "nit",
};

export function normalizeVerdict(value: unknown): Verdict {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (text === "approve" || text === "approved" || text === "lgtm") return "approve";
  if (["request_changes", "changes_requested", "request_change", "reject", "needs_changes"].includes(text)) return "request_changes";
  throw new Error(`Invalid verdict '${String(value)}'. Use "approve" or "request_changes".`);
}

export function normalizeSeverity(value: unknown): Severity {
  const text = String(value ?? "").trim().toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(text)) return text as Severity;
  return SEVERITY_ALIASES[text] ?? "minor";
}

export function normalizeReview(input: unknown): ReviewSubmissionInput {
  const raw = (input ?? {}) as Partial<Record<keyof ReviewSubmissionInput, unknown>>;
  const verdict = normalizeVerdict(raw.verdict);
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("`summary` is required: give an overall assessment.");
  if (raw.comments !== undefined && !Array.isArray(raw.comments)) throw new Error("`comments` must be an array.");
  const comments = ((raw.comments as unknown[] | undefined) ?? []).map((item, index) => {
    const comment = (item ?? {}) as Record<string, unknown>;
    const body = typeof comment.body === "string" ? comment.body.trim() : "";
    if (!body) throw new Error(`comments[${index}].body is required.`);
    const line = Number(comment.line);
    const file = typeof comment.file === "string" && comment.file.trim() ? comment.file.trim().replaceAll("\\", "/") : undefined;
    return {
      severity: normalizeSeverity(comment.severity),
      file,
      line: Number.isInteger(line) && line > 0 ? line : undefined,
      body: truncate(body, 8000),
    };
  });
  if (verdict === "request_changes" && comments.length === 0) {
    throw new Error("request_changes requires at least one actionable comment. Add comments, or approve if nothing needs to change.");
  }
  const blocking = comments.filter((comment) => comment.severity === "blocker" || comment.severity === "major");
  if (verdict === "approve" && blocking.length) {
    throw new Error(
      "You approved but included blocker/major comments. Use request_changes, or downgrade them to minor/nit if they truly do not block approval.",
    );
  }
  return { verdict, summary: truncate(summary, 8000), comments };
}

export function normalizeWork(input: unknown, expectedCommentIds: readonly string[]): WorkSubmissionInput {
  const raw = (input ?? {}) as Partial<Record<keyof WorkSubmissionInput, unknown>>;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("`summary` is required: describe what you did this round.");
  if (raw.comment_responses !== undefined && !Array.isArray(raw.comment_responses)) {
    throw new Error("`comment_responses` must be an array.");
  }
  const expected = new Set(expectedCommentIds.map((id) => id.toUpperCase()));
  const responses: NonNullable<WorkSubmissionInput["comment_responses"]> = [];
  for (const [index, item] of ((raw.comment_responses as unknown[] | undefined) ?? []).entries()) {
    const response = (item ?? {}) as Record<string, unknown>;
    const id = String(response.comment_id ?? "").trim().replace(/^\[|\]$/g, "").toUpperCase();
    if (!expected.has(id)) continue;
    const status = String(response.status ?? "").trim().toLowerCase();
    if (status !== "addressed" && status !== "declined") {
      throw new Error(`comment_responses[${index}].status must be "addressed" or "declined".`);
    }
    const note = typeof response.note === "string" ? response.note.trim() : "";
    if (!note) throw new Error(`comment_responses[${index}].note is required: explain the change or why you declined.`);
    responses.push({ comment_id: id, status, note: truncate(note, 4000) });
  }
  const answered = new Set(responses.map((response) => response.comment_id));
  const missing = [...expected].filter((id) => !answered.has(id));
  if (missing.length) {
    throw new Error(
      `Missing comment_responses for: ${missing.join(", ")}. Respond to every open comment ID with status "addressed" or "declined" and a note.`,
    );
  }
  const validation = typeof raw.validation === "string" && raw.validation.trim() ? truncate(raw.validation.trim(), 8000) : undefined;
  return { summary: truncate(summary, 12000), validation, comment_responses: responses };
}

/** Best-effort review when a reviewer never called submit_review. */
export function fallbackReview(lastMessage: string | undefined): ReviewSubmissionInput {
  const text = (lastMessage ?? "").trim();
  const approves = /\b(approve|approved|lgtm)\b/i.test(text) && !/request(ed|ing)?[\s_-]*changes|changes[\s_-]+requested/i.test(text);
  if (approves) return { verdict: "approve", summary: truncate(text, 4000), comments: [] };
  return {
    verdict: "request_changes",
    summary: "The reviewer did not submit a structured review; its final message is included as a comment.",
    comments: [{ severity: "major", body: truncate(text || "No review content was produced.", 6000) }],
  };
}
