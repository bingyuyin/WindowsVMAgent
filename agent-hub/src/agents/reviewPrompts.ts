import {
  ROLE_LABELS,
  type AgentRole,
  type CodeReview,
  type FinalReview,
  type RepoContext,
  type ReviewerComment,
  type ReviewerEntry,
  type SignOff,
  type Task,
} from "../types.ts";
import { truncate } from "../util.ts";
import { contextBlock } from "./prompts.ts";

/** Diffs up to this size are inlined in the reviewers' first prompt; larger ones are truncated (the rest is in git). */
export const MAX_REVIEW_DIFF = 120_000;

export interface ReviewTurnBase {
  task: Task;
  role: AgentRole;
  context?: RepoContext;
  /** First message of a session: include the request, the target, the repository context and the change. */
  includeContext: boolean;
  round: number;
  change: { stat: string; diff: { text: string; truncated: boolean } };
  /** Model the other reviewer runs on. */
  otherModel: string;
}

const short = (sha: string) => sha.slice(0, 10);
const other = (role: AgentRole): AgentRole => (role === "lead-reviewer" ? "peer-reviewer" : "lead-reviewer");
const label = (role: AgentRole) => ROLE_LABELS[role].toLowerCase();
const verdictText = (verdict: string | undefined) => (verdict === "approve" ? "approve" : verdict === "request_changes" ? "request changes" : "none");

function location(comment: { file?: string; line?: number }): string {
  return comment.file ? ` ${comment.file}${comment.line ? `:${comment.line}` : ""}` : "";
}

function quote(text: string): string {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function indent(text: string): string {
  return text.trim().replace(/\n/g, "\n  ");
}

/** Lead reviewer's comments first, then the peer reviewer's, each in number order (they arrive in either order). */
export function byCommentId(a: { id: string }, b: { id: string }): number {
  return a.id[0] === b.id[0] ? Number(a.id.slice(1)) - Number(b.id.slice(1)) : a.id[0] === "L" ? -1 : 1;
}

/** What is reviewed, and the user's focus. */
function requestBlock(task: Task): string {
  const target = task.review?.target;
  const pr = target?.pullRequest;
  const lines = [`# Task ${task.id}: ${task.title}`, "", "## What to review", ""];
  if (target) {
    if (pr) {
      lines.push(
        `- Pull request ${pr.provider === "gitlab" ? "!" : "#"}${pr.number}${pr.title ? ` "${pr.title}"` : ""}${pr.author ? ` by ${pr.author}` : ""}${pr.url ? ` (${pr.url})` : ""}`,
      );
      if (pr.headBranch || pr.baseBranch) lines.push(`- Branches: ${pr.headBranch ?? target.headRef} → ${pr.baseBranch ?? target.baseRef}`);
    } else {
      lines.push(`- ${target.headRef} compared with ${target.baseRef}`);
    }
    lines.push(`- The change is git diff ${short(task.baseSha ?? "")}..${short(target.headSha)} (merge-base with ${target.baseRef} → head); your worktree is pinned to the head.`);
    if (pr?.body?.trim()) lines.push("", "Pull request description:", "", quote(truncate(pr.body, 6000)));
  }
  lines.push("", "## The user's focus", "", task.description.trim());
  return lines.join("\n");
}

function changeBlock(change: ReviewTurnBase["change"], baseSha: string, headSha: string): string {
  const lines = ["", "## The change", "", `git diff --stat ${short(baseSha)}..${short(headSha)}:`, "```", change.stat || "(no changes)", "```"];
  if (change.diff.text.trim()) {
    lines.push(
      "",
      `Diff${change.diff.truncated ? ` (TRUNCATED - run git diff ${short(baseSha)}..HEAD in your worktree for the rest)` : ""}:`,
      "```diff",
      change.diff.text,
      "```",
    );
  } else {
    lines.push("", `Inspect it with: git diff ${short(baseSha)}..HEAD`);
  }
  return lines.join("\n");
}

function preamble(input: ReviewTurnBase): string[] {
  if (!input.includeContext) return [];
  const task = input.task;
  const parts = [requestBlock(task)];
  const context = contextBlock(input.context, input.role);
  if (context) parts.push(context);
  if (task.review && task.baseSha) parts.push(changeBlock(input.change, task.baseSha, task.review.target.headSha));
  parts.push("");
  return parts;
}

export function formatReviewerComments(comments: readonly ReviewerComment[]): string {
  return comments
    .map((comment) => {
      const head = `- [${comment.id}] (${comment.severity})${location(comment)} - ${indent(comment.body)}`;
      if (comment.withdrawn) return `${head}\n  [withdrawn by its reviewer: ${comment.withdrawn.note}]`;
      if (comment.revised) return `${head}\n  [revised by its reviewer: ${comment.revised.note}]`;
      return head;
    })
    .join("\n");
}

export function findingsPrompt(input: ReviewTurnBase): string {
  return [
    ...preamble(input),
    `## Round ${input.round}: review the change independently`,
    "",
    `The ${label(other(input.role))} (on ${input.otherModel}) reviews the same change at the same time; in the next round you will see each other's findings and discuss them.`,
    "Review the change now, then call `submit_findings` with:",
    "- `change_summary`: what the change does, for a reader who has not seen it - purpose, the main changes grouped by area or file, notable risks.",
    "- `assessment` and `verdict`: approve, or request_changes when a blocker or major issue must be fixed first.",
    "- `comments`: one per real issue, anchored to a file and a line of the new version.",
  ].join("\n");
}

export function positionsPrompt(
  input: ReviewTurnBase & { own: readonly ReviewerComment[]; theirs: readonly ReviewerComment[]; theirEntry?: ReviewerEntry },
): string {
  const them = label(other(input.role));
  const parts = [...preamble(input), `## Round ${input.round}: discuss the findings`, ""];
  if (input.theirEntry) {
    parts.push(`The ${them}'s assessment (verdict: ${verdictText(input.theirEntry.verdict)}):`, input.theirEntry.summary.trim() || "(none)", "");
  }
  parts.push(`The ${them}'s comments:`, input.theirs.length ? formatReviewerComments(input.theirs) : "(none)", "");
  parts.push("Your comments:", input.own.length ? formatReviewerComments(input.own) : "(none)", "");
  const ids = input.theirs.map((comment) => comment.id);
  parts.push(
    "Then call `submit_positions` with:",
    ids.length
      ? `1. \`responses\`: one for each of the ${them}'s comments (${ids.join(", ")}): agree, disagree (with evidence from the code) or refine (better text, severity or line in suggested_body / suggested_severity). Check each claim in the code before you agree.`
      : `1. \`responses\`: empty - the ${them} raised no comments.`,
    `2. \`own_updates\`: re-check your own comments in the light of the ${them}'s review; withdraw the ones that are wrong and revise the ones that should change.`,
    "3. `new_comments`: only real issues neither of you raised.",
  );
  return parts.join("\n");
}

/** The discussion as the lead reviewer consolidates it: every comment, its reviewer's changes and the other reviewer's stance. */
function discussionDigest(review: CodeReview, role: AgentRole): string {
  const stances = new Map<string, { role: AgentRole; text: string }[]>();
  for (const round of review.rounds) {
    if (round.phase !== "positions") continue;
    for (const entry of round.entries) {
      for (const position of entry.positions ?? []) {
        const suggestion = [position.suggestedSeverity ? `severity ${position.suggestedSeverity}` : "", position.suggestedBody ? `text: ${truncate(position.suggestedBody, 600)}` : ""]
          .filter(Boolean)
          .join("; ");
        const list = stances.get(position.commentId) ?? [];
        list.push({ role: entry.role, text: `${position.position} - ${position.note}${suggestion ? ` (suggested ${suggestion})` : ""}` });
        stances.set(position.commentId, list);
      }
    }
  }
  return [...review.comments]
    .sort(byCommentId)
    .map((comment) => {
      const lines = [formatReviewerComments([comment])];
      const responses = stances.get(comment.id) ?? [];
      for (const stance of responses) lines.push(`  ↳ ${stance.role === role ? "you" : label(stance.role)}: ${indent(stance.text)}`);
      if (!responses.length && !comment.withdrawn) lines.push("  ↳ no response from the other reviewer (raised in the discussion round)");
      return lines.join("\n");
    })
    .join("\n");
}

function finalReviewText(final: FinalReview, review: CodeReview): string {
  const lines = [
    "Summary of the change:",
    final.changeSummary.trim() || "(none)",
    "",
    `Assessment (verdict: ${verdictText(final.verdict)}):`,
    final.assessment.trim() || "(none)",
    "",
    "Comments:",
  ];
  if (!final.comments.length) lines.push("(none)");
  for (const comment of final.comments) {
    lines.push(`- [${comment.id}] (${comment.severity})${location(comment)}${comment.sources.length ? ` (from ${comment.sources.join(", ")})` : " (new)"} - ${indent(comment.body)}`);
  }
  if (final.dropped.length) {
    lines.push("", "Dropped reviewer comments:");
    for (const entry of final.dropped) {
      const source = review.comments.find((comment) => comment.id === entry.commentId);
      lines.push(`- [${entry.commentId}]${source ? ` (${source.severity})${location(source)} "${truncate(source.body.replace(/\s+/g, " "), 300)}"` : ""} - ${entry.reason}`);
    }
  }
  const withdrawn = review.comments.filter((comment) => comment.withdrawn);
  if (withdrawn.length) lines.push("", `Withdrawn by their reviewers during the discussion: ${withdrawn.map((comment) => comment.id).join(", ")}`);
  return lines.join("\n");
}

function objectionsText(signoff: SignOff): string {
  return signoff.objections.map((objection, index) => `${index + 1}. ${objection.commentId ? `[${objection.commentId}] ` : "(whole review) "}${indent(objection.issue)}`).join("\n");
}

export function finalPrompt(input: ReviewTurnBase & { review: CodeReview; previous?: FinalReview; signoff?: SignOff }): string {
  const review = input.review;
  const accountable = review.comments
    .filter((comment) => !comment.withdrawn)
    .sort(byCommentId)
    .map((comment) => comment.id);
  const parts = [...preamble(input)];
  if (input.previous && input.signoff) {
    parts.push(
      `## Round ${input.round}: revise the final review`,
      "",
      `The peer reviewer did not sign off: ${input.signoff.summary.trim()}`,
      "",
      "Objections:",
      objectionsText(input.signoff),
      "",
      "Your final review so far:",
      finalReviewText(input.previous, review),
      "",
      "Reviewer comments it draws on (after the discussion):",
      discussionDigest(review, input.role),
      "",
      "Address each objection: change the review where the peer reviewer is right, or keep your decision and explain why in `objection_responses`.",
      "Then call `submit_final_review` with the complete revised review - every comment and every dropped item, not only the changes.",
    );
  } else {
    const leadEntry = review.rounds.find((round) => round.phase === "findings")?.entries.find((entry) => entry.role === "lead-reviewer");
    const peerEntry = review.rounds.find((round) => round.phase === "findings")?.entries.find((entry) => entry.role === "peer-reviewer");
    parts.push(
      `## Round ${input.round}: write the final review`,
      "",
      "Both reviewers' comments after the discussion (yours are L1, L2...; the peer reviewer's P1, P2...):",
      review.comments.length ? discussionDigest(review, input.role) : "(none)",
      "",
      "Change summaries from the independent reviews:",
      `- Yours: ${indent(leadEntry?.changeSummary || "(none)")}`,
      `- Peer reviewer's: ${indent(peerEntry?.changeSummary || "(none)")}`,
      "",
      "Write the final review the change's author will read, then call `submit_final_review`:",
      "- `comments`: one per distinct issue. Merge duplicates and list every merged ID in `sources`; apply agreed refinements; keep the comments you both agree on; decide disputed ones on their merits. Each comment must stand on its own for the change's author.",
      "- `dropped`: every comment ID that is in no `sources`, with the reason. Withdrawn comments are dropped already.",
      "- `change_summary`, `assessment` and `verdict`.",
    );
  }
  parts.push(accountable.length ? `Account for each of these comment IDs, in a comment's sources or in dropped: ${accountable.join(", ")}.` : "No reviewer comments remain to account for.");
  return parts.join("\n");
}

export function signoffPrompt(input: ReviewTurnBase & { review: CodeReview; final: FinalReview }): string {
  const parts = [
    ...preamble(input),
    `## Round ${input.round}: sign off on the final review`,
    "",
    "The lead reviewer wrote the final review from both your findings and the discussion:",
    "",
    finalReviewText(input.final, input.review),
  ];
  if (input.final.objectionResponses?.length) {
    parts.push("", "The lead reviewer's answers to your objections:", ...input.final.objectionResponses.map((entry) => `- ${entry.objection}: ${indent(entry.response)}`));
  }
  parts.push(
    "",
    "Check it: does it keep every valid issue with a fair severity and location, drop only wrong or duplicate ones, and read well for the change's author?",
    "Call `submit_signoff` with agree=true when you accept it as a whole; otherwise agree=false and one objection per substantive problem (reference R# or the dropped comment's ID). Do not object to wording preferences or nits.",
  );
  return parts.join("\n");
}

export function nudgeFor(tool: string): string {
  return `You ended your turn without calling the \`${tool}\` tool. Call \`${tool}\` now with your result. Do not end your turn without calling it.`;
}
