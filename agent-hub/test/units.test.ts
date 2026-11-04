import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { evaluatePermission, parseGitCommand, splitCommandText } from "../src/agents/policy.ts";
import { describeTool } from "../src/agents/copilotDriver.ts";
import { recoveryPrompt, restartNote, systemPromptFor, unitTestFailurePrompt } from "../src/agents/prompts.ts";
import { loadHubSkills, ROLE_SKILLS, skillsForRole, techSkillsFor } from "../src/context.ts";
import { docForPrompt, docForViewer, documentProblem, formatOfPath, loadDocTemplates, renderDocTemplate } from "../src/docs.ts";
import { parseSettingsPatch } from "../src/http/api.ts";
import { branchWebUrl, parseRemote, pullRequestPageUrl, sanitizeRemoteUrl } from "../src/remote.ts";
import { runShellCommand } from "../src/shell.ts";
import { rolesFor, rolesForStages, stageKindsOf, worksDetached } from "../src/types.ts";
import { describeTestRun, testRunEnv } from "../src/workflow/engine.ts";
import { KeyedMutex } from "../src/util.ts";
import { pullRequestBase } from "../src/workflow/runner.ts";
import {
  fallbackReview,
  fallbackTestRun,
  heuristicPlan,
  mergeWork,
  normalizePlan,
  normalizeReview,
  normalizeTestRun,
  normalizeUnitTests,
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
      briefing: " src/calc.js holds the math; run npm test ",
    });
    assert.deepEqual(plan.stages, ["coding", "testing", "document"]);
    assert.deepEqual(plan.instructions, { coding: "Build it", testing: "Run npm test", document: "Document it" });
    assert.equal(plan.briefing, "src/calc.js holds the math; run npm test");
    assert.throws(() => normalizePlan({ stages: ["coding"], rationale: "r", instructions: { coding: "x" } }), /`briefing` is required/);
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

  test("the stuck-agent threshold can be set from 3 to 240 minutes", () => {
    assert.deepEqual(parseSettingsPatch({ stuckAgentMinutes: 20 }), { stuckAgentMinutes: 20 });
    assert.throws(() => parseSettingsPatch({ stuckAgentMinutes: 2 }), /stuckAgentMinutes' must be an integer between 3 and 240/);
    assert.throws(() => parseSettingsPatch({ stuckAgentMinutes: 241 }), /stuckAgentMinutes/);
  });
});

describe("best-practice skills", () => {
  test("agents that design, write, review or test code also get the skills for the repository's technologies", () => {
    const stack = { stack: ["Node.js", "TypeScript", "PowerShell"] };
    assert.deepEqual(techSkillsFor(stack.stack), ["typescript-best-practices", "powershell-best-practices"]);
    assert.deepEqual(skillsForRole("coder", stack), ["coding-best-practices", "typescript-best-practices", "powershell-best-practices"]);
    assert.deepEqual(skillsForRole("executor", { stack: [".NET"] }), ["test-execution", "dotnet-best-practices"]);
    assert.deepEqual(skillsForRole("design-reviewer", { stack: ["Go"] }), ["design-review", "go-best-practices"]);
    assert.deepEqual(skillsForRole("writer", { stack: [".NET"] }), ["technical-writing"]);
    assert.deepEqual(skillsForRole("planner", { stack: ["Python"] }), []);
    assert.deepEqual(skillsForRole("coder", undefined), ["coding-best-practices"]);
    assert.deepEqual(techSkillsFor(["Java (Maven)", "JVM (Gradle)", "Unknown"]), ["java-best-practices"]);
  });

  test("every skill the hub refers to ships in skills/ under its own name", () => {
    const hub = loadHubSkills(path.join(import.meta.dirname, "..", "skills"));
    const names = hub.skills.map((skill) => skill.name);
    for (const skill of hub.skills) {
      assert.equal(skill.path, skill.name, "folder name matches the skill name");
      assert.ok(skill.description.length > 20, `${skill.name} has a description`);
    }
    const stacks = ["Node.js", "TypeScript", ".NET", "Python", "Go", "Rust", "Java (Maven)", "JVM (Gradle)", "PowerShell", "C/C++"];
    for (const skill of [...Object.values(ROLE_SKILLS).flat(), ...techSkillsFor(stacks)]) assert.ok(names.includes(skill), `${skill} is missing`);
    assert.equal(techSkillsFor(stacks).length, 8);
  });
});

describe("unit-test gate", () => {
  test("coding agents must report passing unit tests, or say why they cannot pass", () => {
    const report = normalizeUnitTests({ status: "PASS", commands: [" npm test ", ""], total: 12, passed: 12, failed: 0 });
    assert.deepEqual(report, { status: "passed", commands: ["npm test"], total: 12, passed: 12, failed: 0, skipped: undefined, reason: undefined });
    assert.throws(() => normalizeUnitTests({ status: "failed", commands: ["npm test"] }), /still fail\. Fix the cause/);
    assert.throws(() => normalizeUnitTests({ status: "passed", commands: [] }), /commands` is required/);
    assert.throws(() => normalizeUnitTests({ status: "passed", commands: ["npm test"], failed: 2 }), /`unit_tests.failed` is greater than 0/);
    assert.throws(() => normalizeUnitTests({ status: "passed", commands: ["npm test"], total: 0 }), /No unit tests ran/);
    assert.throws(() => normalizeUnitTests({ status: "blocked", commands: [] }), /reason` is required when status is blocked/);
    assert.equal(normalizeUnitTests({ status: "blocked", commands: [], reason: "Needs a database" }).reason, "Needs a database");
    assert.throws(() => normalizeUnitTests({ status: "passed", commands: Array(11).fill("npm test") }), /at most 10 commands/);

    assert.throws(() => normalizeWork({ summary: "s" }, [], { unitTests: true }), /`unit_tests` is required/);
    assert.equal(normalizeWork({ summary: "s", unit_tests: { status: "passed", commands: ["x"] } }, []).unit_tests, undefined, "other stages ignore unit tests");
    assert.doesNotThrow(() => normalizeWork({ summary: "fixed the tests" }, ["C1"], { partialResponses: true }));
  });

  test("a resubmission after test fixes keeps the round's comment responses unless revised", () => {
    const merged = mergeWork(
      {
        summary: "Added add()",
        validation: "npm test",
        comment_responses: [
          { comment_id: "C1", status: "addressed", note: "done" },
          { comment_id: "C2", status: "declined", note: "out of scope" },
        ],
        unit_tests: { status: "passed", commands: ["npm test"] },
      },
      { summary: "Fixed the sign", comment_responses: [{ comment_id: "C2", status: "addressed", note: "done after all" }], unit_tests: { status: "passed", commands: ["npm run test:unit"] } },
    );
    assert.equal(merged.summary, "Added add()\n\n**Unit test fixes:** Fixed the sign");
    assert.equal(merged.validation, "npm test");
    assert.deepEqual(merged.comment_responses?.map((response) => `${response.comment_id}:${response.status}`), ["C1:addressed", "C2:addressed"]);
    assert.deepEqual(merged.unit_tests?.commands, ["npm run test:unit"]);
  });

  test("failing runs go back to the author with the command, the problem and the output", () => {
    const prompt = unitTestFailurePrompt({ command: "npm test", problem: "exited with code 1 after 4 s", output: "FAIL add.test.js\nexpected 3, received -1\n" }, 2, 3);
    assert.match(prompt, /`npm test` exited with code 1 after 4 s\./);
    assert.match(prompt, /expected 3, received -1/);
    assert.match(prompt, /Never skip, delete or weaken tests/);
    assert.match(prompt, /fix attempt 2 of 3/);
    const env = { worktree: cwd, branch: "t--coder", taskBranch: "t", baseSha: "abc1234567" };
    assert.match(systemPromptFor("coder", env), /Unit tests are part of the change/);
    assert.match(systemPromptFor("resolver", { ...env, branch: "t--resolver" }), /run the build and the unit tests again until they all pass/);
    assert.match(systemPromptFor("code-reviewer", { ...env, branch: null }), /Never approve while the unit tests fail/);
  });

  test("the manager runs commands in the agents' shell, with their exit code, output and a stop for silent runs", async () => {
    const options = { cwd: process.cwd(), timeoutMs: 60_000, silenceMs: 30_000 };
    const passed = await runShellCommand(`node -e "console.log('hello from the test run')"`, options);
    assert.equal(passed.exitCode, 0);
    assert.match(passed.output, /hello from the test run/);
    assert.equal((await runShellCommand(`node -e "process.exit(3)"`, options)).exitCode, 3);
    if (process.platform === "win32") {
      const chained = await runShellCommand(`node -e "process.exit(2)"; Write-Output "after the failure"`, options);
      assert.equal(chained.exitCode, 2, "a failed native command fails the run even when a later statement succeeds");
    }
    const silent = await runShellCommand(`node -e "setTimeout(() => {}, 60000)"`, { ...options, silenceMs: 1500 });
    assert.equal(silent.stopped, "silent");
    assert.equal(silent.exitCode, null);
    assert.ok(silent.durationMs < 20_000, `stopped after ${silent.durationMs} ms`);
    const controller = new AbortController();
    const cancelled = runShellCommand(`node -e "setTimeout(() => {}, 60000)"`, { ...options, signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    assert.equal((await cancelled).stopped, "cancelled");
  });
});

describe("isolation between tasks", () => {
  test("agents cannot install tools, packages or settings that every task on the machine shares", () => {
    const executor = { readOnly: false, executeOnly: true, workingDirectory: cwd };
    for (const command of [
      "npm install -g typescript",
      "npm i --global eslint",
      "pnpm add -g vitest",
      "yarn global add jest",
      "dotnet tool install --global dotnet-ef",
      "pip install --user requests",
      "python -m pip install --user pytest",
      "winget install Git.Git",
      "choco install nodejs -y",
      "sudo apt-get install -y libssl-dev",
      "brew install jq",
      "msiexec /i tool.msi /qn",
      "setx PATH C:\\tools",
      "Install-Module Pester -Scope AllUsers -Force",
      "npm test; npm install -g rimraf",
    ]) {
      assert.equal(evaluatePermission(shell(command, []), author).kind, "reject", command);
      assert.equal(evaluatePermission(shell(command, []), executor).kind, "reject", command);
    }
    for (const command of [
      "npm install",
      "npm ci",
      "npm i -D jest",
      "pip install -r requirements.txt",
      "python -m venv .venv",
      "dotnet tool install dotnet-ef",
      "dotnet tool restore",
      "Install-Module Pester -Scope CurrentUser -Force",
      "go test ./...",
      "npm run test -- --grep global",
    ]) {
      assert.equal(evaluatePermission(shell(command, []), author).kind, "approve-once", command);
    }
    const rejected = evaluatePermission(shell("npm install -g typescript", []), author);
    assert.match(rejected.kind === "reject" ? rejected.feedback : "", /other tasks on this machine share/);
  });

  test("the per-repository test lock reports while another task holds it", async () => {
    const mutex = new KeyedMutex();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = mutex.run("repo#tests", () => gate);
    assert.equal(mutex.busy("repo#tests"), true);
    assert.equal(mutex.busy("other-repo#tests"), false);
    release();
    await held;
    assert.equal(mutex.busy("repo#tests"), false);
  });

  test("the manager's test runs get the task's own temp folder and the worktree's own toolchain first", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-env-"));
    try {
      const tempDir = path.join(worktree, "..", "tmp");
      assert.deepEqual(testRunEnv(worktree, tempDir), { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir, MSBUILDDISABLENODEREUSE: "1" });
      fs.mkdirSync(path.join(worktree, ".venv"));
      fs.writeFileSync(path.join(worktree, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
      fs.mkdirSync(path.join(worktree, "node_modules", ".bin"), { recursive: true });
      const env = testRunEnv(worktree, tempDir);
      assert.equal(env.VIRTUAL_ENV, path.join(worktree, ".venv"));
      const [venvBin, nodeBin] = env.PATH!.split(path.delimiter);
      assert.equal(venvBin, path.join(worktree, ".venv", process.platform === "win32" ? "Scripts" : "bin"));
      assert.equal(nodeBin, path.join(worktree, "node_modules", ".bin"));
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
  });

  test("a process a command leaves running is stopped and holds neither the run nor its result", async () => {
    // Detached on Windows, so only the shell's job object can catch it once its parent has exited.
    const leftover = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: ${process.platform === "win32"} }); c.unref(); console.log('tests done, server ' + c.pid)`;
    const result = await runShellCommand(`node -e "${leftover}"`, { cwd: process.cwd(), timeoutMs: 60_000, silenceMs: 30_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stopped, undefined);
    assert.ok(result.durationMs < 10_000, `returned after ${result.durationMs} ms`);
    const pid = Number(/tests done, server (\d+)/.exec(result.output)?.[1]);
    assert.ok(pid > 0, result.output);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; alive() && waited < 3000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      assert.equal(alive(), false, `process ${pid} still runs`);
    } finally {
      if (alive()) process.kill(pid);
    }
  });
});

describe("recovery prompts", () => {
  test("an interrupted agent continues in its session; a replacement session builds on the stuck one's work", () => {
    const resume = recoveryPrompt("executor", "no activity for 20 min (last: powershell: npm test)");
    assert.match(resume, /stopped making progress: no activity for 20 min \(last: powershell: npm test\)\./);
    assert.match(resume, /give long-running commands a timeout/);
    assert.match(resume, /`submit_test_results`/);
    assert.match(recoveryPrompt("code-reviewer", "x"), /`submit_review`/);
    assert.match(recoveryPrompt("planner", "x"), /`submit_plan`/);
    assert.match(recoveryPrompt("fixer", "x"), /`submit_work`/);
    assert.match(restartNote("fixer", "its session failed: boom"), /test fixer agent stopped making progress \(its session failed: boom\)/);
    assert.match(restartNote("fixer", "x"), /run `git status` and `git diff` first/);
    assert.doesNotMatch(restartNote("code-reviewer", "x"), /git status/);
    assert.match(restartNote("executor", "x"), /reuse them/);
  });
});

describe("remotes and pull requests", () => {
  test("parses GitHub, Azure DevOps, GitLab and Bitbucket remotes and drops credentials", () => {
    const github = parseRemote("origin", "https://user:ghp_secret@github.com/bingyuyin/WindowsVMAgent.git");
    assert.equal(github.url, "https://github.com/bingyuyin/WindowsVMAgent.git");
    assert.deepEqual([github.provider, github.host, github.slug], ["github", "github.com", "bingyuyin/WindowsVMAgent"]);
    assert.equal(github.webUrl, "https://github.com/bingyuyin/WindowsVMAgent");
    assert.equal(parseRemote("origin", "git@github.com:acme/calc.git").webUrl, "https://github.com/acme/calc");
    assert.equal(parseRemote("origin", "ssh://git@github.com/acme/calc").slug, "acme/calc");
    assert.equal(parseRemote("origin", "https://acme.ghe.com/team/tool.git").provider, "github");

    const ado = parseRemote("origin", "https://acme@dev.azure.com/acme/Platform%20Team/_git/Tools");
    assert.equal(ado.provider, "azure-devops");
    assert.equal(ado.url, "https://dev.azure.com/acme/Platform%20Team/_git/Tools");
    assert.equal(ado.webUrl, "https://dev.azure.com/acme/Platform%20Team/_git/Tools");
    assert.equal(parseRemote("origin", "git@ssh.dev.azure.com:v3/acme/Platform/Tools").webUrl, "https://dev.azure.com/acme/Platform/_git/Tools");
    assert.equal(
      parseRemote("origin", "https://acme.visualstudio.com/DefaultCollection/Platform/_git/Tools").webUrl,
      "https://acme.visualstudio.com/DefaultCollection/Platform/_git/Tools",
    );

    assert.equal(parseRemote("origin", "https://gitlab.com/group/sub/repo.git").slug, "group/sub/repo");
    assert.equal(parseRemote("origin", "git@bitbucket.org:team/repo.git").webUrl, "https://bitbucket.org/team/repo");
    for (const local of ["C:\\repos\\calc.git", "/srv/git/calc.git", "file:///C:/repos/calc.git", "https://git.example.com/a/b.git"]) {
      const remote = parseRemote("origin", local);
      assert.deepEqual([remote.provider, remote.webUrl], ["other", null], local);
    }
    assert.equal(
      sanitizeRemoteUrl("fatal: unable to access 'https://x-access-token:abc123@github.com/a/b.git/': denied"),
      "fatal: unable to access 'https://github.com/a/b.git/': denied",
    );
  });

  test("links to the pushed branch and to the host's prefilled create page", () => {
    const request = { head: "agent-hub/t-001-add", base: "main", title: "Add & test", body: "Summary\n> request" };
    const github = parseRemote("origin", "https://github.com/acme/calc.git");
    assert.equal(branchWebUrl(github, request.head), "https://github.com/acme/calc/tree/agent-hub/t-001-add");
    assert.equal(
      pullRequestPageUrl(github, request),
      "https://github.com/acme/calc/compare/main...agent-hub/t-001-add?expand=1&title=Add%20%26%20test&body=Summary%0A%3E%20request",
    );
    const ado = parseRemote("origin", "https://dev.azure.com/acme/Platform/_git/Tools");
    assert.equal(branchWebUrl(ado, request.head), "https://dev.azure.com/acme/Platform/_git/Tools?version=GBagent-hub%2Ft-001-add");
    assert.equal(pullRequestPageUrl(ado, request), "https://dev.azure.com/acme/Platform/_git/Tools/pullrequestcreate?sourceRef=agent-hub%2Ft-001-add&targetRef=main");
    assert.match(pullRequestPageUrl(parseRemote("origin", "https://gitlab.com/g/r.git"), request)!, /^https:\/\/gitlab\.com\/g\/r\/-\/merge_requests\/new\?merge_request%5Bsource_branch%5D=agent-hub%2Ft-001-add&merge_request%5Btarget_branch%5D=main/);
    assert.equal(pullRequestPageUrl(parseRemote("origin", "git@bitbucket.org:t/r.git"), request), "https://bitbucket.org/t/r/pull-requests/new?source=agent-hub%2Ft-001-add&dest=main");
    assert.equal(pullRequestPageUrl(parseRemote("origin", "C:\\repos\\calc.git"), request), null);
    // Long descriptions are truncated to keep the URL usable.
    assert.ok(pullRequestPageUrl(github, { ...request, body: "x".repeat(20_000) })!.length < 4_300);
  });

  test("pull requests target the branch the task started from, else the default branch", () => {
    assert.equal(pullRequestBase({ baseRef: "release/2.0" }, { defaultBranch: "main" }), "release/2.0");
    assert.equal(pullRequestBase({ baseRef: "refs/heads/dev" }, { defaultBranch: "main" }), "dev");
    assert.equal(pullRequestBase({ baseRef: "HEAD" }, { defaultBranch: "master" }), "master");
    assert.equal(pullRequestBase({ baseRef: "9ffa42b0c1d2" }, { defaultBranch: "main" }), "main");
    assert.equal(pullRequestBase({ baseRef: "" }, { defaultBranch: "HEAD" }), "main");
  });

  test("automatic pushes can be turned off in the settings", () => {
    assert.deepEqual(parseSettingsPatch({ pushOnComplete: false }), { pushOnComplete: false });
    assert.throws(() => parseSettingsPatch({ pushOnComplete: "no" }), /pushOnComplete/);
  });
});
