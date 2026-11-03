import type { AgentRole, AuthorSubmission, RepoContext, ReviewComment, ReviewSubmission, StageKind, Task } from "../types.ts";
import { truncate } from "../util.ts";

/** Where an agent works: its own worktree, on its own branch (authors) or pinned to a commit (reviewers). */
export interface AgentEnvironment {
  worktree: string;
  branch: string | null;
  taskBranch: string;
  baseSha: string;
}

export interface DesignContext {
  path: string;
  content: string;
  approved: boolean;
  openComments: ReviewComment[];
}

const MAX_INLINE_DOC = 40_000;
export const MAX_INLINE_DIFF = 40_000;
const short = (sha: string) => sha.slice(0, 10);

function environmentBlock(role: AgentRole, env: AgentEnvironment): string {
  const reviewer = role === "code-reviewer" || role === "design-reviewer";
  const workspace = reviewer
    ? [
        `- Working directory: ${env.worktree}`,
        "  Your own read-only git worktree, pinned (detached HEAD) to the exact commit under review. Other agents work in their own worktrees and branches.",
      ]
    : [
        `- Working directory: ${env.worktree}`,
        `  A git worktree checked out on your own branch \`${env.branch}\`, created from the task branch \`${env.taskBranch}\` at its latest commit (the task started from base ${short(env.baseSha)}).`,
        "- The hub commits your changes after the round and fast-forwards the task branch. Never commit, push, switch branches, rebase or reset.",
      ];
  return [
    "Environment:",
    ...workspace,
    "- There is no human watching this conversation. Work autonomously; use the ask_user tool only if you are truly blocked by an ambiguity that changes the outcome, and otherwise state your assumptions.",
  ].join("\n");
}

function skillsLine(skills: string[]): string[] {
  if (!skills.length) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(" and ");
  return [
    `- Best practices: load the ${names} skill${skills.length > 1 ? "s" : ""} (skill tool) before you start and follow ${skills.length > 1 ? "them" : "it"}. Repository instructions, guides and repo skills take precedence where they differ; when the repository has no guidance, the skill is the standard.`,
  ];
}

export function systemPromptFor(role: AgentRole, env: AgentEnvironment, skills: string[] = []): string {
  const intro =
    "You are an autonomous sub-agent inside Copilot Agent Hub, an automated author <-> reviewer workflow. " +
    "The hub relays your structured results (via your submit tool) to the other agents, iteration by iteration, until the reviewer approves.";
  const header = (roleLine: string) => [intro, "", roleLine, "", environmentBlock(role, env), "", "Rules:"];
  switch (role) {
    case "designer":
      return [
        ...header(
          "ROLE: DESIGN AUTHOR. Write a clear, practical technical design document for the request, grounded in the actual repository, and revise it until the design reviewer approves.",
        ),
        "- Explore the repository first (structure, relevant code, conventions, existing design docs/ADRs and instruction files) so the design fits the existing architecture. Reference concrete files, modules and symbols.",
        "- Write the design as Markdown to the exact file path you are given. Do not create or modify any other files.",
        ...skillsLine(skills),
        "- When you receive review comments, address every comment ID: update the document (preferred) or decline with a concrete technical justification.",
        "- Finish EVERY round by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "design-reviewer":
      return [
        ...header("ROLE: DESIGN REVIEWER. Critically review the design document written by the design author."),
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects.",
        "- Verify the design against the request and the real codebase: check that referenced files, APIs and assumptions actually exist and hold.",
        ...skillsLine(skills),
        "- Each comment must be specific and actionable and point to the section (and file/symbol when relevant). Severities: blocker (wrong, unsafe or infeasible), major (significant gap), minor (worthwhile improvement), nit (polish).",
        "- Approve when no blocker or major issues remain. Do not withhold approval for nits or matters of taste.",
        "- On re-review, check each previous comment against the author's response, accept reasonable declines, and raise new issues only if they are significant. Do not repeat resolved comments.",
        "- Finish EVERY review by calling the `submit_review` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "coder":
      return [
        ...header(
          "ROLE: CODING AGENT. Implement the request with production-quality changes. A separate reviewer will review your work and a comment-resolver agent will address review feedback.",
        ),
        "- Work only inside the working directory. Follow the repository's conventions, architecture and instruction files.",
        ...skillsLine(skills),
        "- Make focused, complete changes. Add or update tests where the codebase has tests, and update directly related documentation.",
        "- Validate your work: run the relevant build, linters and tests (install dependencies if needed) and fix failures caused by your change. Report exactly what you ran and the results.",
        "- Do not leave temporary files, logs or build outputs in the tree unless they belong in the repository.",
        "- Finish by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "resolver":
      return [
        ...header(
          "ROLE: COMMENT-RESOLUTION AGENT. Another agent implemented the change; a reviewer requested changes. Resolve every open review comment in the code.",
        ),
        "- Start by understanding the change so far: read the diff against the base commit and the files the comments refer to.",
        ...skillsLine(skills),
        "- Address every comment ID: fix the code at the root cause (preferred) or decline with a concrete technical justification. Keep fixes focused; do not rewrite unrelated code.",
        "- Add or adjust tests for behavioral fixes, then re-run the relevant build and tests and report the results.",
        "- Finish every round by calling the `submit_work` tool exactly once, with a response for every open comment ID. Never end your turn without calling it.",
      ].join("\n");
    case "code-reviewer":
      return [
        ...header("ROLE: CODE REVIEWER. Review the change like a senior engineer reviewing a pull request."),
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects. Use file viewing/search tools and read-only git commands (git diff, git log, git show, git status).",
        `- Review the complete change against the base commit (git diff ${short(env.baseSha)}..HEAD) and the request (and the approved design when one is provided).`,
        ...skillsLine(skills),
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

/** Summarizes the repository guidance the hub discovered, so agents read it before working. */
export function contextBlock(context: RepoContext | undefined, role: AgentRole): string {
  if (!context) return "";
  const lines = ["", "## Repository context (discovered by the hub)"];
  const list = (items: string[], max = 12) => items.slice(0, max).map((item) => `\`${item}\``).join(", ") + (items.length > max ? `, … (${items.length - max} more)` : "");
  if (context.instructions.length) lines.push(`- Instruction files (loaded automatically; follow them): ${list(context.instructions)}`);
  if (context.guides.length) lines.push(`- Guides to read before starting (the relevant ones): ${list(context.guides)}`);
  if (context.designDocs.length) {
    lines.push(
      role === "designer" || role === "design-reviewer"
        ? `- Existing design docs/ADRs (follow their format, terminology and prior decisions): ${list(context.designDocs)}`
        : `- Existing design docs/ADRs (respect their decisions): ${list(context.designDocs)}`,
    );
  }
  if (context.skills.length) {
    lines.push("- Repository skills (load with the skill tool when relevant):");
    for (const skill of context.skills.slice(0, 15)) lines.push(`  - \`${skill.name}\`${skill.description ? ` - ${skill.description}` : ""}`);
  }
  if (context.stack.length) lines.push(`- Stack: ${context.stack.join(", ")}`);
  if (context.validation.length && role !== "designer" && role !== "design-reviewer") {
    lines.push(`- Validation commands detected: ${context.validation.map((command) => `\`${command}\``).join(", ")}`);
  }
  if (lines.length === 2) lines.push("- No repository-specific guidance was found. Follow the conventions visible in the code and the hub best-practice skill.");
  return lines.join("\n");
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
  role: AgentRole;
  stage: StageKind;
  round: number;
  docPath?: string;
  design?: DesignContext;
  context?: RepoContext;
  /** True for the first message of a new agent session (fresh context). */
  includeContext: boolean;
  /** True when resuming a task that already has work on the task branch. */
  resumed: boolean;
  review?: ReviewSubmission;
  openComments: ReviewComment[];
  /** For a fresh comment-resolution session: what the previous author did and the change so far. */
  previousWork?: { summary: string; stat: string; diff?: { text: string; truncated: boolean } };
}

export function authorPrompt(input: AuthorPromptInput): string {
  const parts: string[] = [];
  if (input.includeContext) {
    parts.push(requestBlock(input.task));
    const context = contextBlock(input.context, input.role);
    if (context) parts.push(context);
    if (input.stage === "coding" && input.design) parts.push(designBlock(input.design));
    if (input.previousWork) {
      parts.push("", "## Work so far", "", "Summary from the previous author round:", input.previousWork.summary.trim() || "(none)");
      if (input.previousWork.stat) parts.push("", "Change against the base commit (git diff --stat):", "```", input.previousWork.stat, "```");
      if (input.previousWork.diff?.text.trim()) {
        parts.push(
          "",
          `Diff against the base commit${input.previousWork.diff.truncated ? " (TRUNCATED - run git diff for the rest)" : ""}:`,
          "```diff",
          input.previousWork.diff.text,
          "```",
        );
      }
    } else if (input.resumed) {
      parts.push(
        "",
        "Note: this task is being resumed. Your branch already contains the work from earlier rounds (see `git log`). Continue from it rather than starting over.",
      );
    }
    parts.push("");
  }

  const ids = input.openComments.map((comment) => comment.id).join(", ");
  if (input.openComments.length) {
    parts.push(`## Round ${input.round}: resolve review comments`);
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
  role: AgentRole;
  stage: StageKind;
  round: number;
  includeContext: boolean;
  design?: DesignContext;
  context?: RepoContext;
  docPath?: string;
  docContent?: string;
  submission: AuthorSubmission;
  authorLabel: string;
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
    const context = contextBlock(input.context, input.role);
    if (context) parts.push(context);
    if (input.stage === "coding" && input.design) parts.push(designBlock(input.design));
    parts.push("");
  }
  parts.push(`## Round ${input.round}: review the ${input.authorLabel.toLowerCase()}'s submission`, "");
  parts.push(`Your worktree is now pinned to commit ${short(input.headSha)}.`, "");
  parts.push(`${input.authorLabel} summary:`, input.submission.summary.trim() || "(none)");
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
      `Base commit: ${short(input.baseSha)}  Commit under review: ${short(input.headSha)}${input.round > 1 ? `  Previous review at: ${short(input.prevSha)}` : ""}`,
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
