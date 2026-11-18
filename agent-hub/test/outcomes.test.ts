import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PullRequestCreator, PullRequestRequest } from "../src/remote.ts";
import type { Round, Stage, StageKind, StageStatus } from "../src/types.ts";
import { latestApprovedWork, pullRequestBody } from "../src/workflow/runner.ts";
import { summarizeTask } from "../src/workflow/summary.ts";
import {
  addRemote,
  bareGit,
  branchHead,
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

/** Records the pull requests the hub creates (as the GitHub CLI would). */
function fakeCreator(requests: PullRequestRequest[]): PullRequestCreator {
  return {
    canCreate: async (remote) => remote.provider === "github",
    findOpen: async () => null,
    create: async (_remote, request) => {
      requests.push(request);
      return { url: "https://github.com/acme/sample/pull/9", number: 9, draft: request.draft };
    },
  };
}

const commOf = (h: ReturnType<typeof createHarness>, taskId: string) => h.store.recentComm({ taskId, limit: 1000 }).map((entry) => entry.text);

/** The task branch's commits, base first: the order approvals are weighed in. */
const branchOrder = (h: ReturnType<typeof createHarness>, task: { baseSha?: string; branch?: string }) => [
  task.baseSha!,
  ...git(h.repoPath, "rev-list", "--first-parent", "--reverse", `${task.baseSha}..${task.branch}`).split(/\r?\n/).filter(Boolean),
];

const at = (minute: number) => `2026-11-18T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("the tests wait for approved code", () => {
  test("a coding stage that is not approved stops the run before the tests; continuing finishes it, then the tests run", async () => {
    const h = createHarness(
      {
        planner: [submitPlan(["coding", "testing"], { coding: "Add mul()", testing: "Run npm test" })],
        coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a + b;\n"), submitWork("Added mul()"))],
        "code-reviewer": [submitReview("request_changes", [{ severity: "blocker", file: "calc.js", line: 1, body: "mul() adds" }]), submitReview("approve")],
        resolver: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("mul() multiplies", [{ comment_id: "C1", status: "addressed", note: "Uses *" }]))],
        executor: [submitTests("passed", [], { total: 3 })],
      },
      { settings: { maxRounds: 1 } },
    );
    try {
      const created = await h.runner.submit({ description: "Add multiplication and run the tests", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, false);
      assert.deepEqual(task.result?.notRun, ["testing"]);
      assert.equal(task.result?.openComments, 1);
      const testsBefore = task.result?.tests;
      assert.equal(testsBefore, undefined);
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "not-approved"],
        ["testing", "pending"],
      ]);
      assert.equal(h.driver.specsFor("executor").length, 0, "no test run on code the reviewer did not approve");
      assert.deepEqual(summarizeTask(task).notRun, ["testing"]);
      const comm = commOf(h, task.id);
      assert.ok(comm.includes("Not running the tests: the coding stage is not approved; they wait for approved code"));
      assert.ok(comm.some((text) => text.startsWith("Completed without approval: the coding stage is not approved (1 open comment(s)), so the tests did not run")));
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.type === "warning" && event.text.startsWith("The coding stage is not approved, so the tests do not run: they wait for approved code.")));

      // Continue review loop: the coding stage gets more rounds; once approved, the tests run.
      h.runner.retry(task.id, 2);
      await h.runner.idle();
      assert.equal(task.status, "completed");
      assert.equal(task.result?.approved, true);
      assert.equal(task.result?.notRun, undefined);
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "approved"],
        ["testing", "approved"],
      ]);
      assert.equal(h.driver.prompts.executor?.length, 1);
      assert.equal(task.result?.tests?.total, 3);
    } finally {
      h.cleanup();
    }
  });

  test("a coding stage added for a change request holds back the tests that ran before it, then runs them again", async () => {
    const h = createHarness({
      executor: [submitTests("passed", [], { total: 2 }), submitTests("passed", [], { total: 3 })],
      planner: [submitChangePlan(["coding", "testing"], "coding", { coding: "Add mul() to calc.js" })],
      coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a + b;\n"), submitWork("Added mul()"))],
      "code-reviewer": [submitReview("request_changes", [{ severity: "blocker", file: "calc.js", line: 1, body: "mul() adds" }]), submitReview("approve")],
      resolver: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("mul() multiplies", [{ comment_id: "C1", status: "addressed", note: "Uses *" }]))],
    });
    try {
      const created = await h.runner.submit({ description: "Run the tests", kind: "testing", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.result?.approved, true);

      // The manager adds a coding stage for the request; its reviewer does not approve it within the round.
      h.runner.requestChanges(task.id, { request: "Add mul() to calc.js", rounds: 1 });
      await h.runner.idle();
      assert.equal(task.status, "completed");
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "not-approved"],
        ["testing", "pending"],
      ]);
      assert.equal(task.stages[1]!.rerun, true, "the earlier run tested other code");
      assert.deepEqual([task.result?.approved, task.result?.outcomeStage, task.result?.notRun], [false, "coding", ["testing"]]);
      const earlierRun = task.result?.tests;
      assert.equal(earlierRun, undefined, "the earlier run does not count");
      assert.equal(h.driver.prompts.executor?.length, 1);

      // Continue: the coding stage is finished first; the tests then run again, on the approved code.
      h.runner.retry(task.id, 2);
      await h.runner.idle();
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "approved"],
        ["testing", "approved"],
      ]);
      assert.deepEqual([task.result?.approved, task.result?.outcomeStage, task.result?.notRun], [true, "testing", undefined]);
      assert.equal(h.driver.prompts.executor?.length, 2);
      assert.equal(task.result?.tests?.total, 3);
    } finally {
      h.cleanup();
    }
  });

  test("tests that ran on code the reviewer did not approve (recorded before the gate): continuing finishes the coding stage, then runs them again", async () => {
    const h = createHarness(
      {
        planner: [submitPlan(["coding", "testing"], { coding: "Add mul()", testing: "Run npm test" })],
        coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a + b;\n"), submitWork("Added mul()"))],
        "code-reviewer": [submitReview("request_changes", [{ severity: "blocker", file: "calc.js", line: 1, body: "mul() adds" }]), submitReview("approve")],
        resolver: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("mul() multiplies", [{ comment_id: "C1", status: "addressed", note: "Uses *" }]))],
        executor: [submitTests("passed", [], { total: 3 })],
      },
      { settings: { maxRounds: 1 } },
    );
    try {
      const created = await h.runner.submit({ description: "Add multiplication and run the tests", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      // What a task recorded before the tests waited for approved code looks like: they ran on the rejected code, and failed.
      const testing = task.stages[1]!;
      testing.status = "not-approved";
      testing.nextCommentNumber = 2;
      testing.rounds.push({
        n: 1,
        attempt: 1,
        startedAt: at(1),
        review: {
          verdict: "request_changes",
          summary: "1 failing",
          comments: [{ id: "T1", severity: "major", body: "Expected 6, received 5", status: "open", test: "mul multiplies", category: "product-bug" }],
          reviewedSha: branchHead(h.repoPath, task.branch!),
          testRun: { status: "failed", commands: ["npm test"], total: 3, passed: 2, failed: 1 },
          at: at(2),
        },
      });
      task.result = { ...task.result!, approved: false, openComments: 1 };
      delete task.result.notRun;

      h.runner.retry(task.id, 2);
      await h.runner.idle();
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "approved"],
        ["testing", "approved"],
      ]);
      assert.equal(h.driver.prompts.resolver?.length, 1, "the coding stage was continued first");
      assert.equal(h.driver.prompts.executor?.length, 1, "the tests ran again on the approved code");
      assert.equal(h.driver.prompts.fixer?.length ?? 0, 0, "the failure of the earlier run did not go to the fixer");
      assert.deepEqual([task.result?.approved, task.result?.outcomeStage, task.result?.tests?.total], [true, "testing", 3]);
    } finally {
      h.cleanup();
    }
  });

  test("tests that could not verify the change keep the task unapproved before a document stage; continuing runs them again", async () => {
    const requests: PullRequestRequest[] = [];
    const h = createHarness(
      {
        planner: [submitPlan(["coding", "testing", "document"], { coding: "Add mul()", testing: "Run npm test", document: "Document mul()" })],
        coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()"))],
        "code-reviewer": [submitReview("approve")],
        executor: [submitTests("blocked", [{ test: "npm test", error: "npm is not recognized as a command", category: "environment" }]), submitTests("passed", [], { total: 3 })],
        writer: [steps((spec, prompt) => writeFile(designPathFrom(prompt), "# mul()\n")(spec, prompt), submitWork("Documented mul()"))],
        "doc-reviewer": [submitReview("approve")],
      },
      { pullRequests: fakeCreator(requests) },
    );
    try {
      addRemote(h);
      const created = await h.runner.submit({ description: "Add multiplication, test it and document it", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "approved"],
        ["testing", "not-approved"],
        ["document", "approved"],
      ]);
      assert.deepEqual([task.status, task.result?.approved, task.result?.outcomeStage, task.result?.testsUnverified], ["completed", false, "testing", "blocked"]);
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.text === "The tests could not verify the change (the run was blocked); continuing with the latest version."));
      await h.runner.pullRequest(task.id);
      assert.equal(requests[0]!.draft, true, "the user validates it first");

      // Run the tests again: the testing stage starts with a fresh run; the approved document has nothing new to do.
      h.runner.retry(task.id, 2);
      await h.runner.idle();
      assert.deepEqual(task.stages.map((stage) => [stage.kind, stage.status]), [
        ["coding", "approved"],
        ["testing", "approved"],
        ["document", "approved"],
      ]);
      assert.deepEqual([task.result?.approved, task.result?.outcomeStage, task.result?.testsUnverified], [true, "document", undefined]);
      assert.equal(h.driver.prompts.executor?.length, 2);
      assert.equal(h.driver.prompts.writer?.length, 1);
      assert.equal(h.driver.prompts.fixer?.length ?? 0, 0, "no fixer for a blocked run");
    } finally {
      h.cleanup();
    }
  });
});

describe("pull requests from tasks that did not finish", () => {
  test("approved work holds approved work only: an approval on top of work its own stage did not approve does not count", () => {
    const sha = (name: string) => name.padEnd(40, "0");
    const [base, a1, c1, c2, d1, d2, f1, f2] = ["ba5e", "a1", "c1", "c2", "d1", "d2", "f1", "f2"].map(sha) as [string, string, string, string, string, string, string, string];
    type Turn = { n: number; commit?: string | null; verdict?: "approve" | "request_changes"; reviewed?: string; by?: "user" };
    const stage = (kind: StageKind, status: StageStatus, turns: Turn[]): Stage => ({
      kind,
      status,
      nextCommentNumber: 1,
      rounds: turns.map(
        (turn): Round => ({
          n: turn.n,
          attempt: 1,
          startedAt: at(turn.n),
          ...(turn.commit !== undefined ? { author: { summary: `Round ${turn.n}`, responses: [], commit: turn.commit, at: at(turn.n) } } : {}),
          ...(turn.verdict
            ? {
                review: {
                  verdict: turn.verdict,
                  summary: turn.verdict,
                  comments: [],
                  ...((turn.reviewed ?? turn.commit) ? { reviewedSha: turn.reviewed ?? turn.commit! } : {}),
                  ...(turn.by ? { by: turn.by } : {}),
                  at: at(turn.n + 1),
                },
              }
            : {}),
        }),
      ),
    });
    const latest = (stages: Stage[], order: string[]) => {
      const work = latestApprovedWork({ stages }, order);
      return work && [work.stage, work.round, work.sha];
    };

    // A document approved on top of code its reviewer did not approve.
    const rejectedCode = stage("coding", "not-approved", [
      { n: 1, commit: c1, verdict: "request_changes" },
      { n: 2, commit: c2, verdict: "request_changes" },
    ]);
    assert.equal(latest([rejectedCode, stage("document", "approved", [{ n: 1, commit: d1, verdict: "approve" }])], [base, c1, c2, d1]), null);
    // The approved design below that code still counts.
    assert.deepEqual(
      latest(
        [stage("design", "approved", [{ n: 1, commit: a1, verdict: "approve" }]), stage("coding", "not-approved", [{ n: 1, commit: c1, verdict: "request_changes" }]), stage("document", "approved", [{ n: 1, commit: d1, verdict: "approve" }])],
        [base, a1, c1, d1],
      ),
      ["design", 1, a1],
    );
    // A change request whose code was not approved: the work approved before it is delivered.
    assert.deepEqual(
      latest(
        [
          stage("coding", "not-approved", [{ n: 1, commit: c1, verdict: "approve" }, { n: 2, verdict: "request_changes", by: "user" }, { n: 3, commit: c2, verdict: "request_changes" }]),
          stage("document", "approved", [{ n: 1, commit: d1, verdict: "approve" }, { n: 2, verdict: "request_changes", by: "user" }, { n: 3, commit: d2, verdict: "approve" }]),
        ],
        [base, c1, d1, c2, d2],
      ),
      ["document", 1, d1],
    );
    // The test fixer's commits count once a test run passes on them; an unverified fix does not.
    const code = stage("coding", "approved", [{ n: 1, commit: c1, verdict: "approve" }]);
    const failing = stage("testing", "not-approved", [
      { n: 1, verdict: "request_changes", reviewed: c1 },
      { n: 2, commit: f1, verdict: "request_changes" },
    ]);
    assert.deepEqual(latest([code, failing], [base, c1, f1]), ["coding", 1, c1]);
    const passing = stage("testing", "approved", [...failing.rounds.map((round) => ({ n: round.n, commit: round.author?.commit, verdict: round.review!.verdict, reviewed: round.review!.reviewedSha })), { n: 3, commit: f2, verdict: "approve" }]);
    assert.deepEqual(latest([code, passing], [base, c1, f1, f2]), ["testing", 3, f2]);
    // A dropped stage's unapproved commits still hold back the approvals above them.
    assert.deepEqual(latest([code, { ...failing, status: "skipped" }, stage("document", "approved", [{ n: 1, commit: d1, verdict: "approve" }])], [base, c1, f1, d1]), ["coding", 1, c1]);
    // Approved work that is not on the task branch does not count.
    assert.equal(latest([code], [base]), null);
  });

  test("a failed task can still open a pull request: it holds only the latest approved work", async () => {
    const requests: PullRequestRequest[] = [];
    const h = createHarness(
      {
        planner: [submitPlan(["coding", "testing"], { coding: "Add mul()", testing: "Run npm test" })],
        coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()"))],
        "code-reviewer": [submitReview("approve")],
        executor: [submitTests("failed", [{ test: "mul multiplies", error: "Expected 6, received 5", category: "product-bug" }], { total: 3, passed: 2, failed: 1 }), crash, crash, crash, crash],
        fixer: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b + 0;\n"), submitWork("Tweaked mul()", [{ comment_id: "T1", status: "addressed", note: "Fixed" }]))],
      },
      { pullRequests: fakeCreator(requests) },
    );
    try {
      const bare = addRemote(h);
      const created = await h.runner.submit({ description: "Add multiplication and run the tests", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "failed");
      const autoPush = task.push;
      assert.equal(autoPush, undefined, "a failed task is not pushed automatically");
      const approvedSha = task.stages[0]!.rounds[0]!.author!.commit!;
      const head = branchHead(h.repoPath, task.branch!);
      assert.notEqual(head, approvedSha, "the fixer's unverified commit is on the task branch");
      const latest = latestApprovedWork(task, branchOrder(h, task));
      assert.deepEqual(latest && { ...latest, at: "" }, { sha: approvedSha, stage: "coding", round: 1, at: "" });

      const status = await h.runner.pullRequestStatus(task.id);
      assert.deepEqual(status.deliverable && { sha: status.deliverable.sha, stage: status.deliverable.approved?.stage, round: status.deliverable.approved?.round }, {
        sha: approvedSha,
        stage: "coding",
        round: 1,
      });

      const outcome = await h.runner.pullRequest(task.id);
      assert.equal(outcome.pullRequest?.number, 9);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), approvedSha, "only the approved work was pushed");
      assert.deepEqual([task.push?.status, task.push?.sha, task.push?.approved?.stage, task.push?.approved?.round], ["pushed", approvedSha, "coding", 1]);
      const [request] = requests;
      assert.equal(request!.draft, true, "the user validates it first");
      assert.match(request!.body, /^Added mul\(\)\n/);
      assert.match(
        request!.body,
        new RegExp(`\\*\\*Outcome:\\*\\* the task did not finish \\(failed: Test executor could not be recovered after 3 attempts.*\\)\\. This pull request holds only the work approved so far: the Coding stage, approved in round 1 \\(${approvedSha.slice(0, 10)}\\)\\. Validate it before merging\\.`),
      );
      assert.ok(commOf(h, task.id).includes(`Pushed the approved work (Coding, round 1) to origin/${task.branch} (${approvedSha.slice(0, 10)})`));
      assert.equal(pullRequestBody(task, undefined).includes("did not finish"), false, "without approved work the body is the usual one");

      // The remote branch gets later, unapproved work (pushed by hand here; as when an attempt completed unapproved), while
      // the task's last push record still says the approved work: the status reports where the remote really stands.
      git(h.repoPath, "push", "-q", "origin", `${head}:refs/heads/${task.branch}`);
      assert.deepEqual((await h.runner.pullRequestStatus(task.id)).deliverable?.remoteAhead, { head, kind: "later" });
      // A push or a pull request never rewinds it on its own: it fails and says how.
      const notRewound = (await h.runner.pushNow(task.id)).push;
      assert.equal(notRewound?.status, "failed");
      assert.equal(
        notRewound?.reason,
        `origin/${task.branch} holds later work of this task that was not approved (up to ${head.slice(0, 10)}), pushed earlier. Rewind it to the approved work (${approvedSha.slice(0, 10)}) to deliver only that; the later work stays on the local task branch.`,
      );
      const opened = task.pullRequest;
      delete task.pullRequest;
      await assert.rejects(h.runner.pullRequest(task.id), /The branch could not be pushed: origin\/.+ holds later work of this task that was not approved/);
      task.pullRequest = opened;
      assert.equal(requests.length, 1, "no pull request from a branch holding unapproved work");
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), head, "nothing was rewound");
      // The user asks for the rewind: the remote branch moves back to the approved work; the later work stays local.
      assert.deepEqual((await h.runner.pullRequestStatus(task.id)).deliverable?.remoteAhead, { head, kind: "later" }, "whatever the last push record says");
      const rewound = (await h.runner.pushNow(task.id, { rewind: true })).push;
      assert.deepEqual([rewound?.status, rewound?.sha, rewound?.approved?.stage], ["pushed", approvedSha, "coding"]);
      assert.equal(rewound?.note, `rewound the branch from the later, unapproved work pushed earlier (up to ${head.slice(0, 10)}); that work stays on the local task branch`);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), approvedSha, "the remote branch holds only the approved work again");
      assert.equal(branchHead(h.repoPath, task.branch!), head, "the later work stays on the local task branch");
      assert.equal((await h.runner.pullRequestStatus(task.id)).deliverable?.remoteAhead, undefined);

      // Commits on the remote branch that are not the task's own are never replaced, even when asked to rewind.
      const foreign = git(h.repoPath, "commit-tree", `${approvedSha}^{tree}`, "-p", approvedSha, "-m", "Someone else's commit");
      git(h.repoPath, "push", "-q", "origin", `${foreign}:refs/heads/${task.branch}`);
      assert.deepEqual((await h.runner.pullRequestStatus(task.id)).deliverable?.remoteAhead, { head: foreign, kind: "foreign" });
      const refused = (await h.runner.pushNow(task.id, { rewind: true })).push;
      assert.equal(refused?.status, "failed");
      assert.match(refused?.reason ?? "", /has commits that are not on the local task branch \(up to [0-9a-f]{10}\); the hub does not replace them/);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), foreign, "nothing was rewound");
    } finally {
      h.cleanup();
    }
  });

  test("an automatic push delivers the head its attempt completed with, even when the task runs again before the push's turn", async () => {
    const failing = (received: number) =>
      submitTests("failed", [{ test: "mul multiplies", error: `Expected 6, received ${received}`, category: "product-bug" }], { total: 3, passed: 2, failed: 1 });
    const fix = (n: number) => steps(writeFile("calc.js", `export const mul = (a, b) => a * b + ${n};\n`), submitWork(`Fix ${n}`, [{ comment_id: `T${n}`, status: "addressed", note: "Fixed" }]));
    const h = createHarness(
      {
        planner: [submitPlan(["coding", "testing"], { coding: "Add mul()", testing: "Run npm test" })],
        coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()"))],
        "code-reviewer": [submitReview("approve")],
        executor: [failing(5), failing(7), failing(8)],
        fixer: [fix(1), fix(2), hang],
      },
      { settings: { maxRounds: 2 } },
    );
    try {
      const bare = addRemote(h);
      const created = await h.runner.submit({ description: "Add multiplication and run the tests", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.deepEqual([task.status, task.result?.approved], ["completed", false]);
      const first = branchHead(h.repoPath, task.branch!);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), first, "the first attempt's head was pushed automatically");

      // Attempt 2 completes while another push holds the repository's push lock, and the task runs again before its turn.
      const internals = h.runner as unknown as { repoLocks: { run<T>(key: string, work: () => Promise<T>): Promise<T> }; postWork: Set<unknown> };
      let release!: () => void;
      const lockHeld = internals.repoLocks.run(`${h.store.getRepo(task.repoId)!.path}#push`, () => new Promise<void>((resolve) => (release = resolve)));
      h.runner.retry(task.id, 1);
      await waitFor(() => task.attempt === 2 && internals.postWork.size === 1, 30_000);
      const second = branchHead(h.repoPath, task.branch!);
      assert.equal(task.result?.headSha, second);
      assert.notEqual(second, first);
      h.runner.retry(task.id, 1);
      await waitFor(() => h.driver.prompts.fixer?.length === 3, 30_000);
      assert.equal(task.status, "running");

      release();
      await lockHeld;
      await waitFor(() => internals.postWork.size === 0, 30_000);
      assert.deepEqual([task.push?.status, task.push?.sha, task.push?.auto, task.push?.approved, task.push?.note], ["pushed", second, true, undefined, undefined]);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), second, "attempt 2's head, not a rewind to the approved code");
      h.runner.cancel(task.id);
      await h.runner.idle();
    } finally {
      h.cleanup();
    }
  });

  test("a task that stopped before anything was approved has nothing to push", async () => {
    const h = createHarness({
      coder: [steps(writeFile("a.txt", "a\n"), submitWork("Add a"))],
      "code-reviewer": [crash, crash, crash, crash],
    });
    try {
      const bare = addRemote(h);
      const created = await h.runner.submit({ description: "Add a", kind: "coding", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "failed");
      assert.equal(latestApprovedWork(task, branchOrder(h, task)), null);
      assert.equal((await h.runner.pullRequestStatus(task.id)).deliverable, null);
      await assert.rejects(h.runner.pullRequest(task.id), /The task did not finish and none of its work was approved yet/);
      await h.runner.pushNow(task.id);
      assert.deepEqual([task.push?.status, task.push?.reason], ["skipped", "The task did not finish and none of its work was approved yet, so there is nothing to push"]);
      assert.equal(bareGit(bare, "for-each-ref", "refs/heads"), "", "nothing reached the remote");
    } finally {
      h.cleanup();
    }
  });

  test("a cancelled task delivers its approved design document", async () => {
    const requests: PullRequestRequest[] = [];
    const h = createHarness(
      {
        planner: [submitPlan(["design", "coding"], { design: "Design the cache", coding: "Implement the design" })],
        designer: [steps((spec, prompt) => writeFile(designPathFrom(prompt), "# Cache design\n")(spec, prompt), submitWork("Designed the cache"))],
        "design-reviewer": [submitReview("approve")],
        coder: [hang],
      },
      { pullRequests: fakeCreator(requests) },
    );
    try {
      const bare = addRemote(h);
      const created = await h.runner.submit({ description: "Design and build a cache", kind: "auto", repoId: "sample" });
      const task = h.store.getTask(created.id)!;
      // Cancel while the coder works: the design was approved before.
      await waitFor(() => Boolean(h.driver.prompts.coder?.length), 20_000);
      h.runner.cancel(task.id);
      await h.runner.idle();
      assert.equal(task.status, "cancelled");
      const approved = latestApprovedWork(task, branchOrder(h, task))!;
      assert.deepEqual([approved.stage, approved.round], ["design", 1]);
      await h.runner.pullRequest(task.id);
      assert.equal(bareGit(bare, "rev-parse", `refs/heads/${task.branch}`), approved.sha);
      assert.match(requests[0]!.body, /\(cancelled\)\. This pull request holds only the work approved so far: the Design stage, approved in round 1/);
      assert.equal(requests[0]!.draft, true);
    } finally {
      h.cleanup();
    }
  });
});
