import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
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
  test("iterates author -> reviewer until approval and commits each round", async () => {
    const h = createHarness({
      coder: [
        steps(writeFile("hello.js", "export const hello = () => 'hi';\n"), submitWork("Add hello()")),
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
      const stage = task.stages[0]!;
      assert.equal(stage.status, "approved");
      assert.equal(stage.rounds.length, 2);
      const comment = stage.rounds[0]!.review!.comments[0]!;
      assert.equal(comment.id, "C1");
      assert.equal(comment.status, "addressed");
      assert.equal(comment.response, "hello() now takes a name");

      // Revision prompt carries the open comment; re-review prompt carries the response.
      assert.match(h.driver.prompts.coder![1]!, /\[C1\] \(major\) hello\.js:1/);
      assert.match(h.driver.prompts["code-reviewer"]![1]!, /addressed: hello\(\) now takes a name/);
      assert.match(h.driver.prompts["code-reviewer"]![0]!, /\+export const hello/);

      // Reviewer agents are read-only, authors are not.
      assert.equal(h.driver.started.find((spec) => spec.role === "code-reviewer")?.readOnly, true);
      assert.equal(h.driver.started.find((spec) => spec.role === "coder")?.readOnly, false);

      // Work happened on an isolated branch/worktree; the user's checkout is untouched.
      assert.ok(task.branch?.startsWith("agent-hub/t-001-"));
      assert.equal(git(h.repoPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
      assert.equal(fs.existsSync(path.join(h.repoPath, "hello.js")), false);
      assert.match(git(h.repoPath, "show", `${task.branch}:hello.js`), /hi \$\{name\}/);
      assert.match(git(h.repoPath, "log", "-1", "--format=%B", task.branch!), /Co-authored-by: Copilot/);

      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.type === "phase" && event.text === "Addressing review comments"));
      assert.ok(events.some((event) => event.type === "review" && /Approved/.test(event.text)));
    } finally {
      h.cleanup();
    }
  });

  test("stops after the round budget without approval, then continues on retry", async () => {
    const changes: Step = submitReview("request_changes", [{ severity: "major", body: "Still wrong" }]);
    const h = createHarness(
      {
        coder: [
          steps(writeFile("a.txt", "1\n"), submitWork("first")),
          steps(writeFile("a.txt", "2\n"), submitWork("second", [{ comment_id: "C1", status: "addressed", note: "fixed" }])),
          steps(writeFile("a.txt", "3\n"), submitWork("third", [{ comment_id: "C2", status: "declined", note: "out of scope" }])),
        ],
        "code-reviewer": [changes, changes, submitReview("approve")],
      },
      { maxRounds: 2 },
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
      // The resumed author session gets the full context plus the open comment.
      const resumedPrompt = h.driver.prompts.coder![2]!;
      assert.match(resumedPrompt, /## Request/);
      assert.match(resumedPrompt, /being resumed/);
      assert.match(resumedPrompt, /\[C2\]/);
    } finally {
      h.cleanup();
    }
  });

  test("rejects submissions that skip open comments, so the agent must respond to each", async () => {
    let rejection: Error | undefined;
    const h = createHarness({
      coder: [
        steps(writeFile("b.txt", "x\n"), submitWork("first")),
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
      await waitFor(() => h.store.getTask(created.id)?.phase === "authoring");
      h.runner.cancel(created.id);
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "cancelled");
      assert.equal(task.stages[0]!.status, "cancelled");
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
      assert.equal((await h.runner.design(task.id, 1)).content, "# Design v1\n");
      assert.match((await h.runner.design(task.id)).content ?? "", /Design v2/);
      // The re-review shows the document diff between rounds.
      assert.match(h.driver.prompts["design-reviewer"]![1]!, /\+## Risks/);
    } finally {
      h.cleanup();
    }
  });

  test("design -> coding: the coder receives the approved design", async () => {
    let docPath = "";
    const h = createHarness({
      designer: [
        steps((spec, prompt) => {
          docPath = designPathFrom(prompt);
          return writeFile(docPath, "# Plan\nCreate impl.txt\n")(spec, prompt);
        }, submitWork("plan")),
      ],
      "design-reviewer": [submitReview("approve")],
      coder: [steps(writeFile("impl.txt", "done\n"), submitWork("implemented"))],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Plan and build", kind: "design-coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.deepEqual(task.stages.map((stage) => stage.status), ["approved", "approved"]);
      assert.equal(task.result?.commits, 2);
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
