import type { AgentRole, AuthorSubmission, ReviewComment, ReviewSubmission, StageKind, Task } from "../types.ts";
import { truncate } from "../util.ts";

export interface WorkspaceInfo {
  worktree: string;
  branch: string;
  baseSha: string;
}

export interface DesignContext {
  path: string;
  content: string;
  approved: boolean;
  openComments: ReviewComment[];
}

const MAX_INLINE_DOC = 40_000;
const short = (sha: string) => sha.slice(0, 10);

function environmentBlock(ws: WorkspaceInfo): string {
  return [
    "Environment:",
    `- Working directory: ${ws.worktree}`,
    `  It is a dedicated git worktree on branch \`${ws.branch}\`, created from base commit ${short(ws.baseSha)}.`,
    "- The hub commits the working tree after every author round. Never commit, push, switch branches, rebase or reset.",
    "- There is no human watching this conversation. Work autonomously; use the ask_user tool only if you are truly blocked by an ambiguity that changes the outcome, and otherwise state your assumptions.",
  ].join("\n");
}

export function systemPromptFor(role: AgentRole, ws: WorkspaceInfo): string {
  const intro =
    "You are an autonomous agent inside Copilot Agent Hub, an automated author <-> reviewer workflow. " +
    "The hub relays your structured results (via the submit tool) to the other agent, iteration by iteration, until the reviewer approves.";
  switch (role) {
    case "designer":
      return [
        intro,
        "",
        "ROLE: DESIGN AUTHOR. Write a clear, practical technical design document for the request, grounded in the actual repository.",
        "",
        environmentBlock(ws),
        "",
        "Rules:",
        "- Explore the repository first (structure, relevant code, conventions, existing docs and instruction files) so the design fits the existing architecture. Reference concrete files, modules and symbols.",
        "- Write the design as Markdown to the exact file path you are given. Do not create or modify any other files.",
        "- Suggested outline: Title; Summary; Context and problem; Goals and non-goals; Current state (with file references); Proposed design (components, data flow, interfaces/APIs, data model, error handling); Alternatives considered; Risks and mitigations; Testing and validation plan; Implementation plan (ordered steps); Open questions.",
        "- When you receive review comments, address every comment ID: update the document (preferred) or decline with a concrete technical justification.",
        "- Finish EVERY round by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "design-reviewer":
      return [
        intro,
        "",
        "ROLE: DESIGN REVIEWER. Critically review the design document written by the author agent.",
        "",
        environmentBlock(ws),
        "",
        "Rules:",
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects.",
        "- Verify the design against the request and the real codebase: check that referenced files, APIs and assumptions actually exist and hold.",
        "- Evaluate correctness, completeness against the request, feasibility, fit with existing architecture and conventions, edge cases and failure modes, security, performance, testability, clarity, and whether the implementation plan is actionable.",
        "- Each comment must be specific and actionable and point to the section (and file/symbol when relevant). Severities: blocker (wrong, unsafe or infeasible), major (significant gap), minor (worthwhile improvement), nit (polish).",
        "- Approve when no blocker or major issues remain. Do not withhold approval for nits or matters of taste.",
        "- On re-review, check each previous comment against the author's response, accept reasonable declines, and raise new issues only if they are significant. Do not repeat resolved comments.",
        "- Finish EVERY review by calling the `submit_review` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "coder":
      return [
        intro,
        "",
        "ROLE: CODING AUTHOR. Implement the request in the working directory with production-quality changes.",
        "",
        environmentBlock(ws),
        "",
        "Rules:",
        "- Work only inside the working directory. Follow the repository's conventions, architecture and instruction files (AGENTS.md, .github/copilot-instructions.md, CONTRIBUTING, etc.).",
        "- Make focused, complete changes. Add or update tests where the codebase has tests, and update directly related documentation.",
        "- Validate your work: run the relevant build, linters and tests (install dependencies if needed) and fix failures caused by your change. Report exactly what you ran and the results.",
        "- Do not leave temporary files, logs or build outputs in the tree unless they belong in the repository.",
        "- When you receive review comments, address every comment ID: fix the code (preferred) or decline with a concrete technical justification, then re-validate.",
        "- Finish EVERY round by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "code-reviewer":
      return [
        intro,
        "",
        "ROLE: CODE REVIEWER. Review the author agent's change like a senior engineer reviewing a pull request.",
        "",
        environmentBlock(ws),
        "",
        "Rules:",
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects. Use file viewing/search tools and read-only git commands (git diff, git log, git show, git status).",
        `- Review the complete change against the base commit (git diff ${short(ws.baseSha)}..HEAD) and the request (and the approved design when one is provided).`,
        "- Look for bugs and logic errors, unhandled edge cases, error handling, security issues, concurrency problems, performance problems, missing or weak tests, broken builds, unintended API/contract changes, deviations from repository conventions, missing docs, and incomplete implementation of the request.",
        "- Do not comment on pure formatting or style unless it violates repository conventions. Prefer a few high-signal comments over many trivial ones.",
        "- Each comment: file and line when applicable, a clear description of the problem and the expected fix. Severities: blocker, major, minor, nit.",
        "- Approve when no blocker or major issues remain.",
        "- On re-review, verify each previous comment was addressed by inspecting the new changes, accept reasonable declines, and raise new issues only if they are significant.",
        "- Finish EVERY review by calling the `submit_review` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
  }
}

function requestBlock(task: Task): string {
  return [`# Task ${task.id}: ${task.title}`, "", "## Request", "", task.description.trim()].join("\n");
}

function designBlock(design: DesignContext): string {
  const lines = [
    "",
    `## ${design.approved ? "Approved design" : "Design (latest version, not fully approved)"}`,
    "",
    `The design document is committed at \`${design.path}\`. Implement it; if you must deviate, explain why in your summary.`,
  ];
  if (design.openComments.length) {
    lines.push("", "Design review comments that were still open when the design stage ended (use judgment):", formatComments(design.openComments));
  }
  lines.push("", "````markdown", truncate(design.content, MAX_INLINE_DOC), "````");
  return lines.join("\n");
}

export function formatComments(comments: readonly ReviewComment[]): string {
  return comments
    .map((comment) => {
      const location = comment.file ? ` ${comment.file}${comment.line ? `:${comment.line}` : ""}` : "";
      return `- [${comment.id}] (${comment.severity})${location} - ${comment.body.trim()}`;
    })
    .join("\n");
}

function formatResponses(comments: readonly ReviewComment[]): string {
  return comments
    .map((comment) => {
      const response = comment.status === "open" ? "no response" : `${comment.status}: ${comment.response ?? ""}`;
      return `- [${comment.id}] (${comment.severity}) ${truncate(comment.body.trim(), 200)}\n  -> ${response}`;
    })
    .join("\n");
}

export interface AuthorPromptInput {
  task: Task;
  stage: StageKind;
  round: number;
  docPath?: string;
  design?: DesignContext;
  /** True when this is the first message of a new author session (fresh context). */
  includeContext: boolean;
  /** True when resuming a task that already has work in the worktree. */
  resumed: boolean;
  review?: ReviewSubmission;
  openComments: ReviewComment[];
}

export function authorPrompt(input: AuthorPromptInput): string {
  const parts: string[] = [];
  if (input.includeContext) {
    parts.push(requestBlock(input.task));
    if (input.stage === "coding" && input.design) parts.push(designBlock(input.design));
    if (input.resumed) {
      parts.push(
        "",
        "Note: this task is being resumed. The working directory already contains work from earlier rounds (see `git log` and `git status`). Continue from it rather than starting over.",
      );
    }
    parts.push("");
  }

  const ids = input.openComments.map((comment) => comment.id).join(", ");
  if (input.openComments.length) {
    parts.push(`## Round ${input.round}: address review comments`);
    if (input.review) parts.push("", `Reviewer summary: ${input.review.summary.trim()}`);
    parts.push("", "Open comments:", formatComments(input.openComments), "");
    parts.push(
      input.stage === "design"
        ? `Update the design document \`${input.docPath}\` to address every comment.`
        : "Address every comment in the code, then re-run the relevant validation.",
      `Then call \`submit_work\` with a summary, ${input.stage === "coding" ? "the validation you ran, " : ""}and \`comment_responses\` covering exactly these IDs: ${ids}.`,
    );
  } else if (input.stage === "design") {
    parts.push(
      `## Round ${input.round}: write the design`,
      "",
      `Write the design document to \`${input.docPath}\` (relative to the working directory; its folder already exists).`,
      "When it is complete, call `submit_work` with a short summary of the design.",
    );
  } else {
    parts.push(
      `## Round ${input.round}: implement`,
      "",
      "Implement the request in the working directory and validate it with the relevant build/tests.",
      "When done, call `submit_work` with a summary of the change and the validation you ran.",
    );
  }
  return parts.join("\n");
}

export interface ReviewPromptInput {
  task: Task;
  stage: StageKind;
  round: number;
  includeContext: boolean;
  design?: DesignContext;
  docPath?: string;
  docContent?: string;
  submission: AuthorSubmission;
  baseSha: string;
  prevSha: string;
  headSha: string;
  totalStat: string;
  roundDiff?: { text: string; truncated: boolean };
  previousComments: ReviewComment[];
}

export function reviewPrompt(input: ReviewPromptInput): string {
  const parts: string[] = [];
  if (input.includeContext) {
    parts.push(requestBlock(input.task));
    if (input.stage === "coding" && input.design) parts.push(designBlock(input.design));
    parts.push("");
  }
  parts.push(`## Round ${input.round}: review the author's submission`, "");
  parts.push("Author summary:", input.submission.summary.trim() || "(none)");
  if (input.submission.validation?.trim()) parts.push("", "Validation reported by the author:", input.submission.validation.trim());

  if (input.previousComments.length) {
    parts.push("", "Your previous comments and the author's responses:", formatResponses(input.previousComments));
  }

  if (input.stage === "design") {
    parts.push("", `Design document: \`${input.docPath}\``);
    if (input.round > 1 && input.roundDiff?.text.trim()) {
      parts.push("", `Changes since your last review (git diff ${short(input.prevSha)}..${short(input.headSha)}):`, "```diff", input.roundDiff.text, "```");
    }
    if (input.docContent) parts.push("", "Current document:", "````markdown", truncate(input.docContent, MAX_INLINE_DOC), "````");
  } else {
    parts.push(
      "",
      `Base commit: ${short(input.baseSha)}  Current HEAD: ${short(input.headSha)}${input.round > 1 ? `  Previous review at: ${short(input.prevSha)}` : ""}`,
      "",
      "Overall change (git diff --stat base..HEAD):",
      "```",
      input.totalStat || "(no changes)",
      "```",
    );
    if (input.roundDiff?.text.trim()) {
      const label = input.round > 1 ? "Changes in this round" : "Full diff";
      parts.push(
        "",
        `${label} (git diff ${short(input.prevSha)}..${short(input.headSha)})${input.roundDiff.truncated ? " - TRUNCATED, run git diff yourself for the rest" : ""}:`,
        "```diff",
        input.roundDiff.text,
        "```",
      );
    } else {
      parts.push("", `Inspect the change with: git diff ${short(input.prevSha)}..HEAD`);
    }
  }
  parts.push("", "Review now and call `submit_review` with your verdict, summary and comments.");
  return parts.join("\n");
}

export const NUDGE_WORK =
  "You ended your turn without calling the `submit_work` tool. If the round's work is not finished, finish it now. " +
  "Then call `submit_work` (with a response for every open comment ID). Do not end your turn without calling it.";

export const NUDGE_REVIEW =
  "You ended your turn without calling the `submit_review` tool. Call `submit_review` now with your verdict, summary and comments. " +
  "Do not end your turn without calling it.";
