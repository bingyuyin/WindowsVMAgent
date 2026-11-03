import { docForPrompt } from "../docs.ts";
import {
  isDocStage,
  isReviewerRole,
  type AgentRole,
  type AuthorSubmission,
  type DocFormat,
  type RepoContext,
  type ReviewComment,
  type ReviewSubmission,
  type StageKind,
  type Task,
} from "../types.ts";
import { truncate } from "../util.ts";

/** Where an agent works: its own worktree, on its own branch (authors) or pinned to a commit (reviewers, executor, planner). */
export interface AgentEnvironment {
  worktree: string;
  branch: string | null;
  taskBranch: string;
  baseSha: string;
}

export interface DesignContext {
  path: string;
  format: DocFormat;
  content: string;
  approved: boolean;
  openComments: ReviewComment[];
}

const MAX_INLINE_DOC = 40_000;
export const MAX_INLINE_DIFF = 40_000;
const short = (sha: string) => sha.slice(0, 10);

function environmentBlock(role: AgentRole, env: AgentEnvironment): string {
  const workspace =
    role === "planner"
      ? [
          `- Working directory: ${env.worktree}`,
          `  A read-only checkout of the repository at the task's base commit ${short(env.baseSha)}. You plan; other agents do the work in their own worktrees and branches.`,
        ]
      : role === "executor"
        ? [
            `- Working directory: ${env.worktree}`,
            "  Your own git worktree, pinned (detached HEAD) to the exact commit under test. Run any setup, build and test commands here (installing dependencies and writing build/test output is fine), but never edit, create or delete source files - the test fixer does that on its own branch.",
          ]
        : isReviewerRole(role)
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

/** How document authors write in the configured format. */
function docAuthoringRules(format: DocFormat | undefined): string[] {
  if (format !== "html") {
    return ["- Write the document as GitHub-flavored Markdown; use headings, tables and ```mermaid diagrams where they help."];
  }
  return [
    "- The deliverable is a self-contained, light-themed HTML page. On the first round the hub pre-fills the file with its template: keep the template's <head>, <style> and page structure, replace every element marked with a `data-placeholder` attribute with real content (and remove the attribute), delete sections that do not apply and add sections where useful. The hub rejects the submission while placeholders remain.",
    "- The template is a menu, not a checklist: the request decides scope and length. When the request asks for a short or one-page document, keep only the essential sections and delete the rest.",
    "- Make it easy to scan: lead with the summary, then use the template components - `.callout` (`.tip`, `.warn`, `.risk`, `.decision`), `.cards` > `.card`, tables, `.badge`, `ol.steps`, `.pros-cons` and `dl.facts`.",
    '- Visualize architecture, data flow, sequences and states with Mermaid diagrams: `<figure class="diagram"><pre class="mermaid">flowchart LR ...</pre><figcaption>...</figcaption></figure>` (flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram-v2). Keep the diagram syntax valid and write `<` as `&lt;` inside diagram text. Prefer Mermaid over hand-drawn SVG.',
    "- Keep the light color scheme; do not add external stylesheets, fonts, images or scripts. The template's Mermaid loader (the `<script data-hub-mermaid>` at the end) is the one allowed script: keep it unchanged - it renders the diagrams when the file is opened directly, and the hub's viewer swaps it for a local copy.",
  ];
}

function docReviewRules(format: DocFormat | undefined): string[] {
  if (format !== "html") return [];
  return [
    "- The document is a light-themed HTML page that is rendered for the user. Also check its presentation: no leftover template placeholders, a clear structure (summary first, focused sections, tables), diagrams where they help with valid Mermaid syntax, and no external resources. Do not nitpick styling.",
    "- The template's Mermaid loader (`<script type=\"module\" data-hub-mermaid>`, importing Mermaid from a CDN) is an approved part of the hub template: it is expected, not an issue - do not comment on it or ask to remove it.",
  ];
}

export interface SystemPromptOptions {
  /** Format of the document a design/document agent writes or reviews. */
  docFormat?: DocFormat;
}

export function systemPromptFor(role: AgentRole, env: AgentEnvironment, skills: string[] = [], options: SystemPromptOptions = {}): string {
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
        "- Write the design to the exact file path you are given. Do not create or modify any other files.",
        ...docAuthoringRules(options.docFormat),
        ...skillsLine(skills),
        "- When you receive review comments, address every comment ID: update the document (preferred) or decline with a concrete technical justification.",
        "- Finish EVERY round by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "design-reviewer":
      return [
        ...header("ROLE: DESIGN REVIEWER. Critically review the design document written by the design author."),
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects.",
        "- Verify the design against the request and the real codebase: check that referenced files, APIs and assumptions actually exist and hold.",
        ...docReviewRules(options.docFormat),
        ...skillsLine(skills),
        "- Each comment must be specific and actionable and point to the section (and file/symbol when relevant). Severities: blocker (wrong, unsafe or infeasible), major (significant gap), minor (worthwhile improvement), nit (polish).",
        "- Approve when no blocker or major issues remain. Do not withhold approval for nits or matters of taste.",
        "- On re-review, check each previous comment against the author's response, accept reasonable declines, and raise new issues only if they are significant. Do not repeat resolved comments.",
        "- Finish EVERY review by calling the `submit_review` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "writer":
      return [
        ...header(
          "ROLE: TECHNICAL WRITER. Write clear, accurate documentation for the request, grounded in the actual repository, and revise it until the doc reviewer approves.",
        ),
        "- Explore the repository first (README, existing docs, relevant code, configuration and scripts) so every statement, command, path and API you document is accurate. Verify instead of guessing.",
        "- Write for the intended audience: purpose first, then task-oriented sections with short paragraphs, lists, tables, runnable examples and diagrams where they help.",
        "- Write the document to the exact file path you are given. Do not create or modify any other files.",
        ...docAuthoringRules(options.docFormat),
        ...skillsLine(skills),
        "- When you receive review comments, address every comment ID: update the document (preferred) or decline with a concrete justification.",
        "- Finish EVERY round by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "doc-reviewer":
      return [
        ...header("ROLE: DOCUMENTATION REVIEWER. Critically review the document written by the technical writer."),
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects.",
        "- Verify accuracy against the repository (commands, paths, APIs, configuration, behavior), completeness for the request and its audience, structure and clarity, and that examples are correct.",
        ...docReviewRules(options.docFormat),
        ...skillsLine(skills),
        "- Each comment must be specific and actionable and point to the section. Severities: blocker (wrong or misleading), major (significant gap or inaccuracy), minor (worthwhile improvement), nit (polish).",
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
    case "executor":
      return [
        ...header(
          "ROLE: TEST EXECUTOR AND VERIFIER. Run the requested test automation, verify the results independently, and triage every failure so the test fixer can fix it. After each fix round you run the automation again and verify that the fixes are legitimate.",
        ),
        "- Never edit, create or delete files (the hub rejects it) and never commit or switch commits. You run, observe and report; the test fixer changes code on its own branch.",
        "- Find the right commands: the request and the manager's assignment come first; otherwise use the repository's docs, package scripts, Makefile, test projects and CI pipelines. Do the setup the suite needs first (install dependencies, restore, build) and record every command you run.",
        "- Run the complete requested suite (not just previously failing tests) and wait for it to finish. Use a per-command timeout so a hung run cannot stall you; a hang is itself a failure to report.",
        "- Verify instead of trusting exit codes: read the runner's output, check that the expected tests were actually discovered and executed (zero tests run is a failure), and notice skipped/ignored tests, crashes, timeouts and errors outside test bodies.",
        "- For every failure record the full test name, file/line, the key error (assertion with expected vs actual, exception and the relevant stack lines) and a category: product-bug, test-bug, environment, flaky or integrity. Read the test and the code under test to suggest where the root cause most likely is.",
        "- Suspected flaky test: re-run just that test up to two times; report it as flaky only if the result changes.",
        "- After a fix round, inspect the fixer's diff: report an `integrity` failure for any change that makes tests pass without fixing the cause (deleted or skipped tests, weakened or removed assertions, swallowed exceptions, hard-coded results, expectations changed to match a bug) unless the fixer's justification is convincing.",
        "- status: passed only when everything requested ran and passed with no integrity problems; blocked when the automation cannot run at all (say exactly what is missing); failed otherwise.",
        ...skillsLine(skills),
        "- Finish EVERY run by calling the `submit_test_results` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "fixer":
      return [
        ...header(
          "ROLE: TEST FIXER. The test executor ran the test automation and reported failures, each with an ID. Fix every failure at its root cause; the executor then re-runs the automation and verifies your fixes.",
        ),
        "- Start from the evidence: read each failure's error, the failing test, the code under test and the request (and design, if any). Reproduce a failure locally before changing code when that is practical.",
        "- Decide what is wrong. Fix the product code when its behavior is wrong (product-bug). Change a test only when the test itself is wrong - an expectation that contradicts the specification, a brittle timing assumption, broken setup - and explain why in your response.",
        "- Never make tests pass by deleting or skipping them, weakening or removing assertions, catching and ignoring errors, or hard-coding results. The executor inspects your diff and reports such changes as integrity failures.",
        "- Keep fixes focused on the failures; follow the repository's conventions. Run the previously failing tests (and closely related ones) before submitting, and report exactly what you ran and the results in `validation`.",
        "- A failure you cannot fix in code (environment, missing credential or service): decline it with a precise description of what is needed.",
        ...skillsLine(skills),
        "- Finish every round by calling the `submit_work` tool exactly once, with a response for every failure ID. Never end your turn without calling it.",
      ].join("\n");
    case "planner":
      return [
        "You are the MANAGER of Copilot Agent Hub's team of sub-agents. You do not do the work yourself: you read the request, inspect the repository, decide which sub-agent teams to create, and write each team's assignment. The hub then creates the agents, relays their results and monitors them.",
        "",
        environmentBlock(role, env),
        "",
        "Sub-agent teams you can create (stages run in this order):",
        "- design: a designer writes a design document and a design reviewer critiques it until approved. Use when the request asks for a design, architecture or proposal, or when the implementation is large or ambiguous enough to need an agreed design first.",
        "- coding: a coder implements the change, a code reviewer reviews each commit, a comment resolver fixes review comments. Use when code, tests, scripts or configuration must change.",
        "- testing: a test executor runs the test automation and verifies the results, a test fixer fixes failures at the root cause, and the executor re-runs until everything passes. Use when the request asks to run, verify or fix tests or automation, and after coding when the repository has a test suite that can run locally (check for test files, scripts and CI pipelines).",
        "- document: a technical writer writes documentation and a doc reviewer checks it. Use when the request asks for documentation, guides, runbooks or READMEs.",
        "",
        "Rules:",
        "- You are read-only: never create, modify or delete files and never run commands with side effects. Inspect the repository with view/grep/glob and read-only git commands.",
        "- Choose the smallest set of stages that fully covers the request. Do not add design or documentation the request does not need; do add testing when the request asks to verify behavior or when code changes and runnable tests exist.",
        "- For each chosen stage write a concrete assignment: what to do, scope (files, areas), acceptance criteria, and for testing the exact commands or suites to run (verify they exist in the repository).",
        "- Be quick: a few minutes of targeted inspection is enough. Finish by calling the `submit_plan` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
  }
}

function requestBlock(task: Task): string {
  return [`# Task ${task.id}: ${task.title}`, "", "## Request", "", task.description.trim()].join("\n");
}

/** The manager's assignment for a stage (Auto tasks), shown to that stage's agents. */
function managerBlock(task: Task, stage: StageKind): string {
  const text = task.plan?.instructions[stage]?.trim();
  return text ? ["", "## Manager's assignment for this stage", "", text].join("\n") : "";
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
        ? `- Existing design docs/ADRs (follow their terminology and prior decisions): ${list(context.designDocs)}`
        : role === "writer" || role === "doc-reviewer"
          ? `- Existing design docs/ADRs (useful background; keep terminology consistent): ${list(context.designDocs)}`
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
  lines.push("", fenced(design.content, design.format));
  return lines.join("\n");
}

/** A document inlined in a prompt (HTML is reduced to its content). */
function fenced(content: string, format: DocFormat): string {
  return [`\`\`\`\`${format === "html" ? "html" : "markdown"}`, truncate(docForPrompt(content, format), MAX_INLINE_DOC), "````"].join("\n");
}

export function formatComments(comments: readonly ReviewComment[]): string {
  return comments
    .map((comment) => {
      const location = comment.file ? ` ${comment.file}${comment.line ? `:${comment.line}` : ""}` : "";
      if (comment.test) return `- [${comment.id}] (${comment.category ?? "unknown"}) ${comment.test}${location ? ` -${location}` : ""}\n  ${comment.body.trim().replace(/\n/g, "\n  ")}`;
      return `- [${comment.id}] (${comment.severity})${location} - ${comment.body.trim()}`;
    })
    .join("\n");
}

function formatResponses(comments: readonly ReviewComment[]): string {
  return comments
    .map((comment) => {
      const response = comment.status === "open" ? "no response" : `${comment.status}: ${comment.response ?? ""}`;
      const label = comment.test ? `(${comment.category ?? "unknown"}) ${comment.test}` : `(${comment.severity}) ${truncate(comment.body.trim(), 200)}`;
      return `- [${comment.id}] ${label}\n  -> ${response}`;
    })
    .join("\n");
}

export interface AuthorPromptInput {
  task: Task;
  role: AgentRole;
  stage: StageKind;
  round: number;
  docPath?: string;
  docFormat?: DocFormat;
  /** True when the hub pre-filled the document with its template this round. */
  seeded?: boolean;
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
    const assignment = managerBlock(input.task, input.stage);
    if (assignment) parts.push(assignment);
    if ((input.stage === "coding" || input.stage === "testing") && input.design) parts.push(designBlock(input.design));
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
  const docStage = isDocStage(input.stage);
  const noun = input.stage === "design" ? "design document" : "document";
  if (input.stage === "testing") {
    parts.push(`## Round ${input.round}: fix the test failures`);
    if (input.review) {
      const run = input.review.testRun;
      parts.push("", `Test executor's report: ${input.review.summary.trim()}`);
      if (run?.commands.length) parts.push("", "Commands the executor ran:", "```", ...run.commands, "```");
      if (run?.logExcerpt) parts.push("", "Output excerpt:", "```", truncate(run.logExcerpt, 6000), "```");
    }
    parts.push("", "Failures to fix:", formatComments(input.openComments), "");
    parts.push(
      "Fix each failure at its root cause, then run the failing tests (and closely related ones) to confirm.",
      `Then call \`submit_work\` with a summary, the commands you ran and their results in \`validation\`, and \`comment_responses\` covering exactly these IDs: ${ids} (addressed = fixed; declined = cannot be fixed in code, with the reason).`,
    );
  } else if (input.openComments.length) {
    parts.push(`## Round ${input.round}: resolve review comments`);
    if (input.review) parts.push("", `Reviewer summary: ${input.review.summary.trim()}`);
    parts.push("", "Open comments:", formatComments(input.openComments), "");
    parts.push(
      docStage
        ? `Update the ${noun} \`${input.docPath}\` to address every comment.`
        : "Address every comment in the code, then re-run the relevant validation.",
      `Then call \`submit_work\` with a summary, ${input.stage === "coding" ? "the validation you ran, " : ""}and \`comment_responses\` covering exactly these IDs: ${ids}.`,
    );
  } else if (docStage) {
    parts.push(`## Round ${input.round}: write the ${noun}`, "");
    if (input.docFormat === "html" && input.seeded) {
      parts.push(
        `The hub created \`${input.docPath}\` (relative to the working directory) from its light-themed HTML template. Fill it in: replace every \`data-placeholder\` element with real content, delete the sections the request does not need (respect any length limit in the request) and add any that are missing. Use Mermaid diagrams for structure and flows.`,
      );
    } else if (input.docFormat === "html") {
      parts.push(`Write the ${noun} as a self-contained, light-themed HTML page at \`${input.docPath}\` (relative to the working directory; the file already exists - continue from it).`);
    } else {
      parts.push(`Write the ${noun} as Markdown to \`${input.docPath}\` (relative to the working directory; its folder already exists).`);
    }
    parts.push(`When it is complete, call \`submit_work\` with a short summary of the ${input.stage === "design" ? "design" : "document"}.`);
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
  docFormat?: DocFormat;
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
    const assignment = managerBlock(input.task, input.stage);
    if (assignment) parts.push(assignment);
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

  if (isDocStage(input.stage)) {
    const format = input.docFormat ?? "markdown";
    parts.push("", `${input.stage === "design" ? "Design document" : "Document"}: \`${input.docPath}\`${format === "html" ? " (light-themed HTML page; the user sees it rendered)" : ""}`);
    if (input.round > 1 && input.roundDiff?.text.trim()) {
      parts.push("", `Changes since your last review (git diff ${short(input.prevSha)}..${short(input.headSha)}):`, "```diff", input.roundDiff.text, "```");
    }
    if (input.docContent) {
      parts.push("", `Current document${format === "html" ? " (styles and scripts omitted; the full file is in your worktree)" : ""}:`, fenced(input.docContent, format));
    }
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

export interface ExecutionPromptInput {
  task: Task;
  round: number;
  includeContext: boolean;
  design?: DesignContext;
  context?: RepoContext;
  baseSha: string;
  headSha: string;
  /** Change on the task branch so far (git diff --stat base..head), e.g. from an earlier coding stage. */
  totalStat: string;
  /** The fix round being verified (absent for the initial run). */
  fix?: AuthorSubmission;
  /** The fixer's changes since the previous run. */
  fixDiff?: { text: string; truncated: boolean };
  previousRun?: ReviewSubmission;
}

export function executionPrompt(input: ExecutionPromptInput): string {
  const parts: string[] = [];
  if (input.includeContext) {
    parts.push(requestBlock(input.task));
    const context = contextBlock(input.context, "executor");
    if (context) parts.push(context);
    const assignment = managerBlock(input.task, "testing");
    if (assignment) parts.push(assignment);
    if (input.design) parts.push(designBlock(input.design));
    parts.push("");
  }
  const commit = `Your worktree is pinned to commit ${short(input.headSha)} (base ${short(input.baseSha)}).`;
  if (!input.fix) {
    parts.push(`## Run ${input.round}: run the test automation and verify the results`, "", commit);
    if (input.totalStat) parts.push("", "Changes on the task branch under test (git diff --stat base..HEAD):", "```", input.totalStat, "```");
    parts.push(
      "",
      "Run the test automation the request asks for (set it up first if needed), verify the results and triage every failure.",
      "Then call `submit_test_results` with the status, the exact commands, the counts and one entry per failure.",
    );
    return parts.join("\n");
  }
  parts.push(`## Run ${input.round}: verify the test fixer's fixes`, "", commit, "", "Test fixer's summary:", input.fix.summary.trim() || "(none)");
  if (input.fix.validation?.trim()) parts.push("", "Validation the fixer reported:", input.fix.validation.trim());
  if (input.previousRun?.comments.length) {
    parts.push("", "Failures from your previous run and the fixer's responses:", formatResponses(input.previousRun.comments));
  }
  if (input.fix.commit && input.fixDiff?.text.trim()) {
    parts.push(
      "",
      `The fixer's changes (git diff ${short(input.fix.prevCommit ?? input.baseSha)}..${short(input.headSha)})${input.fixDiff.truncated ? " - TRUNCATED, run git diff yourself for the rest" : ""}:`,
      "```diff",
      input.fixDiff.text,
      "```",
    );
  } else if (!input.fix.commit) {
    parts.push("", "The fixer made no file changes in this round.");
  }
  parts.push(
    "",
    "Run the complete requested automation again (not only the previously failing tests) and verify the results.",
    "Check the fixer's diff for integrity problems (deleted/skipped tests, weakened assertions, swallowed errors, hard-coded results) and report each as an `integrity` failure.",
    "Then call `submit_test_results` with the status, the exact commands, the counts and one entry per remaining failure.",
  );
  return parts.join("\n");
}

export function plannerPrompt(task: Task, context: RepoContext | undefined): string {
  return [
    requestBlock(task),
    contextBlock(context, "planner"),
    "",
    "## Plan this task",
    "",
    "Inspect the repository as much as you need to understand what the request involves (structure, relevant code, how it is built and tested).",
    "Then call `submit_plan` with the stages to run, your rationale, and a concrete assignment for each stage's agents.",
  ].join("\n");
}

export const NUDGE_WORK =
  "You ended your turn without calling the `submit_work` tool. If the round's work is not finished, finish it now. " +
  "Then call `submit_work` (with a response for every open comment ID). Do not end your turn without calling it.";

export const NUDGE_REVIEW =
  "You ended your turn without calling the `submit_review` tool. Call `submit_review` now with your verdict, summary and comments. " +
  "Do not end your turn without calling it.";

export const NUDGE_TEST =
  "You ended your turn without calling the `submit_test_results` tool. If the run is not finished, finish it now. " +
  "Then call `submit_test_results` with the status, the commands you ran, the counts and the failures. Do not end your turn without calling it.";

export const NUDGE_PLAN =
  "You ended your turn without calling the `submit_plan` tool. Call `submit_plan` now with the stages, your rationale and an assignment for each stage. " +
  "Do not end your turn without calling it.";
