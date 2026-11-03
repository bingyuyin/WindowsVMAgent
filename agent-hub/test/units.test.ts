import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import { evaluatePermission, parseGitCommand, splitCommandText } from "../src/agents/policy.ts";
import { describeTool } from "../src/agents/copilotDriver.ts";
import { fallbackReview, normalizeReview, normalizeWork } from "../src/workflow/submissions.ts";

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
  });
});
