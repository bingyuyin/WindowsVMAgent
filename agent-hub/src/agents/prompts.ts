import { isAutoLoadedInstruction } from "../context.ts";
import { docForPrompt } from "../docs.ts";
import {
  isDocStage,
  isReviewerRole,
  ROLE_LABELS,
  worksDetached,
  type AgentRole,
  type AuthorSubmission,
  type DocFormat,
  type RepoContext,
  type ReviewComment,
  type ReviewSubmission,
  type StageKind,
  type Task,
  type UnitTestCheck,
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
    "- The manager monitors your activity and interrupts or restarts an agent that stops making progress. Run commands non-interactively and with timeouts, and never leave servers, watchers or interactive prompts running in the foreground.",
    ...(isReviewerRole(role) || role === "planner" ? [] : [ISOLATION]),
  ].join("\n");
}

/** Other tasks share the machine (and sometimes the repository, in their own worktrees). */
const ISOLATION =
  "- Other tasks run on this machine at the same time, some on this repository in their own worktrees, so keep your work inside your working directory: install dependencies locally (node_modules, a `.venv` virtual environment in the working directory for Python, a local dotnet tool manifest), never globally; make tests use ephemeral ports and unique temp paths rather than fixed ones or shared databases; and stop every background process you start before you submit.";

function skillsLine(skills: string[]): string[] {
  if (!skills.length) return [];
  const names = skills.map((skill) => `\`${skill}\``);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return [
    `- Best practices: load the ${list} skill${skills.length > 1 ? "s" : ""} (skill tool) before you start and follow ${skills.length > 1 ? "them" : "it"}. Repository instructions, guides and repo skills take precedence where they differ; when the repository has no guidance, the skill is the standard.`,
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

/** Rules for change requests the user makes after a task finished (comment IDs U1, U2, ...). */
const USER_REQUESTS_AUTHOR =
  "- Change requests from the user (IDs U1, U2, ...) take priority over earlier review preferences: carry them out as asked, declining only when a request is impossible or harmful (explain why).";
const USER_REQUESTS_REVIEWER =
  "- Change requests the user made after the task finished (IDs U1, U2, ...) must be carried out as asked: verify each one, and accept a decline only when the request is impossible or harmful and the author explains why.";

/** How coding agents finish a round: their unit tests must pass, and the manager re-runs them before the review. */
const UNIT_TEST_GATE =
  "Run the unit tests that cover your change and iterate until they pass, then report them in `unit_tests` (status and the exact commands): the manager re-runs those commands before the review and sends any failure back to you. Failing tests unrelated to your change are not yours to fix: list them in `unit_tests.unrelated_failures`.";

/** Coding agents change only what the request needs; failing tests it has nothing to do with belong to their owners. */
const STAY_IN_SCOPE = [
  "- Stay within the request: change only the code, tests and docs it needs. Do not refactor, reformat, rename or tidy up unrelated code, and do not touch unrelated tests.",
  "- A failing test that has nothing to do with your change is not yours to fix: it fails without your change too, or it is flaky, in code and tests you did not touch. Do not fix, skip, delete or keep re-running it. Leave it for its owners, list it in `unit_tests.unrelated_failures` with the reason, and report commands that cover your change without it (a test file, project or filter).",
];

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
        USER_REQUESTS_AUTHOR,
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
        USER_REQUESTS_REVIEWER,
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
        USER_REQUESTS_AUTHOR,
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
        USER_REQUESTS_REVIEWER,
        "- Finish EVERY review by calling the `submit_review` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "coder":
      return [
        ...header(
          "ROLE: CODING AGENT. Implement the request with production-quality changes. A separate reviewer will review your work and a comment-resolver agent will address review feedback.",
        ),
        "- Work only inside the working directory. Follow the repository's conventions, architecture and instruction files.",
        ...skillsLine(skills),
        "- Make focused, complete changes and update directly related documentation.",
        ...STAY_IN_SCOPE,
        "- Unit tests are part of the change: add or update unit tests for the new or changed behavior (main path, edge cases, failure modes) with the repository's test framework and conventions.",
        "- Before submitting, run the build, linters and unit tests (install dependencies if needed) and fix every failure your change causes until the tests that cover it pass. Report the exact unit test commands in `unit_tests`: the manager re-runs them before the review and sends failures back to you, so a round only reaches the reviewer with passing tests.",
        "- Do not leave temporary files, logs or build outputs in the tree unless they belong in the repository.",
        "- Finish by calling the `submit_work` tool exactly once. Never end your turn without calling it.",
      ].join("\n");
    case "resolver":
      return [
        ...header(
          "ROLE: COMMENT-RESOLUTION AGENT. Another agent implemented the change; a reviewer (or the user, after the task finished) requested changes. Resolve every open comment in the code.",
        ),
        "- Start by understanding the change so far: read the diff against the base commit and the files the comments refer to.",
        ...skillsLine(skills),
        "- Address every comment ID: fix the code at the root cause (preferred) or decline with a concrete technical justification. Keep fixes focused; do not rewrite unrelated code.",
        ...STAY_IN_SCOPE,
        USER_REQUESTS_AUTHOR,
        "- Add or adjust unit tests for behavioral fixes, then run the build and the unit tests again until the tests that cover the change pass, and report them in `unit_tests` (the manager re-runs them before the next review).",
        "- Finish every round by calling the `submit_work` tool exactly once, with a response for every open comment ID. Never end your turn without calling it.",
      ].join("\n");
    case "code-reviewer":
      return [
        ...header("ROLE: CODE REVIEWER. Review the change like a senior engineer reviewing a pull request."),
        "- You are strictly read-only: never create, modify or delete files and never run commands with side effects. Use file viewing/search tools and read-only git commands (git diff, git log, git show, git status).",
        `- Review the complete change against the base commit (git diff ${short(env.baseSha)}..HEAD) and the request (and the approved design when one is provided).`,
        ...skillsLine(skills),
        "- Do not comment on pure formatting or style unless it violates repository conventions. Prefer a few high-signal comments over many trivial ones.",
        "- The manager re-runs the author's unit tests before every review and tells you the result. Check that the change (and the fixes for your comments) is covered by meaningful unit tests, and request them where they are missing. Never approve while the unit tests fail.",
        "- Review the requested change only. Do not ask for changes to unrelated code, and do not ask the author to fix failing or flaky tests unrelated to the change (the author lists them as unrelated failures) unless the change actually causes them. Do flag edits outside the request (unrelated refactoring or reformatting, changed or skipped unrelated tests) and ask to revert them.",
        "- Each comment: file and line when applicable, a clear description of the problem and the expected fix. Severities: blocker, major, minor, nit.",
        "- Approve when no blocker or major issues remain.",
        "- On re-review, verify each previous comment was addressed by inspecting the new changes, accept reasonable declines, and raise new issues only if they are significant.",
        USER_REQUESTS_REVIEWER,
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
        `- Failures the requested change has nothing to do with - they fail without it too, or they are flaky, in code and tests the change does not touch (compare with git diff ${short(env.baseSha)}..HEAD) - go in \`unrelated_failures\` with the reason, not in \`failures\`: they are reported to the user and left for their owners, so the fixer does not change unrelated code. When the request itself is to run and fix the tests, every failure in the requested tests is related.`,
        "- After a fix round, inspect the fixer's diff: report an `integrity` failure for any change that makes tests pass without fixing the cause (deleted or skipped tests, weakened or removed assertions, swallowed exceptions, hard-coded results, expectations changed to match a bug) unless the fixer's justification is convincing.",
        "- When the user requested changes after the task finished (IDs U1, U2, ...), verify they were carried out; changes the user explicitly asked for are not integrity problems.",
        "- status: passed when everything requested ran and no failure related to the request and no integrity problem remains (unrelated failures may be listed); blocked when the automation cannot run at all (say exactly what is missing); failed otherwise.",
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
        "- Fix only the listed failures, following the repository's conventions; do not change unrelated code or tests, even ones that fail. Run the previously failing tests (and closely related ones) before submitting, and report exactly what you ran and the results in `validation`.",
        "- A failure you cannot fix in code (environment, missing credential or service): decline it with a precise description of what is needed.",
        USER_REQUESTS_AUTHOR,
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
        "- For each chosen stage write a concrete assignment: what to do, scope (files, areas), acceptance criteria, for coding the unit test commands that cover the change and must pass before each review, and for testing the exact commands or suites to run (verify they exist in the repository).",
        "- Write a `briefing` that every sub-agent starts with, so none of them has to rediscover the repository: the architecture and the modules/files relevant to this request, the conventions to follow, how to build and test (commands you verified), and pitfalls. Make it specific to this request; the agents already get the repository context and best-practice skills.",
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

/** What the manager learned about the repository while planning (Auto tasks), given to every sub-agent. */
function briefingBlock(task: Task): string {
  const text = task.plan?.briefing?.trim();
  return text ? ["", "## Manager's briefing on the repository", "", text].join("\n") : "";
}

/** Summarizes the repository guidance the hub discovered, so agents read it before working. */
export function contextBlock(context: RepoContext | undefined, role: AgentRole): string {
  if (!context) return "";
  const lines = ["", "## Repository context (discovered by the hub)"];
  const list = (items: string[], max = 12) => items.slice(0, max).map((item) => `\`${item}\``).join(", ") + (items.length > max ? `, … (${items.length - max} more)` : "");
  const loaded = context.instructions.filter(isAutoLoadedInstruction);
  const unloaded = context.instructions.filter((file) => !isAutoLoadedInstruction(file));
  if (loaded.length) lines.push(`- Instruction files (loaded automatically; follow them): ${list(loaded)}`);
  if (unloaded.length) lines.push(`- More instruction files (not loaded automatically; read the ones that apply, such as those for the folders you work in, and follow them): ${list(unloaded)}`);
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

function formatResponses(comments: readonly ReviewComment[], userRequests = false): string {
  return comments
    .map((comment) => {
      const response = comment.status === "open" ? "no response" : `${comment.status}: ${comment.response ?? ""}`;
      const label = userRequests
        ? `(change request) ${truncate(comment.body.trim(), 2000).replace(/\n/g, "\n  ")}`
        : comment.test
          ? `(${comment.category ?? "unknown"}) ${comment.test}`
          : `(${comment.severity}) ${truncate(comment.body.trim(), 200)}`;
      return `- [${comment.id}] ${label}\n  -> ${response}`;
    })
    .join("\n");
}

/** The user's change requests, in full. */
function formatRequests(comments: readonly ReviewComment[]): string {
  return comments.map((comment) => `- [${comment.id}] ${comment.body.trim().replace(/\n/g, "\n  ")}`).join("\n");
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
    const briefing = briefingBlock(input.task);
    if (briefing) parts.push(briefing);
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
  if (input.review?.by === "user" && input.openComments.length) {
    parts.push(
      `## Round ${input.round}: make the changes the user requested`,
      "",
      "This task was finished earlier. The user reviewed the result and asked for the changes below. They take priority over earlier review preferences; keep the rest of the work intact.",
      "",
      "Change requests:",
      formatRequests(input.openComments),
      "",
      input.stage === "testing"
        ? "Make the changes, then run the test automation (at least the affected tests) to confirm it passes."
        : docStage
          ? `Update the ${noun} \`${input.docPath}\` accordingly.`
          : `Make the changes in the code and add or update unit tests for them. ${UNIT_TEST_GATE}`,
      `Then call \`submit_work\` with a summary, ${docStage ? "" : input.stage === "coding" ? "the validation you ran, `unit_tests` " : "the validation you ran, "}and \`comment_responses\` covering exactly these IDs: ${ids} (addressed = done; declined only when a request is impossible or harmful, with the reason).`,
    );
  } else if (input.stage === "testing") {
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
        : `Address every comment in the code, adding or adjusting unit tests for behavioral fixes. ${UNIT_TEST_GATE}`,
      `Then call \`submit_work\` with a summary, ${input.stage === "coding" ? "the validation you ran, `unit_tests`, " : ""}and \`comment_responses\` covering exactly these IDs: ${ids}.`,
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
      `Implement the request in the working directory, with unit tests for the new or changed behavior. ${UNIT_TEST_GATE}`,
      "When done, call `submit_work` with a summary of the change, the validation you ran and `unit_tests`.",
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
  /** The previous comments are the user's change requests (not this reviewer's own comments). */
  userRequests?: boolean;
}

export function reviewPrompt(input: ReviewPromptInput): string {
  const parts: string[] = [];
  if (input.includeContext) {
    parts.push(requestBlock(input.task));
    const context = contextBlock(input.context, input.role);
    if (context) parts.push(context);
    const briefing = briefingBlock(input.task);
    if (briefing) parts.push(briefing);
    const assignment = managerBlock(input.task, input.stage);
    if (assignment) parts.push(assignment);
    if (input.stage === "coding" && input.design) parts.push(designBlock(input.design));
    parts.push("");
  }
  parts.push(`## Round ${input.round}: review the ${input.authorLabel.toLowerCase()}'s submission`, "");
  parts.push(`Your worktree is now pinned to commit ${short(input.headSha)}.`, "");
  parts.push(`${input.authorLabel} summary:`, input.submission.summary.trim() || "(none)");
  if (input.submission.validation?.trim()) parts.push("", "Validation reported by the author:", input.submission.validation.trim());
  if (input.submission.unitTests) parts.push("", unitTestsBlock(input.submission.unitTests));

  if (input.previousComments.length && input.userRequests) {
    parts.push(
      "",
      "After the task was finished, the user asked for the changes below. Verify each one was carried out as asked (accept a decline only when the request is impossible or harmful and the author explains why), then review this round's changes as usual:",
      formatResponses(input.previousComments, true),
    );
  } else if (input.previousComments.length) {
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

/** The unit-test result the reviewer gets with a coding round. */
function unitTestsBlock(check: UnitTestCheck): string {
  const commands = check.commands.map((command) => `\`${command}\``).join(", ");
  const counts = check.total !== undefined ? ` (the author reported ${check.total} tests${check.failed ? `, ${check.failed} failed` : ""})` : "";
  const notes = [
    ...(check.flaky?.length ? [`Flaky: ${check.flaky.map((command) => `\`${command}\``).join(", ")} failed once and passed when the manager ran it again.`] : []),
    ...(check.unrelatedFailures?.length
      ? [
          "Failing tests the author reports as unrelated to the change (left for their owners, not part of this task; request changes only if the change actually causes one):",
          ...check.unrelatedFailures.map((failure) => `- ${failure.test}: ${failure.reason}`),
        ]
      : []),
  ];
  switch (check.status) {
    case "passed":
      return [`Unit tests: all pass. The manager re-ran ${commands} in the author's worktree before this review${counts}.`, ...notes].join("\n");
    case "blocked":
      return [
        `Unit tests: NOT PASSING - the author reports they cannot run or pass: ${check.reason ?? "(no reason given)"}`,
        "Check that reason against the code (and the base commit when it claims pre-existing failures). Request changes with a blocker comment if the tests should be able to pass.",
        ...notes,
      ].join("\n");
    default:
      return [
        check.commands.length
          ? `Unit tests: FAILING - the manager's run of ${commands} still failed after ${check.fixAttempts} fix attempt(s)${check.exitCode !== undefined && check.exitCode !== null ? ` (exit code ${check.exitCode})` : check.stopped ? ` (stopped: ${check.stopped})` : ""}.`
          : `Unit tests: NOT VERIFIED - ${check.reason ?? "the author did not report its unit tests"}.`,
        ...(check.logExcerpt ? ["Output excerpt:", "```", truncate(check.logExcerpt, 4000), "```"] : []),
        "You cannot approve this round: request changes with a blocker comment about the unit tests.",
        ...notes,
      ].join("\n");
  }
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
    const briefing = briefingBlock(input.task);
    if (briefing) parts.push(briefing);
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
      "Then call `submit_test_results` with the status, the exact commands, the counts and one entry per failure (failures unrelated to the requested change go in `unrelated_failures`).",
    );
    return parts.join("\n");
  }
  const userRequests = input.previousRun?.by === "user";
  parts.push(
    userRequests ? `## Run ${input.round}: verify the changes the user requested` : `## Run ${input.round}: verify the test fixer's fixes`,
    "",
    commit,
    "",
    "Test fixer's summary:",
    input.fix.summary.trim() || "(none)",
  );
  if (input.fix.validation?.trim()) parts.push("", "Validation the fixer reported:", input.fix.validation.trim());
  if (input.previousRun?.comments.length) {
    parts.push(
      "",
      userRequests ? "The user's change requests and the fixer's responses:" : "Failures from your previous run and the fixer's responses:",
      formatResponses(input.previousRun.comments, userRequests),
    );
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
    ...(userRequests
      ? [
          "Changes the user explicitly asked for are not integrity problems. If a requested change was not carried out, report it as a failure (category `unknown`) that names the request ID.",
        ]
      : []),
    "Then call `submit_test_results` with the status, the exact commands, the counts and one entry per remaining failure (failures unrelated to the requested change go in `unrelated_failures`).",
  );
  return parts.join("\n");
}

export function plannerPrompt(task: Task, context: RepoContext | undefined): string {
  const skills = context?.techSkills?.length ? ` and the technology skills ${context.techSkills.map((skill) => `\`${skill}\``).join(", ")}` : "";
  return [
    requestBlock(task),
    contextBlock(context, "planner"),
    "",
    "## Plan this task",
    "",
    "Inspect the repository as much as you need to understand what the request involves (structure, relevant code, how it is built and tested).",
    `Every sub-agent you create starts with the repository context above, the instruction files and the hub's best-practice skills for its role${skills}. Your briefing adds what you learned that is specific to this request.`,
    "Then call `submit_plan` with the stages to run, your rationale, a concrete assignment for each stage's agents and the briefing.",
  ].join("\n");
}

/** The manager re-ran the author's unit tests before the review and they failed: hand them back to be fixed. */
export function unitTestFailurePrompt(failure: { command: string; problem: string; output: string }, attempt: number, maxAttempts: number): string {
  return [
    "## The unit tests fail: resolve this before the review",
    "",
    `Before handing your round to the reviewer, the manager re-ran your unit tests in your working directory: \`${failure.command}\` ${failure.problem}.`,
    ...(failure.output.trim() ? ["", "Output (last lines):", "```", truncate(failure.output.trim(), 6000), "```"] : []),
    "",
    "First decide whether your change causes the failure:",
    "- It does (including tests you added or changed): fix the cause - in the code, or in a test that is itself wrong (say why) - and run the tests again. Never skip, delete or weaken tests to make them pass.",
    "- It does not (it fails without your change too, or it is flaky, in code and tests you did not touch): leave it alone, it is for its owners to fix. Report commands that cover your change without it (a test file, project or filter) and list it in `unit_tests.unrelated_failures` with the reason.",
    "Then call `submit_work` again with `unit_tests` and a short summary of what you did (comment responses you already gave need not be repeated). If the tests that cover your change cannot run at all, report status `blocked` with the reason.",
    `This is fix attempt ${attempt} of ${maxAttempts}; after that the round goes to the reviewer with the failing tests.`,
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
  "You ended your turn without calling the `submit_plan` tool. Call `submit_plan` now with the stages, your rationale, an assignment for each stage and the briefing. " +
  "Do not end your turn without calling it.";

/** The tool that ends each kind of agent's turn. */
export function submitToolFor(role: AgentRole): string {
  if (role === "planner") return "submit_plan";
  if (role === "executor") return "submit_test_results";
  return isReviewerRole(role) ? "submit_review" : "submit_work";
}

const AVOID_HANGS =
  "Do not repeat what got stuck: give long-running commands a timeout, run tools non-interactively (for example `CI=true`, `--yes`, `--no-watch`, `-NonInteractive`), never wait on servers, watchers or interactive prompts in the foreground, and narrow a run that hangs (one project, file or test) to find the culprit. If a command hangs again, stop it and report the hang instead of waiting on it.";

/** Sent in the same session after the manager interrupted a stuck turn: the agent keeps its conversation. */
export function recoveryPrompt(role: AgentRole, reason: string): string {
  return [
    `The manager interrupted your previous turn because it stopped making progress: ${reason}.`,
    "Your conversation and the files in your working directory are intact. Continue your assignment from where you left off.",
    AVOID_HANGS,
    `Then finish by calling \`${submitToolFor(role)}\`. Do not end your turn without calling it.`,
  ].join("\n\n");
}

/** Leads the first prompt of a fresh session that replaces a stuck or failed one. */
export function restartNote(role: AgentRole, reason: string): string {
  const lines = [
    "## Note from the manager: you replace a stuck session",
    "",
    `A previous session of this ${ROLE_LABELS[role].toLowerCase()} agent stopped making progress (${reason}), so the manager ended it and started you with the same assignment, below.`,
  ];
  if (!worksDetached(role)) {
    lines.push("", "Your working directory still holds that session's uncommitted changes: run `git status` and `git diff` first and build on them instead of starting over.");
  } else if (role === "executor") {
    lines.push("", "The checkout may hold dependencies and build output from that session; reuse them.");
  }
  lines.push("", AVOID_HANGS, "", "---", "");
  return lines.join("\n");
}
