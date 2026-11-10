import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { findingsPrompt } from "../src/agents/reviewPrompts.ts";
import { applyChangePlan, normalizeChangePlan } from "../src/workflow/changes.ts";
import { summarizeTask } from "../src/workflow/summary.ts";
import type { ChangeRequest, Stage, Task } from "../src/types.ts";
import {
  createHarness,
  designPathFrom,
  git,
  hang,
  steps,
  submitChangePlan,
  submitPlan,
  submitReview,
  submitTests,
  submitWork,
  waitFor,
  writeFile,
  type Step,
} from "./helpers.ts";

const crash: Step = () => {
  throw new Error("Session disconnected while waiting for a response");
};

/** Every manager log line of a task, as "from>to:kind:text". */
const commOf = (h: ReturnType<typeof createHarness>, taskId: string) =>
  h.store.recentComm({ taskId, limit: 1000 }).map((entry) => `${entry.from}>${entry.to}:${entry.kind}:${entry.text}`);

describe("change requests re-planned by the manager", () => {
  test("a finished design task is switched to code: the design stays, a coding team is created to implement it", async () => {
    const h = createHarness({
      designer: [steps((spec, prompt) => writeFile(designPathFrom(prompt), "# Cache design\n\nUse an LRU cache with 100 entries.\n")(spec, prompt), submitWork("Designed an LRU cache"))],
      "design-reviewer": [submitReview("approve")],
      planner: [
        steps((spec, prompt) => {
          assert.equal(spec.readOnly, true);
          assert.match(prompt, /## Re-plan the task for change request U1\n/);
          assert.match(prompt, /## Change requests the user made afterwards/);
          assert.match(prompt, /- \[U1\] \(current\) Now implement the design in cache\.js/);
          assert.match(prompt, /- Type: Design; stages: Design\. When the user asked for U1, it had finished\./);
          assert.match(prompt, /- Design stage: approved in round 1; deliverable `docs\/designs\/[^`]+\.md`\./);
          assert.match(prompt, /- Task branch `agent-hub\/t-001-[^`]+` at [0-9a-f]{10}: 1 commit\(s\) \(1 file changed, 3 insertions\(\+\)\) since the base `main`/);
        }, submitChangePlan(["design", "coding"], undefined, { coding: "Implement the LRU cache from the approved design in cache.js, with a unit test" }, "The design is approved; implementing it needs the coding team.")),
      ],
      coder: [
        steps((_spec, prompt) => {
          assert.match(prompt, /- \[U1\] \(current\) Now implement the design in cache\.js/);
          assert.match(prompt, /## Manager's assignment for this stage\n\nImplement the LRU cache from the approved design in cache\.js, with a unit test/);
          assert.match(prompt, /## Approved design/);
          assert.match(prompt, /Use an LRU cache with 100 entries/);
        }, writeFile("cache.js", "export class LruCache {}\n"), submitWork("Implemented the LRU cache")),
      ],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Design a cache for the uploader", kind: "design", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");

      h.runner.requestChanges(task.id, { request: "Now implement the design in cache.js" });
      assert.equal(task.changeRequests?.[0]?.pending, true);
      await h.runner.idle();

      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.result?.approved, true);
      assert.equal(task.kind, "design-coding", "the task type follows its stages");
      assert.deepEqual(task.plan?.stages, ["design", "coding"]);
      assert.equal(task.plan?.instructions.coding, "Implement the LRU cache from the approved design in cache.js, with a unit test");
      const request = task.changeRequests![0]!;
      assert.deepEqual([request.routing, request.pending, request.stage, request.round, request.from], ["manager", undefined, "coding", undefined, "completed"]);
      assert.deepEqual(
        { ...request.plan!, plannedAt: "" },
        {
          previous: ["design"],
          stages: ["design", "coding"],
          added: ["coding"],
          dropped: [],
          kind: { from: "design", to: "design-coding" },
          rationale: "The design is approved; implementing it needs the coding team.",
          plannedAt: "",
        },
      );
      const [design, coding] = task.stages;
      assert.deepEqual([design!.kind, design!.status, design!.rounds.length], ["design", "approved", 1], "the design is kept as it was");
      assert.deepEqual([coding!.kind, coding!.status, coding!.rounds.map((round) => round.author?.role)], ["coding", "approved", ["coder"]]);
      assert.equal(h.driver.prompts.designer?.length, 1, "the designer was not asked again");
      assert.match(git(h.repoPath, "show", `${task.branch}:cache.js`), /LruCache/);
      assert.match(task.result?.designDocPath ?? "", /^docs\/designs\/.+\.md$/);
      assert.equal(task.managerModel, "fake-author", "a fixed-kind task re-plans with the manager model (the author model by default)");
      assert.deepEqual(
        (task.agents ?? []).map((agent) => [agent.role, agent.status]),
        [
          ["designer", "done"],
          ["design-reviewer", "done"],
          ["planner", "done"],
          ["coder", "done"],
          ["code-reviewer", "done"],
        ],
      );
      const comm = commOf(h, task.id);
      for (const line of [
        "user>manager:lifecycle:Change request U1: Now implement the design in cache.js - the manager re-evaluates the task for it",
        "manager>manager:lifecycle:Re-evaluating the task for change request U1: which teams handle it",
        "manager>planner:assign:Re-plan the task for change request U1: decide which teams handle it and write their assignments",
        "planner>manager:plan:Re-plan for U1: adds Coding (the task becomes Design → Coding) - The design is approved; implementing it needs the coding team.",
        "manager>manager:lifecycle:Creating sub-agents: Coder, Code reviewer; on demand: Comment resolver",
      ]) {
        assert.ok(comm.includes(line), line);
      }
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.role === "planner" && event.text === "Manager's re-plan for U1: adds Coding (the task becomes Design → Coding). The design is approved; implementing it needs the coding team."));
      assert.equal(summarizeTask(task).kind, "design-coding");
    } finally {
      h.cleanup();
    }
  });

  test("a failed task takes a change request: the manager hands it to the team that failed, which revises its work", async () => {
    const h = createHarness({
      coder: [steps(writeFile("greet.js", "let greet = () => 'hi';\nexport { greet };\n"), submitWork("Added greet()"))],
      "code-reviewer": [
        crash,
        crash,
        crash,
        crash,
        steps((_spec, prompt) => {
          assert.match(prompt, /The user later asked for the changes below/);
          assert.match(prompt, /- \[U1\] \(change request\) Declare greet with const\n  -> addressed: Uses const/);
        }, submitReview("approve")),
      ],
      planner: [
        steps((_spec, prompt) => {
          assert.match(prompt, /When the user asked for U1, it had failed: Code reviewer could not be recovered after 3 attempts/);
          assert.match(prompt, /- Coding stage: failed in round 1\./);
        }, submitChangePlan(["coding"], "coding", { coding: "Declare greet() with const and keep the export" }, "The code exists; the coding team changes it.")),
      ],
      resolver: [
        steps(
          (_spec, prompt) => {
            assert.match(prompt, /## Round 3: make the changes the user requested/);
            assert.match(prompt, /## Manager's assignment for this stage\n\nDeclare greet\(\) with const and keep the export/);
          },
          writeFile("greet.js", "const greet = () => 'hi';\nexport { greet };\n"),
          submitWork("Declared greet with const", [{ comment_id: "U1", status: "addressed", note: "Uses const" }]),
        ),
      ],
    });
    try {
      const created = await h.runner.submit({ description: "Add a greet function", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "failed");

      h.runner.requestChanges(task.id, { request: "Declare greet with const" });
      const request = task.changeRequests![0]!;
      assert.deepEqual([request.from, request.pending, task.attempt], ["failed", true, 2]);
      assert.match(request.failure ?? "", /^Code reviewer could not be recovered after 3 attempts/);
      await h.runner.idle();

      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.result?.approved, true);
      assert.equal(task.kind, "coding");
      assert.deepEqual([request.stage, request.round, request.plan?.added, request.plan?.dropped, request.plan?.kind], ["coding", 2, [], [], undefined]);
      assert.deepEqual(
        task.stages[0]!.rounds.map((round) => [round.n, round.author?.role ?? null, round.review?.by ?? round.review?.verdict ?? null]),
        [
          [1, "coder", null],
          [2, null, "user"],
          [3, "resolver", "approve"],
        ],
      );
      assert.match(git(h.repoPath, "show", `${task.branch}:greet.js`), /^const greet/);
    } finally {
      h.cleanup();
    }
  });

  test("a cancelled task: the manager drops the design it no longer needs, and the task becomes a Coding task", async () => {
    const h = createHarness(
      {
        planner: [
          steps((_spec, prompt) => {
            assert.match(prompt, /When the user asked for U1, it had been cancelled\./);
            assert.match(prompt, /- Design stage: not started\.\n- Coding stage: not started\./);
          }, submitChangePlan(["coding"], undefined, { coding: "Implement an LRU cache in cache.js with a unit test" }, "The user asked to skip the design.")),
        ],
        coder: [steps(writeFile("cache.js", "export class LruCache {}\n"), submitWork("Implemented the cache"))],
        "code-reviewer": [submitReview("approve")],
      },
      { ready: false },
    );
    try {
      const created = await h.runner.submit({ description: "Design and build a cache", kind: "design-coding", repoId: "sample" });
      h.runner.cancel(created.id);
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "cancelled");
      h.runner.requestChanges(task.id, { request: "Skip the design and implement the cache directly" });
      assert.deepEqual([task.status, task.attempt], ["queued", 2], "it waits for the runtime, queued");
      // A stage chosen by the user would bypass the re-plan the earlier request is waiting for.
      assert.throws(() => h.runner.requestChanges(task.id, { request: "x", stage: "coding" }), /The manager has yet to re-plan the task for U1: leave this request to the manager too/);
      h.setReady(true);
      h.runner.pump();
      await h.runner.idle();

      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.kind, "coding");
      assert.deepEqual(task.stages.map((stage) => stage.kind), ["coding"], "a stage that never ran is removed");
      const request = task.changeRequests![0]!;
      assert.deepEqual([request.from, request.stage, request.plan?.dropped, request.plan?.kind], ["cancelled", "coding", ["design"], { from: "design-coding", to: "coding" }]);
      assert.equal(h.driver.specsFor("designer").length, 0);
      assert.ok(commOf(h, task.id).includes("planner>manager:plan:Re-plan for U1: drops Design (the task becomes Coding) - The user asked to skip the design."));
    } finally {
      h.cleanup();
    }
  });

  test("a queued task takes requests before it starts: the manager's first plan covers them", async () => {
    const h = createHarness(
      {
        planner: [
          steps((_spec, prompt) => {
            assert.match(prompt, /## Plan this task/);
            assert.match(prompt, /## Change requests the user made afterwards[\s\S]*- \[U1\] \(current\) Also add division/);
          }, submitPlan(["coding"], { coding: "Add mul() and div() to calc.js" })),
        ],
        coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\nexport const div = (a, b) => a / b;\n"), submitWork("Added mul() and div()"))],
        "code-reviewer": [submitReview("approve")],
      },
      { ready: false },
    );
    try {
      const created = await h.runner.submit({ description: "Add multiplication to calc.js", kind: "auto", repoId: "sample" });
      h.runner.requestChanges(created.id, { request: "Also add division" });
      const task = h.store.getTask(created.id)!;
      assert.deepEqual([task.status, task.attempt, task.changeRequests?.[0]?.pending, task.changeRequests?.[0]?.from], ["queued", 1, true, "queued"]);
      assert.throws(() => h.runner.requestChanges(created.id, { request: "x", stage: "coding" }), /This task has no stages yet: leave the request to the manager/);
      h.setReady(true);
      h.runner.pump();
      await h.runner.idle();

      assert.equal(task.status, "completed", String(task.error));
      assert.equal(h.driver.prompts.planner?.length, 1, "one plan covers the task and the request");
      const request = task.changeRequests![0]!;
      assert.deepEqual([request.pending, request.stage, request.plan?.initial, request.plan?.stages], [undefined, "coding", true, ["coding"]]);
    } finally {
      h.cleanup();
    }
  });

  test("when the manager cannot re-plan, the change goes to the latest stage with work", async () => {
    const h = createHarness({
      coder: [steps(writeFile("a.txt", "a\n"), submitWork("Add a"))],
      "code-reviewer": [submitReview("approve"), submitReview("approve")],
      // The planner ends its turn (and both nudges) without submitting a plan.
      planner: [() => {}, () => {}, () => {}],
      resolver: [steps(writeFile("a.txt", "b\n"), submitWork("Use b", [{ comment_id: "U1", status: "addressed", note: "Done" }]))],
    });
    try {
      const created = await h.runner.submit({ description: "Add a", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      h.runner.requestChanges(task.id, { request: "Use b instead of a" });
      // While the task runs, further requests wait until it stops.
      assert.throws(() => h.runner.requestChanges(task.id, { request: "x" }), /The task is running/);
      await h.runner.idle();

      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.result?.approved, true);
      const request = task.changeRequests![0]!;
      assert.deepEqual([request.routing, request.stage, request.round, request.plan?.fallback], ["manager", "coding", 2, true]);
      assert.equal(task.plan, undefined, "a fallback changes neither the plan nor the task type");
      assert.equal(task.kind, "coding");
      assert.equal(h.driver.prompts.planner?.length, 3);
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.type === "warning" && /^The manager could not re-plan the task \(the planner never called submit_plan; last message: .*\), so the change goes to the Coding stage\.$/.test(event.text)));
      assert.ok(commOf(h, task.id).some((line) => line.startsWith("manager>manager:plan:Re-plan for U1: the Coding team revises its work - The manager could not re-plan the task")));
    } finally {
      h.cleanup();
    }
  });
});

describe("change requests on work the task left unfinished", () => {
  test("review comments nobody resolved yet are resolved with the request, and the reviewer checks everything since its last review", async () => {
    const h = createHarness({
      coder: [steps(writeFile("greet.js", "// round 1 marker\nexport const greet = (name) => `hi ${name}`;\n"), submitWork("Added greet()"))],
      "code-reviewer": [
        submitReview("request_changes", [{ severity: "major", file: "greet.js", line: 2, body: "Handle an empty name" }]),
        steps((_spec, prompt) => {
          assert.match(prompt, /The user later asked for the changes below[\s\S]*- \[U1\] \(change request\) Export a default too\n  -> addressed: Added/);
          assert.match(prompt, /Your comments from your last review and the author's responses:\n- \[C1\] \(major\) Handle an empty name\n  -> addressed: Defaults to "friend"/);
        }, submitReview("approve")),
      ],
      resolver: [
        hang,
        steps(
          (_spec, prompt) => {
            assert.match(prompt, /## Round 3: make the changes the user requested\n\nThe user asked for the changes below\./);
            assert.match(prompt, /Change requests:\n- \[U1\] Export a default too\n\nReview comments still open from the last review, to resolve as well:\n- \[C1\] \(major\) greet\.js:2 - Handle an empty name/);
            assert.match(prompt, /covering exactly these IDs: C1, U1/);
          },
          writeFile("greet.js", "// round 1 marker\nexport const greet = (name) => `hi ${name || 'friend'}`;\nexport default greet;\n"),
          submitWork("Handled empty names and exported a default", [
            { comment_id: "C1", status: "addressed", note: 'Defaults to "friend"' },
            { comment_id: "U1", status: "addressed", note: "Added" },
          ]),
        ),
      ],
    });
    try {
      const created = await h.runner.submit({ description: "Add a greet function", kind: "coding", repoId: "sample" });
      await waitFor(() => h.driver.prompts.resolver?.length === 1);
      h.runner.cancel(created.id);
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "cancelled");
      h.runner.requestChanges(task.id, { request: "Export a default too", stage: "coding" });
      await h.runner.idle();
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.result?.approved, true);
      assert.deepEqual(
        task.stages[0]!.rounds.map((round) => [round.n, round.author?.role ?? null, round.review?.by ?? round.review?.verdict]),
        [
          [1, "coder", "request_changes"],
          [2, null, "user"],
          [3, "resolver", "approve"],
        ],
      );
      assert.deepEqual(task.stages[0]!.rounds[0]!.review?.comments.map((comment) => [comment.id, comment.status]), [["C1", "addressed"]]);
    } finally {
      h.cleanup();
    }
  });

  test("work the task stopped before it was reviewed is reviewed with the request's round", async () => {
    const h = createHarness({
      coder: [steps(writeFile("greet.js", "// round 1 marker\nlet greet = () => 'hi';\nexport { greet };\n"), submitWork("Added greet()"))],
      "code-reviewer": [
        crash,
        crash,
        crash,
        crash,
        steps((_spec, prompt) => {
          const base = /Base commit: ([0-9a-f]{10})/.exec(prompt)?.[1];
          assert.ok(base);
          assert.match(prompt, new RegExp(`Changes in this round \\(git diff ${base}\\.\\.[0-9a-f]{10}\\)`), "the diff starts where the last review would have");
          assert.match(prompt, /\+\/\/ round 1 marker/, "the unreviewed round's work is in the diff");
        }, submitReview("approve")),
      ],
      resolver: [steps(writeFile("greet.js", "// round 1 marker\nconst greet = () => 'hi';\nexport { greet };\n"), submitWork("Uses const", [{ comment_id: "U1", status: "addressed", note: "Done" }]))],
    });
    try {
      const created = await h.runner.submit({ description: "Add a greet function", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "failed");
      h.runner.requestChanges(task.id, { request: "Use const", stage: "coding" });
      await h.runner.idle();
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(h.driver.prompts["code-reviewer"]?.length, 5);
    } finally {
      h.cleanup();
    }
  });

  test("requests made one after another before the task runs again share one round, and a waiting re-run never hides a request", async () => {
    const h = createHarness({
      planner: [submitPlan(["coding", "testing"], { coding: "Add mul()", testing: "Run the tests" })],
      coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()"))],
      "code-reviewer": [submitReview("approve"), submitReview("approve")],
      resolver: [
        steps(
          (_spec, prompt) => assert.match(prompt, /covering exactly these IDs: U1, U2/),
          writeFile("calc.js", "export const mul = (a, b) => Number(a) * Number(b);\nexport const div = (a, b) => a / b;\n"),
          submitWork("Strings and div()", [
            { comment_id: "U1", status: "addressed", note: "Converts" },
            { comment_id: "U2", status: "addressed", note: "Added div()" },
          ]),
        ),
      ],
      executor: [submitTests("passed", [], { total: 3 }), submitTests("passed", [], { total: 5 })],
      fixer: [
        steps(
          (_spec, prompt) => assert.match(prompt, /- \[U3\] Also test division by zero/),
          writeFile("calc.test.js", "// division by zero\n"),
          submitWork("Added the test", [{ comment_id: "U3", status: "addressed", note: "Added" }]),
        ),
      ],
    });
    try {
      const created = await h.runner.submit({ description: "Add multiplication and run the tests", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      h.setReady(false);
      h.runner.requestChanges(task.id, { request: "mul() should accept numeric strings", stage: "coding" });
      h.runner.requestChanges(task.id, { request: "Add div() as well", stage: "coding" });
      h.runner.requestChanges(task.id, { request: "Also test division by zero", stage: "testing" });
      const [coding, testing] = task.stages;
      assert.deepEqual(coding!.rounds.at(-1)?.review?.comments.map((comment) => comment.id), ["U1", "U2"], "one round holds both requests");
      assert.equal(testing!.rerun, undefined, "the testing request's round re-runs the tests itself");
      assert.deepEqual(task.changeRequests?.map((request) => [request.id, request.stage, request.round]), [
        ["U1", "coding", 2],
        ["U2", "coding", 2],
        ["U3", "testing", 2],
      ]);
      h.setReady(true);
      h.runner.pump();
      await h.runner.idle();
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.result?.tests?.total, 5);
      assert.deepEqual(task.stages[1]!.rounds.map((round) => [round.n, round.author?.role ?? null, round.review?.by ?? round.review?.verdict]), [
        [1, null, "approve"],
        [2, null, "user"],
        [3, "fixer", "approve"],
      ]);
      for (const comment of [...coding!.rounds[1]!.review!.comments, ...testing!.rounds[1]!.review!.comments]) assert.equal(comment.status, "addressed", comment.id);
    } finally {
      h.cleanup();
    }
  });

  test("after Retry, the request the failed attempt worked on is still the current one", async () => {
    const h = createHarness({
      designer: [steps((spec, prompt) => writeFile(designPathFrom(prompt), "# Cache design\n")(spec, prompt), submitWork("Designed it"))],
      "design-reviewer": [submitReview("approve")],
      planner: [submitChangePlan(["design", "coding"], undefined, { coding: "Implement the design" }, "Implementing needs the coding team.")],
      coder: [
        crash,
        crash,
        crash,
        crash,
        steps((_spec, prompt) => assert.match(prompt, /- \[U1\] \(current\) Now implement it/), writeFile("cache.js", "// cache\n"), submitWork("Implemented")),
      ],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await h.runner.submit({ description: "Design a cache", kind: "design", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      h.runner.requestChanges(task.id, { request: "Now implement it" });
      await h.runner.idle();
      assert.equal(task.status, "failed");
      h.runner.retry(task.id);
      assert.equal(task.changeRequests![0]!.attempt, task.attempt);
      await h.runner.idle();
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.kind, "design-coding");
    } finally {
      h.cleanup();
    }
  });

  test("an Auto task that has not started yet plans with the requests, even when its description reads as a review", async () => {
    const h = createHarness(
      {
        planner: [
          async (spec, prompt) => {
            assert.match(prompt, /- \[U1\] \(current\) Do not review it: fix the typo in README\.md instead/);
            if (spec.submit.kind !== "plan") throw new Error("not a planner");
            const plan = { stages: ["coding"], rationale: "The user asked for a fix instead", instructions: { coding: "Fix the typo in README.md" }, briefing: "README.md is the only file." };
            // The manager first double-checks a plan that is not a review for a request that reads as one.
            await assert.rejects(Promise.resolve(spec.submit.onSubmit(plan as never)), /reads as a request to review #7/);
            await spec.submit.onSubmit(plan as never);
          },
        ],
        coder: [steps(writeFile("README.md", "# Sample\n\nFixed.\n"), submitWork("Fixed the typo"))],
        "code-reviewer": [submitReview("approve")],
      },
      { ready: false },
    );
    try {
      const created = await h.runner.submit({ description: "Review PR #7", kind: "auto", repoId: "sample" });
      h.runner.requestChanges(created.id, { request: "Do not review it: fix the typo in README.md instead" });
      h.setReady(true);
      h.runner.pump();
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.deepEqual(task.plan?.stages, ["coding"]);
      assert.equal(task.changeRequests?.[0]?.plan?.initial, true);
      // Had it become a code review, its reviewers would see the requests too.
      const prompt = findingsPrompt({ task: { ...task, review: undefined }, role: "lead-reviewer", includeContext: true, round: 1, change: { stat: "", diff: { text: "", truncated: false } }, otherModel: "m" });
      assert.match(prompt, /## More from the user \(they amend the request above, in order\)\n\n- \[U1\] Do not review it/);
    } finally {
      h.cleanup();
    }
  });
});

describe("change requests re-planned by the manager: the rules", () => {
  test("the manager's plan for a change request is checked: finished work stays, new teams get assignments, no code reviews", () => {
    const task = fakeTask({
      kind: "auto",
      plan: { stages: ["design", "coding", "testing"], rationale: "r", instructions: { design: "D", coding: "C", testing: "T" }, plannedAt: at(0) },
      stages: [stage("design", "approved", true), stage("coding", "failed", true), stage("testing", "pending", false)],
    });
    const plan = (input: Record<string, unknown>) => normalizeChangePlan(input, task);
    assert.throws(() => plan({ stages: ["coding", "testing"], change_stage: "coding", rationale: "x" }), /^Error: Keep the design stage: its work is finished and stays on the task branch/);
    assert.throws(() => plan({ stages: ["review"], rationale: "x" }), /cannot turn this task into a code review/);
    assert.throws(() => plan({ stages: ["design", "magic"], rationale: "x" }), /Unknown stage 'magic'/);
    assert.throws(() => plan({ stages: [], rationale: "x" }), /`stages` must list every stage/);
    assert.throws(() => plan({ stages: ["design", "coding", "testing"], rationale: "x" }), /Nothing in this plan handles the change request/);
    assert.throws(() => plan({ stages: ["design", "coding", "testing"], change_stage: "document", rationale: "x" }), /change_stage 'document' must be one of the stages you listed/);
    assert.throws(() => plan({ stages: ["design", "coding", "testing", "docs"], change_stage: "coding", rationale: "x" }), /instructions\.document is required/);
    assert.throws(() => plan({ stages: ["design", "coding", "testing"], change_stage: "code" }), /`rationale` is required/);
    // Unfinished stages may be dropped (failed coding here); names and order are normalized; a re-added stage keeps its assignment.
    assert.deepEqual(plan({ stages: ["Docs", "tests", "design"], instructions: { document: "Write a runbook" }, rationale: "Only document it" }), {
      stages: ["design", "testing", "document"],
      instructions: { document: "Write a runbook" },
      rationale: "Only document it",
      routing: "manager",
    });
    assert.deepEqual(plan({ stages: ["design", "coding", "testing"], change_stage: "Implementation", rationale: "Fix it", briefing: "  " }), {
      stages: ["design", "coding", "testing"],
      changeStage: "coding",
      instructions: {},
      rationale: "Fix it",
      routing: "manager",
    });
  });

  test("applying a change: requests share one round, new teams start afresh, dropped stages keep their history, the type follows", () => {
    const task = fakeTask({ kind: "coding", stages: [stage("coding", "approved", true)] });
    const requests: ChangeRequest[] = [request("U1"), request("U2")];
    task.changeRequests = requests;
    const applied = applyChangePlan(task, requests, { stages: ["coding", "testing"], changeStage: "coding", instructions: { testing: "Run npm test" }, rationale: "Test it too", routing: "manager" }, at(9));
    assert.deepEqual([applied.target, applied.round, applied.added, applied.later, applied.kind], ["coding", 2, ["testing"], [], { from: "coding", to: "auto" }]);
    assert.deepEqual(task.stages[0]!.rounds[1]!.review?.comments.map((comment) => [comment.id, comment.body, comment.status]), [
      ["U1", "Request U1", "open"],
      ["U2", "Request U2", "open"],
    ]);
    assert.deepEqual([task.stages[1]!.kind, task.stages[1]!.status, task.stages[1]!.rounds.length], ["testing", "pending", 0]);
    assert.deepEqual(task.plan && { stages: task.plan.stages, instructions: task.plan.instructions, rationale: task.plan.rationale }, {
      stages: ["coding", "testing"],
      instructions: { testing: "Run npm test" },
      rationale: "Test it too",
    });
    assert.deepEqual(requests.map((item) => [item.pending, item.stage, item.round]), [
      [undefined, "coding", 2],
      [undefined, "coding", 2],
    ]);

    // Dropping a stage that ran keeps it as "skipped"; adding it back makes it pending again.
    task.stages[0]!.status = "approved";
    task.stages[1]!.rounds.push({ n: 1, attempt: 1, startedAt: at(10), review: { verdict: "request_changes", summary: "1 failing", comments: [], at: at(10) } });
    task.stages[1]!.status = "failed";
    const third = request("U3");
    applyChangePlan(task, [third], { stages: ["coding", "document"], instructions: { document: "Write docs" }, rationale: "Docs instead", routing: "manager" }, at(11));
    assert.deepEqual(task.stages.map((item) => [item.kind, item.status, item.skippedFor ?? null]), [
      ["coding", "approved", null],
      ["testing", "skipped", "U3"],
      ["document", "pending", null],
    ]);
    assert.deepEqual([third.stage, third.round, third.plan?.dropped, third.plan?.added], ["document", undefined, ["testing"], ["document"]]);
    applyChangePlan(task, [request("U4")], { stages: ["coding", "testing", "document"], changeStage: "testing", instructions: {}, rationale: "Run them after all", routing: "manager" }, at(12));
    assert.deepEqual(task.stages.map((item) => [item.kind, item.status]), [
      ["coding", "approved"],
      ["testing", "pending"],
      ["document", "pending"],
    ]);
    assert.equal(task.stages[1]!.rounds.at(-1)?.review?.by, "user", "the re-added stage revises its work for the request");
  });
});

const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;

function stage(kind: Stage["kind"], status: Stage["status"], worked: boolean): Stage {
  return {
    kind,
    status,
    rounds: worked ? [{ n: 1, attempt: 1, startedAt: at(1), author: { summary: "done", responses: [], commit: "a".repeat(40), at: at(1) }, ...(status === "approved" ? { review: { verdict: "approve" as const, summary: "ok", comments: [], at: at(2) } } : {}) }] : [],
    nextCommentNumber: 1,
  };
}

function request(id: string): ChangeRequest {
  return { id, text: `Request ${id}`, attempt: 2, rounds: 3, requestedAt: at(8), routing: "manager", pending: true };
}

function fakeTask(extra: Partial<Task>): Task {
  return {
    id: "T-001",
    title: "Task",
    description: "Do it",
    kind: "coding",
    repoId: "sample",
    repoName: "sample",
    baseRef: "main",
    status: "queued",
    phase: "queued",
    currentRound: 0,
    maxRounds: 3,
    stages: [],
    sessions: [],
    usage: { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 },
    attempt: 2,
    lastSeq: 0,
    authorModel: "a",
    reviewerModel: "r",
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  } as Task;
}
