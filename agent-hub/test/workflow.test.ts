import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import { loadHubSkills } from "../src/context.ts";
import type { CopilotService } from "../src/copilot/service.ts";
import { loadDocTemplates } from "../src/docs.ts";
import { createApiRouter } from "../src/http/api.ts";
import { createHttpServer } from "../src/http/server.ts";
import type { PullRequestCreator, PullRequestRequest } from "../src/remote.ts";
import type { RepoService } from "../src/repos.ts";
import { summarizeTask } from "../src/workflow/summary.ts";
import {
  addRemote,
  bareGit,
  branchExists,
  branchHead,
  createHarness,
  designPathFrom,
  git,
  steps,
  submitReview,
  submitPlan,
  submitTests,
  submitWork,
  TEMPLATES_DIR,
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

  test("runs up to 10 tasks at once and queues the rest until a slot frees up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const gatedCoder =
      (file: string): Step =>
      async (spec, prompt) => {
        waiting++;
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gate was never opened")), 120_000));
        await Promise.race([gate, timeout]);
        await writeFile(file, `${file}\n`)(spec, prompt);
        await submitWork(`wrote ${file}`)(spec, prompt);
      };
    const count = 11;
    const files = Array.from({ length: count }, (_, index) => `f${index + 1}.txt`);
    const h = createHarness({ coder: files.map(gatedCoder), "code-reviewer": files.map(() => submitReview("approve")) });
    try {
      assert.equal(h.store.settings.maxConcurrency, 10, "10 parallel tasks by default");
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        ids.push((await h.runner.submit({ description: `Task ${index + 1}`, kind: "coding", repoId: "sample" })).id);
      }
      await waitFor(() => waiting === 10, 90_000);
      const statuses = ids.map((id) => h.store.getTask(id)!.status);
      assert.deepEqual(statuses.slice(0, 10), Array(10).fill("running"));
      assert.equal(statuses[10], "queued", "the 11th task waits for a free slot");
      assert.deepEqual({ running: h.runner.overview().running, queued: h.runner.overview().queued }, { running: 10, queued: 1 });
      release();
      await h.runner.idle();
      const tasks = ids.map((id) => h.store.getTask(id)!);
      assert.deepEqual(tasks.map((task) => task.status), Array(count).fill("completed"));
      const firstFinish = Math.min(...tasks.slice(0, 10).map((task) => Date.parse(task.finishedAt!)));
      assert.ok(Date.parse(tasks[10]!.startedAt!) >= firstFinish, "the queued task starts only after a running one finishes");
      h.store.updateSettings({ maxConcurrency: 50 });
      assert.equal(h.runner.capacity(), 10, "a hand-edited setting cannot exceed the cap");
    } finally {
      release();
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
      assert.equal((await h.runner.document(task.id, 1)).content, "# Design v1\n");
      assert.match((await h.runner.document(task.id)).content ?? "", /Design v2/);
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
      assert.match(rejection?.message ?? "", /is missing or empty/);
      assert.equal(h.store.tasks[0]!.result?.approved, true);
    } finally {
      h.cleanup();
    }
  });
});

describe("HTML documents", () => {
  const templates = loadDocTemplates(TEMPLATES_DIR);

  test("design: the hub seeds the light HTML template and rejects it until every placeholder is filled", async () => {
    let docPath = "";
    const rejections: string[] = [];
    const h = createHarness(
      {
        designer: [
          async (spec, prompt) => {
            if (spec.submit.kind !== "work") throw new Error("unexpected");
            docPath = designPathFrom(prompt);
            const file = path.join(spec.workingDirectory, docPath);
            const seeded = fs.readFileSync(file, "utf8");
            assert.match(seeded, /<h1>Cache &amp; queue design<\/h1>/);
            assert.match(seeded, /data-placeholder/);
            assert.match(prompt, /light-themed HTML template/);
            for (const content of [seeded, seeded.replace("<p data-placeholder>", "<p>")]) {
              fs.writeFileSync(file, content);
              await Promise.resolve(spec.submit.onSubmit({ summary: "too early" })).catch((error: Error) => rejections.push(error.message));
            }
            fs.writeFileSync(file, seeded.replaceAll(" data-placeholder", "").replace("</h1>", "</h1>\n<p>Filled in.</p>"));
            await spec.submit.onSubmit({ summary: "Filled in the design" });
          },
        ],
        "design-reviewer": [submitReview("approve")],
      },
      { settings: { docFormat: "html" }, docTemplates: templates },
    );
    try {
      const created = await h.runner.submit({ description: "Design it", kind: "design", repoId: "sample", title: "Cache & queue design" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(docPath, "docs/designs/t-001-cache-queue-design.html");
      assert.match(rejections[0]!, /unmodified template/);
      assert.match(rejections[1]!, /template placeholder elements/);
      assert.equal(rejections.length, 2);
      assert.equal(task.stages[0]!.docFormat, "html");
      assert.equal(task.result?.docPath, docPath);
      assert.equal(task.result?.docFormat, "html");
      const doc = await h.runner.document(task.id);
      assert.equal(doc.format, "html");
      assert.deepEqual(doc.rounds, [1]);
      assert.match(doc.content ?? "", /Filled in\./);
      assert.ok(fs.existsSync(path.join(h.store.taskDir(task.id), "doc-r1.html")));
      assert.match(git(h.repoPath, "show", `${task.branch}:${docPath}`), /Filled in\./);
      const reviewerPrompt = h.driver.prompts["design-reviewer"]![0]!;
      assert.match(reviewerPrompt, /light-themed HTML page/);
      assert.match(reviewerPrompt, /template styles omitted/);
      assert.doesNotMatch(reviewerPrompt, /--blue-soft/);
      assert.match(h.driver.specsFor("designer")[0]!.systemPrompt, /data-placeholder/);
    } finally {
      h.cleanup();
    }
  });

  test("document task: technical writer and doc reviewer iterate on an HTML document", async () => {
    let docPath = "";
    const fill = (extra: string): Step => (spec) => {
      const file = path.join(spec.workingDirectory, docPath);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(" data-placeholder", "").replace("</h1>", `</h1>\n${extra}`));
    };
    const h = createHarness(
      {
        writer: [
          steps((_spec, prompt) => {
            docPath = designPathFrom(prompt);
          }, fill("<p>Quick start</p>"), submitWork("Wrote the guide")),
          steps(fill("<p>Troubleshooting</p>"), submitWork("Added troubleshooting", [{ comment_id: "W1", status: "addressed", note: "Added" }])),
        ],
        "doc-reviewer": [submitReview("request_changes", [{ severity: "major", body: "Add troubleshooting" }]), submitReview("approve")],
      },
      { settings: { docFormat: "html", documentDir: "docs/guides" }, docTemplates: templates },
    );
    try {
      const created = await h.runner.submit({ description: "Write an onboarding guide", kind: "document", repoId: "sample", title: "Onboarding guide" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, true);
      assert.equal(docPath, "docs/guides/t-001-onboarding-guide.html");
      assert.deepEqual(task.stages.map((stage) => stage.kind), ["document"]);
      assert.deepEqual((task.agents ?? []).map((agent) => agent.role), ["writer", "doc-reviewer"]);
      assert.equal(task.stages[0]!.rounds[0]!.review!.comments[0]!.id, "W1");
      assert.equal(task.stages[0]!.rounds[0]!.review!.comments[0]!.status, "addressed");
      assert.equal(branchHead(h.repoPath, `${task.branch}--writer`), branchHead(h.repoPath, task.branch!));
      const shown = git(h.repoPath, "show", `${task.branch}:${docPath}`);
      assert.match(shown, /Quick start/);
      assert.match(shown, /Troubleshooting<\/p>/);
      assert.match(h.driver.specsFor("writer")[0]!.systemPrompt, /TECHNICAL WRITER/);
      assert.match(h.driver.specsFor("doc-reviewer")[0]!.systemPrompt, /DOCUMENTATION REVIEWER/);
      assert.match(h.driver.prompts.writer![1]!, /Update the document `docs\/guides\/t-001-onboarding-guide\.html`/);
    } finally {
      h.cleanup();
    }
  });

  test("the document viewer serves a sandboxed page that loads only the hub's local Mermaid scripts", async () => {
    const h = createHarness(
      {
        designer: [
          steps((spec, prompt) => {
            const file = path.join(spec.workingDirectory, designPathFrom(prompt));
            fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(" data-placeholder", ""));
          }, submitWork("done")),
        ],
        "design-reviewer": [submitReview("approve")],
      },
      { settings: { docFormat: "html" }, docTemplates: templates },
    );
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(free));
      });
    });
    const server = createHttpServer({
      host: "127.0.0.1",
      port,
      publicDir: path.join(import.meta.dirname, "..", "public"),
      router: createApiRouter({
        store: h.store,
        bus: h.bus,
        runner: h.runner,
        copilot: {} as CopilotService,
        repos: {} as RepoService,
        version: "test",
      }),
    });
    try {
      const created = await h.runner.submit({ description: "Design", kind: "design", repoId: "sample" });
      await h.runner.idle();
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${port}`;
      const response = await fetch(`${origin}/api/tasks/${created.id}/doc/view`);
      assert.equal(response.status, 200);
      const csp = response.headers.get("content-security-policy") ?? "";
      assert.match(csp, /sandbox allow-scripts/);
      assert.ok(csp.includes(`script-src ${origin};`), csp);
      assert.ok(csp.includes(`frame-ancestors ${origin};`), csp);
      assert.equal(response.headers.get("x-frame-options"), null);
      const html = await response.text();
      assert.doesNotMatch(html, /cdn\.jsdelivr/);
      assert.match(html, /<script src="\/vendor\/mermaid\.min\.js"><\/script>\n<script src="\/lib\/doc-viewer\.js"><\/script>\n<\/body>/);
      const vendor = await fetch(`${origin}/lib/doc-viewer.js`);
      assert.equal(vendor.status, 200);
    } finally {
      server.close();
      h.cleanup();
    }
  });
});

describe("manager", () => {
  test("logs its communication with sub-agents: spawn, assign, submit, relay, verdict, release", async () => {
    const h = createHarness({
      coder: [steps(writeFile("a.txt", "a\n"), submitWork("Add a"))],
      resolver: [steps(writeFile("a.txt", "b\n"), submitWork("Use b", [{ comment_id: "C1", status: "addressed", note: "Done" }]))],
      "code-reviewer": [submitReview("request_changes", [{ severity: "minor", body: "Use b" }]), submitReview("approve")],
    });
    const streamed: string[] = [];
    h.bus.onGlobal((message) => {
      if (message.type === "comm") streamed.push(message.entry.kind);
    });
    try {
      const created = await h.runner.submit({ description: "Add a", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const log = h.store.recentComm({ taskId: created.id });
      const flow = log.map((entry) => `${entry.from}>${entry.to}:${entry.kind}`);
      assert.deepEqual(flow.filter((step) => !step.endsWith(":lifecycle")), [
        "manager>coder:spawn",
        "manager>coder:assign",
        "coder>manager:submit",
        "manager>code-reviewer:spawn",
        "manager>code-reviewer:relay",
        "code-reviewer>manager:verdict",
        "manager>resolver:spawn",
        "manager>resolver:assign",
        "resolver>manager:submit",
        "manager>code-reviewer:relay",
        "code-reviewer>manager:verdict",
        "manager>coder:release",
        "manager>code-reviewer:release",
        "manager>resolver:release",
      ]);
      assert.equal(flow[0], "user>manager:lifecycle");
      assert.equal(flow.at(-1), "manager>user:lifecycle");
      assert.match(log.at(-1)!.text, /Completed: approved/);
      assert.match(log.find((entry) => entry.kind === "verdict")!.text, /Requested changes: 1 comment \(1 minor\)/);
      assert.match(log.find((entry) => entry.from === "resolver")!.text, /1 addressed, 0 declined/);
      assert.deepEqual(log.map((entry) => entry.seq), [...log.map((entry) => entry.seq)].sort((a, b) => a - b));
      assert.equal(streamed.length, log.length);
      const overview = h.runner.overview();
      assert.equal(overview.online, true);
      assert.equal(overview.running, 0);
      assert.equal(overview.comm.length, log.length);
    } finally {
      h.cleanup();
    }
  });

  test("checks in on an agent that has been silent for too long", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = createHarness({
      coder: [steps(async () => gate, writeFile("x.txt", "x\n"), submitWork("x"))],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Slow work", kind: "coding", repoId: "sample" });
      await waitFor(() => h.store.getTask(created.id)?.agents?.some((agent) => agent.role === "coder" && agent.status === "working") ?? false);
      h.runner.checkOnAgents(Date.now() + 6 * 60_000);
      h.runner.checkOnAgents(Date.now() + 7 * 60_000);
      const checkIns = h.store.recentComm({ taskId: created.id }).filter((entry) => entry.kind === "monitor");
      assert.equal(checkIns.length, 1, "one check-in per silent period");
      assert.equal(checkIns[0]!.to, "coder");
      assert.match(checkIns[0]!.text, /no new activity for 6 min/);
      assert.ok(h.runner.overview().lastCheckAt);
      release();
      await h.runner.idle();
      assert.equal(h.store.getTask(created.id)!.status, "completed");
    } finally {
      release();
      h.cleanup();
    }
  });

  test("resumes tasks interrupted by a hub restart once signed in", async () => {
    const h = createHarness(
      {
        coder: [steps(writeFile("r.txt", "r\n"), submitWork("resumed work"))],
        "code-reviewer": [submitReview("approve")],
      },
      { ready: false },
    );
    try {
      const created = await h.runner.submit({ description: "Resume me", kind: "coding", repoId: "sample" });
      const disabled = await h.runner.submit({ description: "Leave me", kind: "coding", repoId: "sample" });
      // Simulate a hub that stopped while both tasks were running.
      for (const id of [created.id, disabled.id]) h.store.getTask(id)!.status = "running";
      h.store.getTask(disabled.id)!.autoResumes = 3;
      const restarted = h.newRunner();
      restarted.init();
      assert.equal(h.store.getTask(created.id)!.status, "interrupted");
      restarted.pump();
      assert.equal(h.store.getTask(created.id)!.status, "interrupted", "waits until the runtime is signed in");
      h.setReady(true);
      restarted.pump();
      await restarted.idle();
      await restarted.shutdown();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.attempt, 2);
      assert.equal(task.autoResumes, undefined);
      assert.equal(h.store.getTask(disabled.id)!.status, "interrupted", "gives up after repeated automatic resumes");
      assert.ok(h.store.recentComm({ taskId: created.id }).some((entry) => /Resuming after the hub restart/.test(entry.text)));
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

describe("execute & verify", () => {
  const BUGGY = "export const add = (a, b) => a - b;\n";
  const FIXED = "export const add = (a, b) => a + b;\n";
  // Worktrees honor the machine's core.autocrlf, so compare file contents without line-ending differences.
  const read = (spec: { workingDirectory: string }, file: string) => fs.readFileSync(path.join(spec.workingDirectory, file), "utf8").replace(/\r\n/g, "\n");

  test("the executor runs and triages, the fixer fixes on its own branch, and a re-run verifies the fix", async () => {
    const h = createHarness(
      {
        executor: [
          steps((spec, prompt) => {
            assert.match(prompt, /## Run 1: run the test automation and verify the results/);
            assert.equal(read(spec, "calc.js"), BUGGY, "the executor tests the task branch as it is");
          }, submitTests(
            "failed",
            [{ test: "add adds two numbers", file: "calc.test.js", line: 3, error: "Expected 3, received -1", category: "product-bug", suggestion: "add() subtracts" }],
            { total: 2, passed: 1, failed: 1 },
          )),
          steps((spec, prompt) => {
            assert.match(prompt, /## Run 2: verify the test fixer's fixes/);
            assert.match(prompt, /\+export const add = \(a, b\) => a \+ b;/, "the executor sees the fix diff to check its integrity");
            assert.match(prompt, /\[T1\] \(product-bug\) add adds two numbers\n  -> addressed: Use \+/);
            assert.equal(read(spec, "calc.js"), FIXED, "the re-run is pinned to the fixer's commit");
          }, submitTests("passed", [], { total: 2, passed: 2, failed: 0 })),
        ],
        fixer: [
          steps((_spec, prompt) => {
            assert.match(prompt, /## Round 2: fix the test failures/);
            assert.match(prompt, /\[T1\] \(product-bug\) add adds two numbers - calc\.test\.js:3/);
            assert.match(prompt, /Expected 3, received -1/);
            assert.match(prompt, /Commands the executor ran:\n```\nnpm test/);
          }, writeFile("calc.js", FIXED), submitWork("Fixed add()", [{ comment_id: "T1", status: "addressed", note: "Use +" }])),
        ],
      },
      { files: { "calc.js": BUGGY, "calc.test.js": "// tests\n" } },
    );
    try {
      const created = await h.runner.submit({ description: "Run the unit tests and fix any failures", kind: "testing", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, true);
      assert.deepEqual(task.result?.tests, { status: "passed", commands: ["npm test"], total: 2, passed: 2, failed: 0, skipped: undefined, logExcerpt: undefined });
      assert.equal(task.result?.openComments, 0);
      const [first, second] = task.stages[0]!.rounds;
      assert.equal(first!.author, undefined, "round 1 is a run only");
      assert.equal(first!.review!.testRun!.status, "failed");
      assert.deepEqual(
        first!.review!.comments.map(({ id, category, test, status, severity }) => ({ id, category, test, status, severity })),
        [{ id: "T1", category: "product-bug", test: "add adds two numbers", status: "addressed", severity: "blocker" }],
      );
      assert.equal(second!.author!.role, "fixer");
      assert.equal(second!.review!.verdict, "approve");
      assert.equal(branchHead(h.repoPath, `${task.branch}--fixer`), branchHead(h.repoPath, task.branch!));
      assert.equal(git(h.repoPath, "show", `${task.branch}:calc.js`), FIXED.trim());
      assert.deepEqual((task.agents ?? []).map((agent) => agent.role), ["executor", "fixer"]);
      const [executor] = h.driver.specsFor("executor");
      const [fixer] = h.driver.specsFor("fixer");
      assert.equal(executor!.executeOnly, true);
      assert.equal(executor!.readOnly, false);
      assert.equal(path.basename(executor!.workingDirectory), "run", "the executor has its own checkout");
      assert.equal(path.basename(fixer!.workingDirectory), "author");
      assert.equal(executor!.submit.kind, "test");
      assert.equal(executor!.model, "fake-reviewer", "the executor verifies with the reviewer model");
      assert.match(executor!.systemPrompt, /ROLE: TEST EXECUTOR AND VERIFIER/);
      assert.match(fixer!.systemPrompt, /ROLE: TEST FIXER/);
      const verdicts = h.store.recentComm({ taskId: task.id }).filter((entry) => entry.kind === "verdict").map((entry) => entry.text);
      assert.match(verdicts[0]!, /^Failed: 1 of 2 \(1 product-bug\)/);
      assert.match(verdicts[1]!, /^Passed: 2 tests/);
    } finally {
      h.cleanup();
    }
  });

  test("stops instead of re-running unchanged code when the fixer can only decline", async () => {
    const h = createHarness({
      executor: [submitTests("blocked", [{ test: "Pester tests", error: "Invoke-Pester is not recognized", category: "environment" }])],
      fixer: [submitWork("Needs Pester", [{ comment_id: "T1", status: "declined", note: "Install the Pester module on the runner" }])],
    });
    try {
      const created = await h.runner.submit({ description: "Run the Pester tests", kind: "testing", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, false);
      assert.equal(task.stages[0]!.status, "not-approved");
      assert.equal(task.result?.openComments, 1, "declined failures still count as failing");
      assert.equal(task.result?.tests?.status, "blocked");
      assert.equal(h.driver.prompts.executor!.length, 1, "no pointless re-run");
      assert.ok(h.store.recentComm({ taskId: task.id }).some((entry) => /could not fix the remaining 1 failure/.test(entry.text)));
    } finally {
      h.cleanup();
    }
  });
});

describe("manager planning (auto tasks)", () => {
  test("the manager plans the stages, creates those agents and hands each its assignment", async () => {
    const h = createHarness(
      {
        planner: [
          steps((spec, prompt) => {
            assert.equal(spec.readOnly, true);
            assert.equal(spec.submit.kind, "plan");
            assert.match(spec.systemPrompt, /You are the MANAGER/);
            assert.match(prompt, /## Plan this task/);
            assert.match(prompt, /`npm test`/, "the planner sees the detected test commands");
          }, submitPlan(["tests", "implementation"], { coding: "Add mul(a, b) to calc.js with a unit test", testing: "Run `npm test`; all tests must pass" })),
        ],
        coder: [
          steps((_spec, prompt) => {
            assert.match(prompt, /## Manager's assignment for this stage\n\nAdd mul\(a, b\) to calc\.js/);
          }, writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()")),
        ],
        "code-reviewer": [submitReview("approve")],
        executor: [
          steps((_spec, prompt) => {
            assert.match(prompt, /## Manager's assignment for this stage\n\nRun `npm test`; all tests must pass/);
            assert.match(prompt, /calc\.js \| 1 \+/, "the executor knows what changed on the task branch");
          }, submitTests("passed", [], { total: 3 })),
        ],
      },
      { files: { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) } },
    );
    try {
      const created = await h.runner.submit({ description: "Add multiplication support and make sure the tests pass", kind: "auto", repoId: "sample" });
      assert.deepEqual(h.store.getTask(created.id)!.stages, [], "stages are unknown until the manager plans");
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.deepEqual(task.plan?.stages, ["coding", "testing"], "aliases are normalized and stages ordered");
      assert.equal(task.plan?.fallback, undefined);
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [["coding", "approved"], ["testing", "approved"]]);
      assert.deepEqual((task.agents ?? []).map((agent) => [agent.role, agent.status]), [
        ["planner", "done"],
        ["coder", "done"],
        ["code-reviewer", "done"],
        ["executor", "done"],
      ]);
      assert.equal(task.managerModel, "fake-author", "the manager plans with the author model by default");
      assert.equal(path.basename(h.driver.specsFor("planner")[0]!.workingDirectory), "review");
      assert.equal(task.result?.approved, true);
      assert.match(task.result?.summary ?? "", /\*\*Coding:\*\* Added mul\(\)/);
      assert.match(task.result?.summary ?? "", /\*\*Execute & verify:\*\* Tests passed/);
      const comm = h.store.recentComm({ taskId: task.id });
      assert.ok(comm.some((entry) => entry.kind === "plan" && entry.from === "planner" && /^Plan: Coding → Execute & verify/.test(entry.text)));
      assert.ok(comm.some((entry) => /^Creating sub-agents: Coder, Code reviewer, Test executor; on demand: Comment resolver, Test fixer$/.test(entry.text)));
    } finally {
      h.cleanup();
    }
  });

  test("falls back to a keyword plan when the planner never submits one", async () => {
    const h = createHarness({
      planner: [() => {}, () => {}, () => {}],
      writer: [steps((spec, prompt) => writeFile(designPathFrom(prompt), "# API guide\n")(spec, prompt), submitWork("Wrote the guide"))],
      "doc-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Write documentation for the public API", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(h.driver.prompts.planner!.length, 3, "the planner was nudged twice");
      assert.deepEqual(task.plan?.stages, ["document"]);
      assert.equal(task.plan?.fallback, true);
      assert.equal(task.result?.approved, true);
    } finally {
      h.cleanup();
    }
  });
});

describe("push & pull requests", () => {
  const pushedComms = (h: ReturnType<typeof createHarness>, taskId: string) =>
    h.store.recentComm({ taskId }).filter((entry) => entry.from === "manager" && entry.to === "user" && entry.text.startsWith("Pushed the task branch"));

  test("pushes the finished task's branch to the remote, then opens a pull request once", async () => {
    const requests: PullRequestRequest[] = [];
    const creator: PullRequestCreator = {
      canCreate: async (remote) => remote.provider === "github",
      findOpen: async () => null,
      create: async (_remote, request) => {
        requests.push(request);
        return { url: "https://github.com/acme/sample/pull/7", number: 7, draft: request.draft };
      },
    };
    const h = createHarness(
      {
        coder: [steps(writeFile("a.txt", "a\n"), submitWork("Add a"))],
        resolver: [steps(writeFile("a.txt", "b\n"), submitWork("Use b", [{ comment_id: "C1", status: "addressed", note: "Done" }]))],
        "code-reviewer": [submitReview("request_changes", [{ severity: "minor", body: "Use b" }]), submitReview("approve")],
      },
      { pullRequests: creator },
    );
    try {
      const bare = addRemote(h);
      const created = await h.runner.submit({ description: "Add a file named a.txt", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.push?.status, "pushed");
      assert.equal(task.push?.auto, true);
      assert.equal(task.push?.remote, "origin");
      assert.equal(task.push?.sha, branchHead(h.repoPath, task.branch!));
      assert.equal(task.push?.webUrl, `https://github.com/acme/sample/tree/${task.branch}`);
      // Only the task branch goes to the remote; the agents' own branches stay local.
      assert.equal(bareGit(bare, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), `refs/heads/${task.branch} ${task.push?.sha}`);
      assert.equal(pushedComms(h, task.id).length, 1);
      assert.deepEqual(summarizeTask(task).push, { status: "pushed", remote: "origin", branch: task.branch, webUrl: task.push?.webUrl, reason: undefined });

      const status = await h.runner.pullRequestStatus(task.id);
      assert.deepEqual([status.remote?.provider, status.remote?.url, status.direct, status.supported], ["github", "https://github.com/acme/sample.git", true, true]);

      const outcome = await h.runner.pullRequest(task.id);
      assert.equal(outcome.pullRequest?.number, 7);
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.deepEqual([request!.head, request!.base, request!.title, request!.draft], [task.branch, "main", task.title, false]);
      assert.match(request!.body, /> Add a file named a\.txt/);
      assert.match(request!.body, /\*\*Outcome:\*\* approved by the reviewer/);
      assert.equal(pushedComms(h, task.id).length, 1, "the branch was already up to date, so it was not pushed again");
      assert.equal(task.pullRequest?.url, "https://github.com/acme/sample/pull/7");
      assert.equal(task.pullRequest?.base, "main");
      assert.ok(h.store.recentComm({ taskId: task.id }).some((entry) => entry.text === "Opened pull request #7 into main"));

      const again = await h.runner.pullRequest(task.id);
      assert.equal(again.pullRequest?.number, 7);
      assert.equal(requests.length, 1, "asking again returns the recorded pull request");
      assert.equal(summarizeTask(task).pullRequest?.number, 7);
    } finally {
      h.cleanup();
    }
  });

  test("failed pushes can be retried, and without the GitHub CLI the host's create page is offered", async () => {
    const h = createHarness(
      { coder: [steps(writeFile("b.txt", "b\n"), submitWork("Add b"))], "code-reviewer": [submitReview("request_changes", [{ severity: "major", body: "Needs tests" }])] },
      { settings: { maxRounds: 1 } },
    );
    try {
      const bare = addRemote(h);
      git(h.repoPath, "config", "remote.origin.pushurl", path.join(h.root, "missing.git"));
      const created = await h.runner.submit({ description: "Add b", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, false);
      assert.equal(task.push?.status, "failed");
      assert.match(task.push?.reason ?? "", /does not appear to be a git repository|not found|No such/i);
      assert.ok(h.store.recentComm({ taskId: task.id }).some((entry) => entry.text.startsWith("Could not push origin/")));

      // A hub restart in the middle of a push leaves a retryable failure rather than a stuck "pushing".
      task.push = { ...task.push!, status: "pushing" };
      const restarted = h.newRunner();
      restarted.init();
      await restarted.shutdown();
      assert.equal(task.push?.status, "failed");
      assert.match(task.push?.reason ?? "", /hub stopped/);

      git(h.repoPath, "config", "remote.origin.pushurl", bare);
      const retried = await h.runner.pushNow(task.id);
      assert.equal(retried.push?.status, "pushed");
      assert.equal(retried.push?.auto, false);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), branchHead(h.repoPath, task.branch!));

      const status = await h.runner.pullRequestStatus(task.id);
      assert.deepEqual([status.direct, status.supported], [false, true]);
      const outcome = await h.runner.pullRequest(task.id);
      assert.equal(outcome.pullRequest, undefined);
      const url = new URL(outcome.createUrl!);
      assert.equal(`${url.origin}${url.pathname}`, `https://github.com/acme/sample/compare/main...${task.branch}`);
      assert.equal(url.searchParams.get("title"), task.title);
      assert.match(url.searchParams.get("body") ?? "", /not approved — 1 open comment/);
      assert.equal(task.pullRequest, undefined);
    } finally {
      h.cleanup();
    }
  });

  test("nothing is pushed without a remote, or when automatic pushes are off", async () => {
    const h = createHarness({
      coder: [steps(writeFile("c.txt", "c\n"), submitWork("Add c")), steps(writeFile("d.txt", "d\n"), submitWork("Add d"))],
      "code-reviewer": [submitReview("approve"), submitReview("approve")],
    });
    try {
      const first = await h.runner.submit({ description: "Add c", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const noRemote = h.store.getTask(first.id)!;
      assert.equal(noRemote.push?.status, "skipped");
      assert.match(noRemote.push?.reason ?? "", /No git remote/);
      assert.deepEqual(await h.runner.pullRequestStatus(noRemote.id), { remote: null, direct: false, supported: false, pullRequest: undefined });
      await assert.rejects(h.runner.pullRequest(noRemote.id), /No git remote is configured/);

      const bare = addRemote(h, "C:\\shares\\sample.git");
      h.store.updateSettings({ pushOnComplete: false });
      const second = await h.runner.submit({ description: "Add d", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const manual = h.store.getTask(second.id)!;
      assert.equal(manual.status, "completed");
      assert.equal(manual.push, undefined);
      assert.equal(bareGit(bare, "for-each-ref", "refs/heads"), "");
      // A remote without a web page can still be pushed to, but offers no pull request page.
      const pushed = (await h.runner.pushNow(manual.id)).push;
      assert.equal(pushed?.status, "pushed");
      assert.equal(pushed?.webUrl, undefined);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${manual.branch}`), branchHead(h.repoPath, manual.branch!));
      assert.equal((await h.runner.pullRequestStatus(manual.id)).supported, false);
      await assert.rejects(h.runner.pullRequest(manual.id), /not supported for this remote/);
    } finally {
      h.cleanup();
    }
  });
});
