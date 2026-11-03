import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { loadHubSkills } from "../src/context.ts";
import {
  branchExists,
  branchHead,
  createHarness,
  designPathFrom,
  git,
  steps,
  submitReview,
  submitWork,
  waitFor,
  writeFile,
  type Step,
} from "./helpers.ts";

describe("coding workflow", () => {
  test("coder, reviewer and comment resolver each work on their own branch / place", async () => {
    const h = createHarness({
      coder: [steps(writeFile("hello.js", "export const hello = () => 'hi';\n"), submitWork("Add hello()"))],
      resolver: [
        steps(writeFile("hello.js", "export const hello = (name) => `hi ${name}`;\n"), submitWork("Greet by name", [
          { comment_id: "C1", status: "addressed", note: "hello() now takes a name" },
        ])),
      ],
      "code-reviewer": [
        submitReview("request_changes", [{ severity: "major", file: "hello.js", line: 1, body: "Greet the user by name" }]),
        submitReview("approve"),
      ],
    });
    try {
      const created = await h.runner.submit({ description: "Add a hello function", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;

      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, true);
      assert.equal(task.result?.commits, 2);
      const [round1, round2] = task.stages[0]!.rounds;
      assert.equal(round1!.author!.role, "coder");
      assert.equal(round2!.author!.role, "resolver");
      const comment = round1!.review!.comments[0]!;
      assert.equal(comment.id, "C1");
      assert.equal(comment.status, "addressed");
      assert.equal(comment.response, "hello() now takes a name");

      // Each author agent committed on its own branch; the task branch was fast-forwarded through both.
      const taskBranch = task.branch!;
      assert.ok(taskBranch.startsWith("agent-hub/t-001-"));
      assert.equal(round1!.author!.branch, `${taskBranch}--coder`);
      assert.equal(round2!.author!.branch, `${taskBranch}--resolver`);
      assert.equal(branchHead(h.repoPath, `${taskBranch}--coder`), round1!.author!.commit);
      assert.equal(branchHead(h.repoPath, `${taskBranch}--resolver`), round2!.author!.commit);
      assert.equal(branchHead(h.repoPath, taskBranch), round2!.author!.commit);
      assert.match(git(h.repoPath, "show", `${taskBranch}:hello.js`), /hi \$\{name\}/);
      assert.match(git(h.repoPath, "log", "-1", "--format=%B", taskBranch), /Author agent: Comment resolver/);

      // The reviewer works in its own worktree, pinned to the exact commit it reviewed.
      const [coderSpec] = h.driver.specsFor("coder");
      const [resolverSpec] = h.driver.specsFor("resolver");
      const [reviewerSpec] = h.driver.specsFor("code-reviewer");
      assert.notEqual(reviewerSpec!.workingDirectory, coderSpec!.workingDirectory);
      assert.equal(path.basename(reviewerSpec!.workingDirectory), "review");
      assert.equal(path.basename(coderSpec!.workingDirectory), "author");
      assert.equal(resolverSpec!.workingDirectory, coderSpec!.workingDirectory);
      assert.equal(round1!.review!.reviewedSha, round1!.author!.commit);
      assert.equal(round2!.review!.reviewedSha, round2!.author!.commit);
      assert.equal(reviewerSpec!.readOnly, true);
      assert.equal(coderSpec!.readOnly, false);

      // The resolver starts fresh with the request, the work so far and the open comment.
      const resolverPrompt = h.driver.prompts.resolver![0]!;
      assert.match(resolverPrompt, /## Request/);
      assert.match(resolverPrompt, /## Work so far/);
      assert.match(resolverPrompt, /Add hello\(\)/);
      assert.match(resolverPrompt, /\+export const hello/);
      assert.match(resolverPrompt, /\[C1\] \(major\) hello\.js:1/);
      assert.match(h.driver.prompts["code-reviewer"]![1]!, /addressed: hello\(\) now takes a name/);
      assert.match(h.driver.prompts["code-reviewer"]![1]!, /Comment resolver summary/);

      // Structured agent state for the UI.
      const agents = Object.fromEntries((task.agents ?? []).map((agent) => [agent.role, agent]));
      assert.deepEqual(Object.keys(agents).sort(), ["code-reviewer", "coder", "resolver"]);
      assert.equal(agents.coder!.status, "done");
      assert.equal(agents.coder!.branch, `${taskBranch}--coder`);
      assert.equal(agents["code-reviewer"]!.branch, null);
      assert.deepEqual(agents["code-reviewer"]!.rounds, [1, 2]);
      assert.equal(agents["code-reviewer"]!.turns, 2);
      assert.equal(agents.resolver!.model, "fake-author");

      // Worktrees are cleaned up after completion; branches stay; the user's checkout is untouched.
      assert.equal(fs.existsSync(task.workspaceRoot!), false);
      assert.ok(agents.coder!.workspaceRemoved);
      assert.ok(branchExists(h.repoPath, `${taskBranch}--coder`));
      assert.equal(git(h.repoPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
      assert.equal(fs.existsSync(path.join(h.repoPath, "hello.js")), false);

      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.type === "phase" && event.text === "Resolving review comments"));
      assert.ok(events.some((event) => event.type === "commit" && event.text.includes(`--resolver`)));
      assert.ok(events.some((event) => event.type === "review" && /Approved/.test(event.text)));
    } finally {
      h.cleanup();
    }
  });

  test("multiple tasks run in parallel on the same repository without interfering", async () => {
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const concurrentCoder =
      (file: string): Step =>
      async (spec, prompt) => {
        started++;
        if (started === 2) release();
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tasks did not run concurrently")), 5000));
        await Promise.race([bothStarted, timeout]);
        await writeFile(file, `${file}\n`)(spec, prompt);
        await submitWork(`wrote ${file}`)(spec, prompt);
      };
    const h = createHarness(
      { coder: [concurrentCoder("a.txt"), concurrentCoder("b.txt")], "code-reviewer": [submitReview("approve"), submitReview("approve")] },
      { settings: { maxConcurrency: 2 } },
    );
    try {
      const first = await h.runner.submit({ description: "Task A", kind: "coding", repoId: "sample" });
      const second = await h.runner.submit({ description: "Task B", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const a = h.store.getTask(first.id)!;
      const b = h.store.getTask(second.id)!;
      assert.equal(a.status, "completed");
      assert.equal(b.status, "completed");
      assert.notEqual(a.branch, b.branch);
      const [specA, specB] = h.driver.specsFor("coder");
      assert.notEqual(specA!.workingDirectory, specB!.workingDirectory);
      const filesA = git(h.repoPath, "ls-tree", "--name-only", a.branch!);
      const filesB = git(h.repoPath, "ls-tree", "--name-only", b.branch!);
      assert.equal(filesA.includes("a.txt") !== filesA.includes("b.txt"), true);
      assert.equal(filesB.includes("a.txt") !== filesB.includes("b.txt"), true);
      assert.notEqual(filesA, filesB);
    } finally {
      h.cleanup();
    }
  });

  test("worktree isolation gives every sub-agent its own worktree", async () => {
    const h = createHarness(
      {
        coder: [steps(writeFile("x.txt", "1\n"), submitWork("x"))],
        resolver: [steps(writeFile("x.txt", "2\n"), submitWork("fix", [{ comment_id: "C1", status: "addressed", note: "done" }]))],
        "code-reviewer": [submitReview("request_changes", [{ severity: "minor", body: "use 2" }]), submitReview("approve")],
      },
      { settings: { isolation: "worktree", cleanupWorktrees: false } },
    );
    try {
      const created = await h.runner.submit({ description: "X", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      const dirs = ["coder", "resolver", "code-reviewer"].map((role) => path.basename(h.driver.specsFor(role as "coder")[0]!.workingDirectory));
      assert.deepEqual(dirs, ["coder", "resolver", "code-reviewer"]);
      // Kept because cleanup is off: each author worktree is on its own branch, the reviewer's is detached.
      assert.equal(git(path.join(task.workspaceRoot!, "coder"), "rev-parse", "--abbrev-ref", "HEAD"), `${task.branch}--coder`);
      assert.equal(git(path.join(task.workspaceRoot!, "resolver"), "rev-parse", "--abbrev-ref", "HEAD"), `${task.branch}--resolver`);
      assert.equal(git(path.join(task.workspaceRoot!, "code-reviewer"), "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");

      await h.runner.remove(task.id, { deleteBranch: true });
      assert.equal(fs.existsSync(task.workspaceRoot!), false);
      assert.equal(branchExists(h.repoPath, task.branch!), false);
      assert.equal(branchExists(h.repoPath, `${task.branch}--coder`), false);
    } finally {
      h.cleanup();
    }
  });

  test("stops after the round budget without approval, then continues on retry", async () => {
    const changes: Step = submitReview("request_changes", [{ severity: "major", body: "Still wrong" }]);
    const h = createHarness(
      {
        coder: [steps(writeFile("a.txt", "1\n"), submitWork("first"))],
        resolver: [
          steps(writeFile("a.txt", "2\n"), submitWork("second", [{ comment_id: "C1", status: "addressed", note: "fixed" }])),
          steps(writeFile("a.txt", "3\n"), submitWork("third", [{ comment_id: "C2", status: "declined", note: "out of scope" }])),
        ],
        "code-reviewer": [changes, changes, submitReview("approve")],
      },
      { settings: { maxRounds: 2 } },
    );
    try {
      const created = await h.runner.submit({ description: "Change a.txt", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      let task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, false);
      assert.equal(task.result?.openComments, 1);
      assert.equal(task.stages[0]!.status, "not-approved");
      assert.equal(task.stages[0]!.rounds.length, 2);

      h.runner.retry(task.id, 1);
      await h.runner.idle();
      task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, true);
      assert.equal(task.stages[0]!.rounds.length, 3);
      assert.equal(task.stages[0]!.rounds[2]!.attempt, 2);
      assert.equal(task.stages[0]!.rounds[1]!.review!.comments[0]!.status, "declined");
      assert.equal(git(h.repoPath, "show", `${task.branch}:a.txt`), "3");
      // The resumed resolver session gets the full context plus the open comment.
      const resumedPrompt = h.driver.prompts.resolver![1]!;
      assert.match(resumedPrompt, /## Request/);
      assert.match(resumedPrompt, /## Work so far/);
      assert.match(resumedPrompt, /\[C2\]/);
    } finally {
      h.cleanup();
    }
  });

  test("rejects submissions that skip open comments, so the agent must respond to each", async () => {
    let rejection: Error | undefined;
    const h = createHarness({
      coder: [steps(writeFile("b.txt", "x\n"), submitWork("first"))],
      resolver: [
        async (spec) => {
          if (spec.submit.kind !== "work") throw new Error("unexpected");
          try {
            await spec.submit.onSubmit({ summary: "no responses" });
          } catch (error) {
            rejection = error as Error;
          }
          await spec.submit.onSubmit({ summary: "with responses", comment_responses: [{ comment_id: "C1", status: "addressed", note: "done" }] });
        },
      ],
      "code-reviewer": [submitReview("request_changes", [{ severity: "minor", body: "rename" }]), submitReview("approve")],
    });
    try {
      await h.runner.submit({ description: "B", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      assert.match(rejection?.message ?? "", /Missing comment_responses for: C1/);
      assert.equal(h.store.tasks[0]!.result?.approved, true);
    } finally {
      h.cleanup();
    }
  });

  test("nudges a reviewer that forgets to call submit_review", async () => {
    const h = createHarness({
      coder: [steps(writeFile("c.txt", "c\n"), submitWork("c"))],
      "code-reviewer": [() => {}, submitReview("approve")],
    });
    try {
      await h.runner.submit({ description: "C", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.tasks[0]!;
      assert.equal(task.result?.approved, true);
      assert.match(h.driver.prompts["code-reviewer"]![1]!, /without calling the `submit_review` tool/);
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.type === "warning" && /submit_review/.test(event.text)));
    } finally {
      h.cleanup();
    }
  });

  test("relays agent questions to the user and resumes with the answer", async () => {
    let answer = "";
    const h = createHarness({
      coder: [
        async (spec) => {
          answer = await spec.askUser({ question: "Which file?", choices: ["d.txt", "e.txt"], allowFreeform: true });
          await writeFile(answer, "d\n")(spec, "");
          await submitWork("wrote file")(spec, "");
        },
      ],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "D", kind: "coding", repoId: "sample" });
      await waitFor(() => h.store.getTask(created.id)?.status === "needs-input");
      const pending = h.store.getTask(created.id)!.pendingInput!;
      assert.equal(pending.question, "Which file?");
      h.runner.answer(created.id, pending.id, "d.txt");
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(answer, "d.txt");
      assert.equal(task.status, "completed");
      assert.equal(task.pendingInput, undefined);
    } finally {
      h.cleanup();
    }
  });

  test("cancels a running task and aborts the active agent", async () => {
    const h = createHarness({ coder: [() => new Promise(() => {})] });
    try {
      const created = await h.runner.submit({ description: "E", kind: "coding", repoId: "sample" });
      await waitFor(() => h.store.getTask(created.id)?.agents?.some((agent) => agent.status === "working") ?? false);
      h.runner.cancel(created.id);
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "cancelled");
      assert.equal(task.stages[0]!.status, "cancelled");
      assert.equal(task.agents?.find((agent) => agent.role === "coder")?.status, "cancelled");
      // Cancelled tasks keep their worktrees for inspection or retry.
      assert.ok(fs.existsSync(task.workspaceRoot!));
    } finally {
      h.cleanup();
    }
  });
});

describe("repository context", () => {
  test("discovers repo guidance and hands it to agents together with the hub skills", async () => {
    const skillsDir = path.resolve("skills");
    const h = createHarness(
      {
        coder: [steps(writeFile("f.txt", "f\n"), submitWork("f"))],
        "code-reviewer": [submitReview("approve")],
      },
      {
        hubSkills: loadHubSkills(skillsDir),
        files: {
          "AGENTS.md": "# Agent rules\n",
          "CONTRIBUTING.md": "# Contributing\n",
          "docs/adr/0001-use-node.md": "# ADR 1\n",
          ".github/skills/release-notes/SKILL.md": "---\nname: release-notes\ndescription: Write release notes for every change\n---\nBody\n",
          "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
        },
      },
    );
    try {
      const created = await h.runner.submit({ description: "F", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.deepEqual(task.context?.instructions, ["AGENTS.md"]);
      assert.deepEqual(task.context?.guides, ["CONTRIBUTING.md", "README.md"]);
      assert.deepEqual(task.context?.designDocs, ["docs/adr/0001-use-node.md"]);
      assert.deepEqual(task.context?.skills.map((skill) => [skill.name, skill.description]), [["release-notes", "Write release notes for every change"]]);
      assert.deepEqual(task.context?.skillRoots, [".github/skills"]);
      assert.deepEqual(task.context?.validation, ["npm run lint", "npm test"]);

      const prompt = h.driver.prompts.coder![0]!;
      assert.match(prompt, /## Repository context/);
      assert.match(prompt, /`AGENTS\.md`/);
      assert.match(prompt, /`release-notes` - Write release notes/);
      assert.match(prompt, /`npm test`/);

      const [coder] = h.driver.specsFor("coder");
      const [reviewer] = h.driver.specsFor("code-reviewer");
      assert.deepEqual(coder!.skillDirectories, [path.join(coder!.workingDirectory, ".github/skills"), skillsDir]);
      assert.ok(!coder!.disabledSkills.includes("coding-best-practices"));
      assert.ok(coder!.disabledSkills.includes("code-review"));
      assert.match(coder!.systemPrompt, /load the `coding-best-practices` skill/);
      assert.match(reviewer!.systemPrompt, /load the `code-review` skill/);
      assert.ok(reviewer!.disabledSkills.includes("coding-best-practices"));
    } finally {
      h.cleanup();
    }
  });
});

describe("design workflows", () => {
  test("design task: designer and reviewer iterate to a finalized, committed document", async () => {
    let docPath = "";
    const h = createHarness({
      designer: [
        steps((spec, prompt) => {
          docPath = designPathFrom(prompt);
          assert.ok(fs.existsSync(path.join(spec.workingDirectory, path.dirname(docPath))), "design folder is pre-created");
          return writeFile(docPath, "# Design v1\n")(spec, prompt);
        }, submitWork("v1")),
        steps((spec, prompt) => writeFile(docPath, "# Design v2\n\n## Risks\nNone.\n")(spec, prompt), submitWork("v2", [
          { comment_id: "D1", status: "addressed", note: "Added risks" },
        ])),
      ],
      "design-reviewer": [submitReview("request_changes", [{ severity: "major", body: "Add a risks section" }]), submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Design a cache", kind: "design", repoId: "sample", title: "Cache design" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, true);
      assert.equal(docPath, "docs/designs/t-001-cache-design.md");
      assert.equal(task.result?.designDocPath, docPath);
      assert.match(git(h.repoPath, "show", `${task.branch}:${docPath}`), /## Risks/);
      assert.equal(branchHead(h.repoPath, `${task.branch}--designer`), branchHead(h.repoPath, task.branch!));
      assert.deepEqual(task.stages[0]!.rounds.map((round) => round.author!.role), ["designer", "designer"]);
      assert.equal((await h.runner.design(task.id, 1)).content, "# Design v1\n");
      assert.match((await h.runner.design(task.id)).content ?? "", /Design v2/);
      // The re-review shows the document diff between rounds.
      assert.match(h.driver.prompts["design-reviewer"]![1]!, /\+## Risks/);
    } finally {
      h.cleanup();
    }
  });

  test("design -> coding: the coder starts from the approved design on its own branch", async () => {
    let docPath = "";
    const h = createHarness({
      designer: [
        steps((spec, prompt) => {
          docPath = designPathFrom(prompt);
          return writeFile(docPath, "# Plan\nCreate impl.txt\n")(spec, prompt);
        }, submitWork("plan")),
      ],
      "design-reviewer": [submitReview("approve")],
      coder: [
        steps((spec) => {
          assert.ok(fs.existsSync(path.join(spec.workingDirectory, docPath)), "approved design is in the coder's checkout");
        }, writeFile("impl.txt", "done\n"), submitWork("implemented")),
      ],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Plan and build", kind: "design-coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.deepEqual(task.stages.map((stage) => stage.status), ["approved", "approved"]);
      assert.equal(task.result?.commits, 2);
      assert.deepEqual((task.agents ?? []).map((agent) => agent.role), ["designer", "design-reviewer", "coder", "code-reviewer"]);
      const coderPrompt = h.driver.prompts.coder![0]!;
      assert.match(coderPrompt, /## Approved design/);
      assert.match(coderPrompt, /Create impl\.txt/);
      assert.ok(coderPrompt.includes(docPath));
    } finally {
      h.cleanup();
    }
  });

  test("design submissions are rejected until the document exists", async () => {
    let rejection: Error | undefined;
    const h = createHarness({
      designer: [
        async (spec, prompt) => {
          if (spec.submit.kind !== "work") throw new Error("unexpected");
          try {
            await spec.submit.onSubmit({ summary: "forgot the file" });
          } catch (error) {
            rejection = error as Error;
          }
          await writeFile(designPathFrom(prompt), "# Doc\n")(spec, prompt);
          await spec.submit.onSubmit({ summary: "wrote the file" });
        },
      ],
      "design-reviewer": [submitReview("approve")],
    });
    try {
      await h.runner.submit({ description: "Doc", kind: "design", repoId: "sample" });
      await h.runner.idle();
      assert.match(rejection?.message ?? "", /design document was not found/);
      assert.equal(h.store.tasks[0]!.result?.approved, true);
    } finally {
      h.cleanup();
    }
  });
});

describe("legacy tasks", () => {
  test("deleting a task from the single-worktree layout removes its worktree and branches", async () => {
    const h = createHarness({});
    try {
      const base = git(h.repoPath, "rev-parse", "HEAD");
      const root = path.join(h.worktreesDir, "T-009");
      fs.mkdirSync(h.worktreesDir, { recursive: true });
      git(h.repoPath, "worktree", "add", "-q", "-b", "agent-hub/t-009-old", root, base);
      const now = new Date().toISOString();
      h.store.addTask({
        id: "T-009", title: "Old", description: "Old", kind: "coding", repoId: "sample", repoName: "sample", baseRef: "main", baseSha: base,
        branch: "agent-hub/t-009-old", worktreePath: root, authorModel: "a", reviewerModel: "r", maxRounds: 3, status: "completed",
        phase: "done", currentRound: 1, stages: [], sessions: [], usage: { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 },
        attempt: 1, createdAt: now, updatedAt: now, lastSeq: 0,
      });
      await h.runner.remove("T-009", { deleteBranch: true });
      assert.equal(fs.existsSync(root), false);
      assert.equal(branchExists(h.repoPath, "agent-hub/t-009-old"), false);
      assert.equal(git(h.repoPath, "worktree", "list").split("\n").length, 1);
    } finally {
      h.cleanup();
    }
  });
});
