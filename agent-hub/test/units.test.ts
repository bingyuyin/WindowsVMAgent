import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { evaluatePermission, parseGitCommand, splitCommandText } from "../src/agents/policy.ts";
import { describeTool } from "../src/agents/copilotDriver.ts";
import { systemPromptFor } from "../src/agents/prompts.ts";
import { docForPrompt, docForViewer, documentProblem, formatOfPath, loadDocTemplates, renderDocTemplate } from "../src/docs.ts";
import { parseSettingsPatch } from "../src/http/api.ts";
import { rolesFor, rolesForStages, stageKindsOf, worksDetached } from "../src/types.ts";
import { describeTestRun } from "../src/workflow/engine.ts";
import {
  fallbackReview,
  fallbackTestRun,
  heuristicPlan,
  normalizePlan,
  normalizeReview,
  normalizeTestRun,
  normalizeWork,
} from "../src/workflow/submissions.ts";

const cwd = path.resolve("/work/tree");
const author = { readOnly: false, workingDirectory: cwd };
const reviewer = { readOnly: true, workingDirectory: cwd };
const shell = (text: string, commands: Array<{ identifier: string; readOnly: boolean }>, extra: object = {}) => ({
  kind: "shell",
  fullCommandText: text,
  commands,
  ...extra,
});

describe("permission policy", () => {
  test("authors may edit inside the worktree but not outside", () => {
    assert.equal(evaluatePermission({ kind: "write", fileName: path.join(cwd, "src/a.ts") }, author).kind, "approve-once");
    assert.equal(evaluatePermission({ kind: "write", fileName: "src/relative.ts" }, author).kind, "approve-once");
    assert.equal(evaluatePermission({ kind: "write", fileName: path.resolve("/etc/passwd") }, author).kind, "reject");
  });

  test("reviewers are read-only", () => {
    assert.equal(evaluatePermission({ kind: "write", fileName: path.join(cwd, "a.ts") }, reviewer).kind, "reject");
    assert.equal(evaluatePermission(shell("git diff HEAD~1", [{ identifier: "git", readOnly: true }]), reviewer).kind, "approve-once");
    assert.equal(evaluatePermission(shell("git commit -m x", [{ identifier: "git", readOnly: false }]), reviewer).kind, "reject");
    assert.equal(evaluatePermission(shell("npm test", [{ identifier: "npm", readOnly: false }]), reviewer).kind, "reject");
    assert.equal(evaluatePermission(shell("cat a > b", [{ identifier: "cat", readOnly: true }], { hasWriteFileRedirection: true }), reviewer).kind, "reject");
    assert.equal(evaluatePermission({ kind: "mcp", readOnly: false }, reviewer).kind, "reject");
  });

  test("blocks pushing, branch switching and global config for authors", () => {
    const git = [{ identifier: "git", readOnly: false }];
    for (const command of [
      "git push origin HEAD",
      "git -C ../other push",
      "git checkout main",
      "git checkout -b feature",
      "git switch dev",
      "git reset --hard HEAD~1",
      "git config --global user.name x",
      "npm test && git push",
    ]) {
      assert.equal(evaluatePermission(shell(command, git), author).kind, "reject", command);
    }
    for (const command of ["git status", "git checkout -- src/a.ts", "git commit -m \"push notifications\"", "npm test"]) {
      assert.equal(evaluatePermission(shell(command, git), author).kind, "approve-once", command);
    }
  });

  test("uses parsed command segments when the runtime provides them", () => {
    const request = shell("ignored", [{ identifier: "git", readOnly: false }], {
      commandSegments: [{ fullCommandText: "git push", identifier: "git" }],
    });
    assert.equal(evaluatePermission(request, author).kind, "reject");
  });

  test("reviewers may chain read-only commands even when the runtime reports one opaque command", () => {
    // Observed from the runtime: a PowerShell line reported as a single non-read-only command.
    const text = "git status --short; git diff --no-ext-diff --unified=3 acf07dabff..HEAD -- README.md src/calc.js";
    assert.equal(evaluatePermission(shell(text, [{ identifier: text, readOnly: false }]), reviewer).kind, "approve-once");
    const pipeline = 'Get-Content README.md | Select-String -Pattern "a|b" | Select-Object -First 5';
    assert.equal(evaluatePermission(shell(pipeline, [{ identifier: pipeline, readOnly: false }]), reviewer).kind, "approve-once");
    assert.equal(evaluatePermission(shell("Select-String -Pattern git README.md", []), reviewer).kind, "approve-once");
    for (const command of ["git status; Remove-Item src -Recurse", "git diff | Out-File d.txt", "npm test", "git stash"]) {
      assert.equal(evaluatePermission(shell(command, [{ identifier: command, readOnly: false }]), reviewer).kind, "reject", command);
    }
  });

  test("authors cannot hide a push inside a chained PowerShell line", () => {
    const text = "npm test; git push origin HEAD";
    assert.equal(evaluatePermission(shell(text, [], { commandSegments: [{ fullCommandText: text, identifier: text }] }), author).kind, "reject");
    assert.deepEqual(splitCommandText('git log --format="%h|%s" && echo done'), ['git log --format="%h|%s"', "echo done"]);
  });

  test("denies memory writes and reads outside the worktree", () => {
    assert.equal(evaluatePermission({ kind: "memory" }, author).kind, "reject");
    assert.equal(evaluatePermission({ kind: "read", path: path.resolve("/secrets/key") }, author).kind, "reject");
    assert.equal(evaluatePermission({ kind: "read", path: path.join(cwd, "README.md") }, reviewer).kind, "approve-once");
  });

  test("allows the agent's session scratch folder without opening the repository to reviewers", () => {
    const scratch = path.resolve("/hub/copilot-home/session-state");
    const withScratch = (base: typeof author) => ({ ...base, scratchRoots: [scratch] });
    const plan = path.join(scratch, "abc", "plan.md");
    assert.equal(evaluatePermission({ kind: "write", fileName: plan }, withScratch(reviewer)).kind, "approve-once");
    assert.equal(evaluatePermission({ kind: "read", path: plan }, withScratch(author)).kind, "approve-once");
    assert.equal(evaluatePermission({ kind: "write", fileName: path.join(cwd, "a.ts") }, withScratch(reviewer)).kind, "reject");
  });

  test("parses git global options", () => {
    assert.deepEqual(parseGitCommand('git -C "some dir" -c core.x=1 --no-pager log -1'), { subcommand: "log", args: ["-1"] });
    assert.equal(parseGitCommand("echo hello"), null);
  });
});

describe("submission validation", () => {
  test("normalizes reviews and enforces verdict consistency", () => {
    const review = normalizeReview({
      verdict: "Request Changes",
      summary: " needs work ",
      comments: [{ severity: "HIGH", file: "src\\a.ts", line: "12", body: " fix it " }],
    });
    assert.deepEqual(review, { verdict: "request_changes", summary: "needs work", comments: [{ severity: "major", file: "src/a.ts", line: 12, body: "fix it" }] });
    assert.throws(() => normalizeReview({ verdict: "request_changes", summary: "x", comments: [] }), /at least one/);
    assert.throws(() => normalizeReview({ verdict: "approve", summary: "x", comments: [{ severity: "blocker", body: "b" }] }), /approved but included/);
    assert.throws(() => normalizeReview({ verdict: "maybe", summary: "x", comments: [] }), /Invalid verdict/);
  });

  test("requires a response for every open comment", () => {
    assert.throws(() => normalizeWork({ summary: "s" }, ["C1", "C2"]), /Missing comment_responses for: C1, C2/);
    const work = normalizeWork(
      { summary: "s", comment_responses: [{ comment_id: "[c1]", status: "Addressed", note: "ok" }, { comment_id: "C9", status: "addressed", note: "?" }] },
      ["C1"],
    );
    assert.deepEqual(work.comment_responses, [{ comment_id: "C1", status: "addressed", note: "ok" }]);
  });

  test("derives a fallback verdict from free text", () => {
    assert.equal(fallbackReview("LGTM, approved.").verdict, "approve");
    assert.equal(fallbackReview("I would not approve this; changes requested").verdict, "request_changes");
    assert.equal(fallbackReview(undefined).comments.length, 1);
  });
});

describe("tool labels", () => {
  test("summarizes tool calls for the live activity feed", () => {
    assert.equal(describeTool("powershell", { command: "npm test\nmore" }, cwd), "powershell: npm test");
    assert.equal(describeTool("view", { path: path.join(cwd, "src", "a.ts") }, cwd), "view: src/a.ts");
    assert.equal(describeTool("submit_review", { verdict: "request_changes" }, cwd), "Submitting review (request changes)");
    assert.equal(describeTool("skill", { skill: "code-review" }, cwd), "Loading skill: code-review");
    assert.equal(describeTool("skill", {}, cwd), "Loading a skill");
    assert.equal(describeTool("submit_test_results", { status: "failed" }, cwd), "Submitting test results (failed)");
    assert.equal(describeTool("submit_plan", { stages: ["coding", "testing"] }, cwd), "Submitting plan (coding → testing)");
  });
});

describe("test runs (executor)", () => {
  const failure = { test: "adds", file: "test\\calc.test.js", line: 3, error: "expected 3", category: "regression" };

  test("normalizes statuses, categories and paths", () => {
    const run = normalizeTestRun({ status: "FAIL", summary: "1 failing", commands: [" npm test ", ""], total: 2, failed: 1, failures: [failure] });
    assert.equal(run.status, "failed");
    assert.deepEqual(run.commands, ["npm test"]);
    assert.equal(run.failures[0]!.category, "product-bug");
    assert.equal(run.failures[0]!.file, "test/calc.test.js");
    assert.equal(normalizeTestRun({ status: "success", summary: "ok", commands: ["npm test"], failures: [], total: 5 }).status, "passed");
    assert.equal(normalizeTestRun({ status: "blocked", summary: "no pester", failures: [{ test: "setup", error: "missing", category: "infra" }] }).failures[0]!.category, "environment");
  });

  test("rejects results that cannot be trusted", () => {
    const base = { summary: "s", commands: ["npm test"] };
    assert.throws(() => normalizeTestRun({ ...base, status: "passed", failures: [failure] }), /status is passed but failures are listed/);
    assert.throws(() => normalizeTestRun({ ...base, status: "passed", failures: [], total: 0 }), /No tests ran/);
    assert.throws(() => normalizeTestRun({ ...base, status: "passed", failures: [], failed: 2 }), /`failed` is greater than 0/);
    assert.throws(() => normalizeTestRun({ ...base, status: "failed", failures: [] }), /requires at least one entry/);
    assert.throws(() => normalizeTestRun({ summary: "s", status: "failed", commands: [], failures: [failure] }), /`commands` is required/);
    assert.throws(() => normalizeTestRun({ ...base, status: "green-ish", failures: [] }), /Invalid status/);
    assert.throws(() => normalizeTestRun({ ...base, status: "failed", failures: [{ test: "x", category: "flaky" }] }), /error is required/);
  });

  test("a missing submission is treated as blocked, never as passed", () => {
    const run = fallbackTestRun("All 12 tests passed!");
    assert.equal(run.status, "blocked");
    assert.equal(run.failures.length, 1);
  });

  test("describes runs for the manager log", () => {
    const comments = [
      { id: "T1", severity: "blocker", body: "", status: "open", category: "product-bug" },
      { id: "T2", severity: "blocker", body: "", status: "open", category: "test-bug" },
    ] as const;
    assert.equal(describeTestRun({ status: "passed", commands: [], total: 12, skipped: 1 }, []), "Passed: 12 tests, 1 skipped");
    assert.equal(describeTestRun({ status: "failed", commands: [], total: 12, failed: 2 }, [...comments]), "Failed: 2 of 12 (1 product-bug, 1 test-bug)");
    assert.match(describeTestRun({ status: "blocked", commands: [] }, [{ ...comments[0], test: "Pester missing" }]), /^Blocked: Pester missing/);
  });
});

describe("manager plans", () => {
  test("normalizes and orders stages and requires an assignment for each", () => {
    const plan = normalizePlan({
      stages: ["docs", "implementation", "verify", "implementation"],
      rationale: "why",
      instructions: { document: "Document it", coding: "Build it", testing: "Run npm test", design: "ignored" },
    });
    assert.deepEqual(plan.stages, ["coding", "testing", "document"]);
    assert.deepEqual(plan.instructions, { coding: "Build it", testing: "Run npm test", document: "Document it" });
    assert.throws(() => normalizePlan({ stages: ["deploy"], rationale: "r", instructions: {} }), /Unknown stage 'deploy'/);
    assert.throws(() => normalizePlan({ stages: [], rationale: "r", instructions: {} }), /non-empty array/);
    assert.throws(() => normalizePlan({ stages: ["coding"], rationale: "", instructions: { coding: "x" } }), /rationale/);
    assert.throws(() => normalizePlan({ stages: ["testing"], rationale: "r", instructions: {} }), /instructions\.testing is required.*commands or suites/);
  });

  test("falls back to keywords when no plan is submitted", () => {
    assert.deepEqual(heuristicPlan("Run the test automation in tests/ and verify the results").stages, ["testing"]);
    assert.deepEqual(heuristicPlan("Design and implement a retry policy, then document it").stages, ["design", "coding", "document"]);
    assert.deepEqual(heuristicPlan("Something vague").stages, ["coding"]);
  });

  test("roles follow the plan; the planner and executor work in pinned checkouts", () => {
    assert.deepEqual(rolesFor("auto"), ["planner"]);
    assert.deepEqual(rolesFor("testing"), ["executor", "fixer"]);
    assert.deepEqual(rolesForStages(["coding", "testing"]), ["coder", "code-reviewer", "resolver", "executor", "fixer"]);
    assert.deepEqual(stageKindsOf({ kind: "auto", plan: undefined }), []);
    assert.deepEqual(stageKindsOf({ kind: "auto", plan: { stages: ["testing"], rationale: "", instructions: {}, plannedAt: "" } }), ["testing"]);
    assert.equal(worksDetached("executor"), true);
    assert.equal(worksDetached("planner"), true);
    assert.equal(worksDetached("fixer"), false);
  });
});

describe("executor permissions", () => {
  const executor = { readOnly: false, executeOnly: true, workingDirectory: cwd };

  test("may run build and test commands but not edit files or move git state", () => {
    assert.equal(evaluatePermission(shell("npm ci; npm test", [{ identifier: "npm", readOnly: false }]), executor).kind, "approve-once");
    assert.equal(evaluatePermission(shell("Invoke-Pester -Path tests > results.txt", [{ identifier: "Invoke-Pester", readOnly: false }], { hasWriteFileRedirection: true }), executor).kind, "approve-once");
    assert.equal(evaluatePermission(shell("git submodule update --init", [{ identifier: "git", readOnly: false }]), executor).kind, "approve-once");
    assert.equal(evaluatePermission(shell("git diff HEAD~1", [{ identifier: "git", readOnly: true }]), executor).kind, "approve-once");
    const commit = evaluatePermission(shell("git commit -am wip", [{ identifier: "git", readOnly: false }]), executor);
    assert.equal(commit.kind, "reject");
    assert.match(commit.kind === "reject" ? commit.feedback : "", /Test executor: 'git commit'/);
    assert.equal(evaluatePermission(shell("git checkout main", [{ identifier: "git", readOnly: false }]), executor).kind, "reject");
    const write = evaluatePermission({ kind: "write", fileName: path.join(cwd, "src/a.ts") }, executor);
    assert.equal(write.kind, "reject");
    assert.match(write.kind === "reject" ? write.feedback : "", /test fixer agent fixes them/);
  });
});

describe("new agent prompts", () => {
  const env = { worktree: cwd, branch: null, taskBranch: "t", baseSha: "abc1234567" };

  test("executor, fixer and planner know their jobs and limits", () => {
    const executor = systemPromptFor("executor", env, ["test-execution"]);
    assert.match(executor, /never edit, create or delete source files/);
    assert.match(executor, /zero tests run is a failure/);
    assert.match(executor, /integrity/);
    assert.match(executor, /load the `test-execution` skill/);
    assert.match(executor, /`submit_test_results`/);
    const fixer = systemPromptFor("fixer", { ...env, branch: "t--fixer" }, ["test-fixing"]);
    assert.match(fixer, /Never make tests pass by deleting or skipping them/);
    assert.match(fixer, /own branch `t--fixer`/);
    const planner = systemPromptFor("planner", env);
    assert.match(planner, /You are the MANAGER/);
    assert.match(planner, /- testing: a test executor runs the test automation/);
    assert.match(planner, /`submit_plan`/);
  });
});

describe("HTML documents", () => {
  const templates = loadDocTemplates(path.join(import.meta.dirname, "..", "templates"))!;
  const vars = { title: "A <b> & c", taskId: "T-042", repo: "calc", date: "2025-01-02", author: "writer", reviewer: "doc-reviewer" } as const;

  test("templates are light-themed, escaped and full of placeholders to fill", () => {
    const html = renderDocTemplate(templates, "document", vars)!;
    assert.match(html, /<h1>A &lt;b&gt; &amp; c<\/h1>/);
    assert.match(html, /Documentation/);
    assert.match(html, /Technical writer agent, reviewed by the doc reviewer agent/);
    assert.match(html, /--bg: #f5f7fb/);
    assert.doesNotMatch(html, /\{\{\w+\}\}/);
    assert.match(renderDocTemplate(templates, "design", { ...vars, author: "designer", reviewer: "design-reviewer" })!, /sequenceDiagram/);
    assert.equal(renderDocTemplate(templates, "coding", vars), null);
  });

  test("documentProblem explains what blocks a submission", () => {
    const seeded = renderDocTemplate(templates, "document", vars)!;
    assert.match(documentProblem(null, "html") ?? "", /missing or empty/);
    assert.match(documentProblem(seeded, "html", seeded) ?? "", /unmodified template/);
    assert.match(documentProblem(seeded.replace("</h1>", "</h1><p>x</p>"), "html", seeded) ?? "", /template placeholder elements/);
    assert.match(documentProblem("<p>no title</p>", "html") ?? "", /no <h1> title/);
    assert.equal(documentProblem("<h1 class='t'>Doc</h1><p>Ok</p>", "html"), null);
    assert.equal(documentProblem("# Markdown is fine", "markdown"), null);
    assert.equal(documentProblem('<h1>Doc</h1><p>Mentions data-placeholder in prose</p><p class="x">ok</p>', "html"), null);
  });

  test("prompts get the content without styles; the viewer swaps the CDN loader for local scripts", () => {
    const seeded = renderDocTemplate(templates, "design", { ...vars, author: "designer", reviewer: "design-reviewer" })!;
    const compact = docForPrompt(seeded, "html");
    assert.doesNotMatch(compact, /--blue-soft|<script|Authoring guide/);
    assert.match(compact, /template styles omitted/);
    assert.equal(docForPrompt("# Title\n\n\n\nText", "markdown"), "# Title\n\n\n\nText");
    const viewed = docForViewer(seeded, ["/vendor/mermaid.min.js", "/lib/doc-viewer.js"]);
    assert.doesNotMatch(viewed, /cdn\.jsdelivr|<script[^>]*data-hub-mermaid/);
    assert.match(viewed, /<script src="\/lib\/doc-viewer\.js"><\/script>\n<\/body>/);
    assert.match(docForViewer("<p>fragment</p>", ["/x.js"]), /<p>fragment<\/p>\n<script src="\/x\.js"><\/script>$/);
    assert.equal(formatOfPath("docs/a.HTML"), "html");
    assert.equal(formatOfPath("docs/a.md"), "markdown");
  });

  test("system prompts tell document authors and reviewers how to work with HTML", () => {
    const env = { worktree: cwd, branch: "t--writer", taskBranch: "t", baseSha: "abc1234567" };
    const writer = systemPromptFor("writer", env, ["technical-writing"], { docFormat: "html" });
    assert.match(writer, /ROLE: TECHNICAL WRITER/);
    assert.match(writer, /data-placeholder/);
    assert.match(writer, /<pre class="mermaid">/);
    assert.match(writer, /load the `technical-writing` skill/);
    assert.match(systemPromptFor("writer", env, [], { docFormat: "markdown" }), /GitHub-flavored Markdown/);
    const reviewer = systemPromptFor("doc-reviewer", { ...env, branch: null }, ["doc-review"], { docFormat: "html" });
    assert.match(reviewer, /strictly read-only/);
    assert.match(reviewer, /leftover template placeholders/);
    assert.match(reviewer, /pinned \(detached HEAD\)/);
  });

  test("settings accept the document options", () => {
    assert.deepEqual(parseSettingsPatch({ docFormat: "markdown", documentDir: ".\\docs\\guides\\", resumeInterruptedTasks: false }), {
      docFormat: "markdown",
      documentDir: "docs/guides",
      resumeInterruptedTasks: false,
    });
    assert.throws(() => parseSettingsPatch({ docFormat: "pdf" }), /docFormat/);
    assert.throws(() => parseSettingsPatch({ documentDir: "../outside" }), /documentDir/);
    assert.throws(() => parseSettingsPatch({ resumeInterruptedTasks: "yes" }), /resumeInterruptedTasks/);
  });

  test("parallel tasks can be set from 1 to 10", () => {
    assert.deepEqual(parseSettingsPatch({ maxConcurrency: 10 }), { maxConcurrency: 10 });
    assert.deepEqual(parseSettingsPatch({ maxConcurrency: 1 }), { maxConcurrency: 1 });
    assert.throws(() => parseSettingsPatch({ maxConcurrency: 11 }), /maxConcurrency' must be an integer between 1 and 10/);
    assert.throws(() => parseSettingsPatch({ maxConcurrency: 0 }), /maxConcurrency/);
  });
});
