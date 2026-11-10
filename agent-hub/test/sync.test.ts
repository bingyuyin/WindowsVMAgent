import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import type { CopilotService } from "../src/copilot/service.ts";
import { DATA_BRANCH_PREFIX, DataSync, dataBranchName, identityOf, parseSnapshot, planLoad, type LocalState, type Snapshot } from "../src/datasync.ts";
import { createApiRouter } from "../src/http/api.ts";
import { createHttpServer } from "../src/http/server.ts";
import type { RepoService } from "../src/repos.ts";
import { TodoService } from "../src/todos.ts";
import type { Task, Todo } from "../src/types.ts";
import { HttpError } from "../src/util.ts";
import { bareGit, createHarness, git, steps, submitPlan, submitReview, submitWork, writeFile, type Harness } from "./helpers.ts";

const httpError =
  (status: number, message: RegExp) =>
  (error: unknown): true => {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    assert.match(error.message, message);
    return true;
  };

const syncFor = (h: Harness, todos: TodoService, host: string) =>
  new DataSync({ store: h.store, bus: h.bus, runner: h.runner, todos, build: { version: "test", commit: "abc1234" }, host });

/** A hub with data: T-001 (sent from to-do TD-001, planned and run to completion), T-002 (queued) and TD-002 (open). */
async function hubWithData(host: string) {
  const h = createHarness({
    planner: [submitPlan(["coding"], { coding: "Add mul(a, b) to calc.js" })],
    coder: [steps(writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()"))],
    "code-reviewer": [submitReview("approve")],
  });
  const todos = new TodoService(h.store, h.bus, h.runner);
  const first = todos.create({ description: "Add multiplication to calc.js", repoId: "sample" });
  await todos.send(first.id);
  await h.runner.idle();
  assert.equal(h.store.getTask("T-001")?.status, "completed");
  await h.store.writeArtifact("T-001", "doc-r1.html", "<p>Design, round 1</p>\r\n");
  h.setReady(false);
  await h.runner.submit({ kind: "coding", description: "Add division to calc.js", repoId: "sample" });
  todos.create({ description: "Write the runbook" });
  return { h, todos, sync: syncFor(h, todos, host) };
}

/** A bare repository that is the "origin" of every hub's sample repository. */
function shareRemote(...hubs: Harness[]): string {
  const bare = path.join(hubs[0]!.root, "data-remote.git");
  git(hubs[0]!.root, "init", "-q", "--bare", bare);
  for (const hub of hubs) git(hub.repoPath, "remote", "add", "origin", bare);
  return bare;
}

const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;

function fakeTask(id: string, created: number, updated: number, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    kind: "coding",
    repoId: "app",
    repoName: "app",
    baseRef: "main",
    status: "completed",
    phase: "done",
    currentRound: 1,
    maxRounds: 3,
    stages: [],
    sessions: [],
    usage: { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 },
    attempt: 1,
    lastSeq: 0,
    authorModel: "a",
    reviewerModel: "r",
    createdAt: at(created),
    updatedAt: at(updated),
    ...extra,
  } as Task;
}

const fakeTodo = (id: string, created: number, updated: number, extra: Partial<Todo> = {}): Todo => ({
  id,
  title: "",
  description: id,
  status: "open",
  createdAt: at(created),
  updatedAt: at(updated),
  ...extra,
});

/** Checkout, index, branches and private refs of the repository, which data sync must leave alone. */
const checkoutState = (h: Harness) => ({
  head: git(h.repoPath, "rev-parse", "HEAD"),
  branch: git(h.repoPath, "symbolic-ref", "--short", "HEAD"),
  status: git(h.repoPath, "status", "--porcelain"),
  branches: git(h.repoPath, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/agent-hub"),
});

/** The whole manager log, read with no write in flight. */
const commOf = (h: Harness) => h.store.exclusive(() => h.store.readCommLogSync());

/** A file of a bare repository's commit, byte for byte. */
const rawBlob = (bare: string, sha: string, file: string) =>
  execFileSync("git", [`--git-dir=${bare}`, "cat-file", "blob", `${sha}:${file}`], { cwd: path.dirname(bare), encoding: "utf8" });

describe("data sync", () => {
  test("pushes the data to a task_data branch of its own, leaving the checkout alone; pushes again on top only when it changed", async () => {
    const { h, todos, sync } = await hubWithData("DEVBOX-01");
    const plain = path.join(h.root, "plain");
    try {
      const bare = shareRemote(h);
      const before = checkoutState(h);
      assert.deepEqual(sync.info(), { prefix: DATA_BRANCH_PREFIX, host: "DEVBOX-01", suggestedName: "devbox-01" });
      assert.deepEqual((await sync.branches("sample")).branches, []);

      const pushed = await sync.push({ repoId: "sample", name: "devbox" });
      const comm = (await commOf(h)).length;
      assert.ok(comm > 5, "the run left manager messages");
      assert.deepEqual([pushed.branch, pushed.remote, pushed.created, pushed.unchanged], ["task_data/devbox", "origin", true, false]);
      assert.deepEqual(pushed.counts, { tasks: 2, todos: 2, managerMessages: comm });
      assert.equal(pushed.summary, `Pushed 2 tasks, 2 to-dos and ${comm} manager messages to task_data/devbox on origin (${pushed.sha.slice(0, 10)})`);
      assert.equal(bareGit(bare, "rev-parse", "refs/heads/task_data/devbox"), pushed.sha);
      assert.equal(bareGit(bare, "rev-list", "--count", pushed.sha), "1", "a branch with a history of its own");
      assert.match(bareGit(bare, "log", "-1", "--format=%B", pushed.sha), /^Agent Hub data from DEVBOX-01: 2 tasks, 2 to-dos\n\nPushed by Copilot Agent Hub vtest \(abc1234\)/);
      const files = bareGit(bare, "ls-tree", "-r", "--name-only", pushed.sha).split("\n");
      assert.deepEqual(files, [
        "README.md",
        "agent-hub-data.json",
        "manager-log.jsonl",
        "repos.json",
        "tasks/T-001/doc-r1.html",
        "tasks/T-001/events.jsonl",
        "tasks/T-001/task.json",
        "tasks/T-002/events.jsonl",
        "tasks/T-002/task.json",
        "todos.json",
      ]);
      const manifest = JSON.parse(bareGit(bare, "show", `${pushed.sha}:agent-hub-data.json`));
      assert.deepEqual(manifest, {
        format: 1,
        host: "DEVBOX-01",
        hub: { version: "test", commit: "abc1234" },
        counts: { tasks: 2, todos: 2, managerMessages: comm },
        nextTaskNumber: 3,
        nextTodoNumber: 3,
      });
      assert.deepEqual(JSON.parse(bareGit(bare, "show", `${pushed.sha}:tasks/T-001/task.json`)), JSON.parse(JSON.stringify(h.store.getTask("T-001"))));
      assert.deepEqual(JSON.parse(bareGit(bare, "show", `${pushed.sha}:todos.json`)), JSON.parse(JSON.stringify(todos.list())));
      assert.deepEqual(JSON.parse(bareGit(bare, "show", `${pushed.sha}:repos.json`)), [{ id: "sample", name: "sample", defaultBranch: "main", remoteUrl: null }]);
      assert.equal(rawBlob(bare, pushed.sha, "tasks/T-001/doc-r1.html"), "<p>Design, round 1</p>\r\n", "files are stored byte for byte");
      assert.deepEqual(checkoutState(h), before, "checkout, index, branches and refs are untouched");

      // Pushing the same data again changes nothing; changed data goes on top of the branch.
      const again = await sync.push({ repoId: "sample", name: "task_data/devbox" });
      assert.deepEqual([again.sha, again.unchanged, again.created, again.summary], [pushed.sha, true, false, "task_data/devbox on origin already has this data"]);
      todos.update("TD-002", { title: "Runbook" });
      const next = await sync.push({ repoId: "sample", name: "devbox" });
      assert.deepEqual([next.unchanged, next.created], [false, false]);
      assert.equal(bareGit(bare, "rev-parse", `${next.sha}^`), pushed.sha);
      assert.equal(JSON.parse(bareGit(bare, "show", `${next.sha}:todos.json`))[1].title, "Runbook");
      assert.deepEqual(checkoutState(h), before);

      // Only task_data branches are listed.
      bareGit(bare, "branch", "main-copy", pushed.sha);
      assert.deepEqual((await sync.branches("sample")).branches, [{ name: "devbox", branch: "task_data/devbox", sha: next.sha }]);

      for (const name of ["", "  ", "two words", "../up", "a..b", "-x", "x.lock", "x/"]) {
        await assert.rejects(sync.push({ repoId: "sample", name }), httpError(400, /name/), JSON.stringify(name));
      }
      assert.equal(dataBranchName("refs/heads/task_data/team/devbox"), "task_data/team/devbox");
      await assert.rejects(sync.push({ name: "x" }), httpError(400, /^Choose the repository whose remote holds the data branches$/));
      await assert.rejects(sync.push({ repoId: "nope", name: "x" }), httpError(404, /^Repository nope not found$/));
      fs.mkdirSync(plain);
      git(plain, "init", "-q", "-b", "main");
      git(plain, "commit", "-q", "--allow-empty", "-m", "init");
      h.store.addRepo({ id: "plain", name: "plain", path: plain, defaultBranch: "main", remoteUrl: null, addedAt: new Date().toISOString() });
      await assert.rejects(sync.push({ repoId: "plain", name: "x" }), httpError(400, /^plain has no git remote for data branches/));
      await assert.rejects(sync.preview({ repoId: "sample", name: "missing" }), httpError(404, /^task_data\/missing does not exist on origin$/));
    } finally {
      h.cleanup();
    }
  });

  test("merging another hub's data adds what is new (renumbering taken ids), keeps references, and never runs its tasks here", async () => {
    const source = await hubWithData("DEVBOX");
    const h2 = createHarness({}, { ready: false });
    const todos2 = new TodoService(h2.store, h2.bus, h2.runner);
    const sync2 = syncFor(h2, todos2, "LAPTOP");
    const loaded: string[] = [];
    h2.bus.onGlobal((message) => {
      if (message.type === "data-loaded") loaded.push(message.text);
    });
    try {
      shareRemote(source.h, h2);
      const own = await h2.runner.submit({ kind: "coding", description: "Fix the login bug", repoId: "sample" });
      h2.runner.cancel(own.id);
      todos2.create({ description: "Plan the release" });
      const pushed = await source.sync.push({ repoId: "sample", name: "devbox" });
      const before = checkoutState(h2);

      const preview = await sync2.preview({ repoId: "sample", name: "devbox" });
      assert.equal(preview.sha, pushed.sha);
      assert.equal(preview.manifest.host, "DEVBOX");
      assert.ok(preview.pushedAt && Date.now() - Date.parse(preview.pushedAt) < 60_000);
      const sourceComm = (await commOf(source.h)).length;
      assert.deepEqual(preview.merge, {
        tasks: { added: 2, renumbered: 1, updated: 0, unchanged: 0, keptNewer: 0, keptBusy: 0 },
        todos: { added: 2, renumbered: 1, updated: 0, unchanged: 0, keptNewer: 0, keptBusy: 0 },
        managerMessages: sourceComm,
      });
      assert.deepEqual(preview.replace, { tasks: 2, todos: 2, managerMessages: sourceComm, removes: { tasks: 1, todos: 1 }, blockedBy: [] });
      assert.deepEqual(preview.repositories, [{ id: "sample", name: "sample", localId: "sample", tasks: 2, todos: 1 }]);
      assert.equal(h2.store.tasks.length, 1, "a preview changes nothing");

      const result = await sync2.load({ repoId: "sample", name: "devbox", mode: "merge", sha: pushed.sha });
      assert.equal(
        result.summary,
        `Merged task_data/devbox: 2 tasks added (1 under new ids); 2 to-dos added (1 under new ids); ${sourceComm} manager messages added`,
      );
      assert.deepEqual(loaded, [result.summary], "open pages are told to reload");
      assert.deepEqual(checkoutState(h2), before);

      // The source's T-002 keeps its id (never used here); its T-001 is taken here, so it becomes T-003. Same for to-dos.
      const sourceDone = source.h.store.getTask("T-001")!;
      const sourceQueued = source.h.store.getTask("T-002")!;
      const done = h2.store.getTask("T-003")!;
      const queued = h2.store.getTask("T-002")!;
      assert.equal(h2.store.getTask("T-001")?.description, "Fix the login bug", "the task here is untouched");
      assert.deepEqual([done.title, done.status, done.syncId, done.todoId], [sourceDone.title, "completed", `T-001@${sourceDone.createdAt}`, "TD-003"]);
      assert.deepEqual([queued.description, queued.syncId], [sourceQueued.description, undefined]);
      assert.equal(queued.status, "interrupted", "a task queued or running there is not started here");
      assert.equal(h2.store.getTodo("TD-001")?.description, "Plan the release");
      assert.deepEqual(
        [h2.store.getTodo("TD-003")?.description, h2.store.getTodo("TD-003")?.taskId, h2.store.getTodo("TD-003")?.syncId],
        ["Add multiplication to calc.js", "T-003", `TD-001@${source.todos.get("TD-001").createdAt}`],
      );
      assert.equal(h2.store.getTodo("TD-002")?.description, "Write the runbook");
      assert.deepEqual(h2.store.counters, { nextTaskNumber: 4, nextTodoNumber: 4 });
      assert.equal((await h2.runner.submit({ kind: "coding", description: "Next", repoId: "sample" })).id, "T-004");

      // The other machine's folders and agent sessions are dropped; the timeline, documents and messages come along.
      assert.ok(sourceDone.workspaceRoot && sourceDone.sessions.length && sourceDone.agents?.some((agent) => agent.sessionId));
      assert.equal(done.workspaceRoot, undefined);
      assert.deepEqual(done.sessions, []);
      assert.ok(done.agents?.length && done.agents.every((agent) => agent.sessionId === undefined && agent.workspace === undefined));
      assert.equal(await h2.store.readArtifact("T-003", "doc-r1.html"), "<p>Design, round 1</p>\r\n");
      const events = await h2.store.readEvents("T-003");
      const sourceEvents = JSON.parse(JSON.stringify(await source.h.store.readEvents("T-001")));
      assert.deepEqual(events.slice(0, -1), sourceEvents);
      assert.match(events.at(-1)!.text, /^Loaded from task_data\/devbox on origin \(pushed from DEVBOX on \d{4}-\d\d-\d\d \d\d:\d\d UTC\); it is T-001 there$/);
      const messages = h2.store.recentComm({ taskId: "T-003", limit: 1000 });
      assert.deepEqual(
        messages.map((entry) => entry.text),
        (await commOf(source.h)).filter((entry) => entry.taskId === "T-001").map((entry) => entry.text),
      );
      assert.ok(messages.every((entry, index) => index === 0 || entry.seq > messages[index - 1]!.seq));

      // Loading the same data again changes nothing.
      const again = await sync2.load({ repoId: "sample", name: "devbox" });
      assert.deepEqual([again.tasks.unchanged, again.tasks.added, again.todos.unchanged, again.managerMessages], [2, 0, 2, 0]);

      // Round trip: the data comes back to the first hub without duplicates (matched by identity, whatever the ids).
      // Here T-002 is still queued (kept); the other hub's own T-004 keeps its id, its T-001 becomes T-005.
      await sync2.push({ repoId: "sample", name: "laptop" });
      const back = await source.sync.load({ repoId: "sample", name: "laptop" });
      assert.deepEqual(back.tasks, { added: 2, renumbered: 1, updated: 0, unchanged: 1, keptNewer: 0, keptBusy: 1 });
      assert.deepEqual(back.todos, { added: 1, renumbered: 1, updated: 0, unchanged: 2, keptNewer: 0, keptBusy: 0 });
      assert.deepEqual(
        source.h.store.tasks.map((task) => [task.id, task.description]),
        [
          ["T-001", "Add multiplication to calc.js"],
          ["T-002", "Add division to calc.js"],
          ["T-005", "Fix the login bug"],
          ["T-004", "Next"],
        ],
      );
      assert.equal(source.h.store.getTask("T-002")?.status, "queued", "a task in progress here is kept as it is");

      // A newer copy replaces the older one, under the id it has here; messages both sides have are not added twice.
      const remote = h2.store.getTask("T-003")!;
      remote.title = "Multiplication, revised";
      remote.updatedAt = new Date(Date.now() + 1000).toISOString();
      h2.store.saveTask(remote);
      await sync2.push({ repoId: "sample", name: "laptop" });
      const messagesBefore = (await commOf(source.h)).filter((entry) => entry.taskId === "T-001").length;
      const update = await source.sync.load({ repoId: "sample", name: "laptop" });
      assert.deepEqual([update.tasks.updated, update.managerMessages], [1, 0]);
      const updated = source.h.store.getTask("T-001")!;
      assert.deepEqual([updated.title, updated.syncId, updated.todoId], ["Multiplication, revised", undefined, "TD-001"]);
      assert.match((await source.h.store.readEvents("T-001")).at(-1)!.text, /^Updated with the newer copy from task_data\/laptop on origin \(pushed from LAPTOP on /);
      assert.equal((await commOf(source.h)).filter((entry) => entry.taskId === "T-001").length, messagesBefore);
    } finally {
      h2.cleanup();
      source.h.cleanup();
    }
  });

  test("replacing the data backs it up, deletes the tasks here and loads the branch's under their own ids; tasks in progress block it", async () => {
    const source = await hubWithData("DEVBOX");
    const h3 = createHarness({}, { ready: false });
    const todos3 = new TodoService(h3.store, h3.bus, h3.runner);
    const sync3 = syncFor(h3, todos3, "OTHER");
    try {
      shareRemote(source.h, h3);
      await source.sync.push({ repoId: "sample", name: "devbox" });
      const own = await h3.runner.submit({ kind: "coding", description: "Fix the login bug", repoId: "sample" });
      todos3.create({ description: "Plan the release" });

      const preview = await sync3.preview({ repoId: "sample", name: "devbox" });
      assert.deepEqual(preview.replace.blockedBy, ["T-001"]);
      await assert.rejects(
        sync3.load({ repoId: "sample", name: "devbox", mode: "replace" }),
        httpError(409, /^Replacing the data deletes every task here, and T-001 is in progress: cancel it or let it finish first$/),
      );
      assert.equal(h3.store.getTask("T-001")?.description, "Fix the login bug");

      h3.runner.cancel(own.id);
      const result = await sync3.load({ repoId: "sample", name: "devbox", mode: "replace" });
      const sourceComm = await commOf(source.h);
      assert.equal(result.summary, `Replaced this hub's data (1 task, 1 to-do) with task_data/devbox: 2 tasks, 2 to-dos and ${sourceComm.length} manager messages`);
      assert.deepEqual(result.removed, { tasks: 1, todos: 1 });
      assert.ok(result.backup?.startsWith(h3.store.paths.backups));
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup!, "tasks", "T-001", "task.json"), "utf8")).description, "Fix the login bug");
      assert.equal(JSON.parse(fs.readFileSync(path.join(result.backup!, "todos.json"), "utf8"))[0].description, "Plan the release");
      assert.ok(fs.existsSync(path.join(result.backup!, "manager-log.jsonl")));

      // The branch's records keep their ids; nothing of the old data is left (its manager messages included).
      assert.deepEqual(
        h3.store.tasks.map((task) => [task.id, task.description, task.syncId]),
        source.h.store.tasks.map((task) => [task.id, task.description, undefined]),
      );
      assert.deepEqual(h3.store.todos.map((todo) => [todo.id, todo.description, todo.taskId]), source.todos.list().map((todo) => [todo.id, todo.description, todo.taskId]));
      assert.deepEqual(
        (await commOf(h3)).map((entry) => [entry.taskId, entry.text]),
        sourceComm.map((entry) => [entry.taskId, entry.text]),
      );
      assert.equal(h3.store.counters.nextTaskNumber, 3);
      assert.equal(h3.store.getTask("T-002")?.status, "interrupted");
    } finally {
      h3.cleanup();
      source.h.cleanup();
    }
  });

  test("planning matches records by identity: the newer copy wins, records in progress are kept, ids are reused only when never used here", () => {
    const task = fakeTask;
    const todo = fakeTodo;
    const snapshot: Snapshot = {
      manifest: { format: 1, host: "x", hub: { version: "1", commit: null }, counts: { tasks: 5, todos: 1, managerMessages: 0 }, nextTaskNumber: 10, nextTodoNumber: 2 },
      repos: [{ id: "app", name: "App", remoteUrl: "git@github.com:Acme/App.git" }],
      tasks: [
        task("T-001", 1, 9), // newer than the copy here
        task("T-002", 2, 2), // the same version
        task("T-003", 3, 3), // older than the copy here
        task("T-004", 4, 9), // running here
        task("T-005", 5, 5, { todoId: "TD-001" }), // new, but T-005 was used here before (counter 7): renumbered
        task("T-008", 8, 8), // new and never used here: keeps its id
      ].map((item) => ({ task: item, files: new Map() })),
      todos: [todo("TD-001", 1, 1, { taskId: "T-005", repoId: "app" })],
      comm: [],
      skipped: 0,
    };
    const local: LocalState = {
      tasks: [task("T-001", 1, 5), task("T-002", 2, 2), task("T-003", 3, 8), task("T-004", 4, 4, { status: "running" }), task("T-006", 6, 6)],
      todos: [],
      repos: [{ id: "web-app", name: "app", path: "/x", defaultBranch: "main", remoteUrl: "https://github.com/acme/app", addedAt: at(0) }],
      counters: { nextTaskNumber: 7, nextTodoNumber: 1 },
      busyTask: (id) => id === "T-004",
      busyTodo: () => false,
      comm: [],
    };
    const plan = planLoad(snapshot, local, { keepLowIds: false });
    assert.deepEqual(plan.taskCounts, { added: 2, renumbered: 1, updated: 1, unchanged: 1, keptNewer: 1, keptBusy: 1 });
    assert.deepEqual(
      plan.tasks.map((item) => [item.sourceId, item.task.id, item.replaces, item.renumbered, item.task.syncId ?? null]),
      [
        ["T-001", "T-001", true, false, null],
        ["T-008", "T-008", false, false, null],
        ["T-005", "T-009", false, true, `T-005@${at(5)}`],
      ],
    );
    // The repository is matched by its remote (whatever the id and URL form); references follow the new ids.
    assert.ok(plan.tasks.every((item) => item.task.repoId === "web-app" && item.task.repoName === "app"));
    assert.equal(plan.tasks[2]!.task.todoId, "TD-001");
    assert.deepEqual(plan.todos.map((item) => [item.id, item.taskId, item.repoId]), [["TD-001", "T-009", "web-app"]]);
    assert.deepEqual([plan.nextTaskNumber, plan.nextTodoNumber], [10, 2]);
    assert.deepEqual(plan.repositories, [{ id: "app", name: "App", localId: "web-app", tasks: 6, todos: 1 }]);
    // After the data here was removed (replace), free ids are kept even below the counter.
    assert.deepEqual(
      planLoad(snapshot, { ...local, tasks: [], counters: { nextTaskNumber: 20, nextTodoNumber: 5 } }, { keepLowIds: true }).tasks.map((item) => item.task.id),
      ["T-001", "T-002", "T-003", "T-004", "T-005", "T-008"],
    );
    assert.equal(identityOf({ id: "T-009", createdAt: at(5), syncId: `T-005@${at(5)}` }), `T-005@${at(5)}`);

    // Numbers beyond any plausible count are not kept (they would break numbering here).
    const huge = planLoad(
      { ...snapshot, tasks: [{ task: task("T-9007199254740993", 1, 1), files: new Map() }, { task: task("T-1000000000000000000000", 2, 2), files: new Map() }], todos: [] },
      { ...local, tasks: [], counters: { nextTaskNumber: 5, nextTodoNumber: 1 } },
      { keepLowIds: false },
    );
    assert.deepEqual(huge.tasks.map((item) => item.task.id), ["T-005", "T-006"]);
    assert.equal(huge.nextTaskNumber, 7);

    // New events continue after the timeline's last event, whatever the record says; a torn last line is dropped.
    const timeline = Buffer.from(`${[1, 2, 5].map((seq) => JSON.stringify({ seq, ts: at(1), type: "info", text: `e${seq}` })).join("\n")}\n{"seq":6,"ts`);
    const resumed = planLoad({ ...snapshot, tasks: [{ task: task("T-030", 1, 1, { lastSeq: 2 }), files: new Map([["events.jsonl", timeline]]) }], todos: [] }, { ...local, tasks: [] }, { keepLowIds: false });
    assert.equal(resumed.tasks[0]!.task.lastSeq, 5);
    assert.ok(resumed.tasks[0]!.files.get("events.jsonl")!.toString().endsWith('"text":"e5"}\n'));
  });

  test("loaded task folders are swapped in only once all of them are written", () => {
    const h = createHarness({}, { ready: false });
    try {
      h.store.putLoadedTasks([{ task: fakeTask("T-001", 1, 1, { repoId: "sample" }), files: new Map([["events.jsonl", Buffer.from("{}\n")]]) }]);
      assert.equal(h.store.getTask("T-001")?.title, "T-001");
      const failing = [
        { task: fakeTask("T-001", 1, 2, { title: "Changed" }), files: new Map([["events.jsonl", Buffer.from("[]\n")]]) },
        { task: fakeTask("T-002", 2, 2), files: new Map([["doc-r1.html", 42 as unknown as Buffer]]) },
      ];
      assert.throws(() => h.store.putLoadedTasks(failing));
      assert.deepEqual(h.store.tasks.map((task) => [task.id, task.title]), [["T-001", "T-001"]], "nothing was swapped in");
      assert.equal(fs.readFileSync(path.join(h.store.taskDir("T-001"), "events.jsonl"), "utf8"), "{}\n");
      assert.equal(JSON.parse(fs.readFileSync(h.store.taskFile("T-001"), "utf8")).title, "T-001");
      assert.deepEqual(fs.readdirSync(h.store.paths.tasks), ["T-001"], "no staging folder is left behind");
    } finally {
      h.cleanup();
    }
  });

  test("a data branch cannot smuggle git options, patterns or other folders into the hub: such records are left out", () => {
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    const files = new Map<string, Buffer>([
      ["agent-hub-data.json", json({ format: 1, host: "x", hub: { version: "1", commit: null }, counts: {}, nextTaskNumber: 9, nextTodoNumber: 3 })],
      ["tasks/T-001/task.json", json(fakeTask("T-001", 1, 1, { branch: "agent-hub/t-001-fine", baseSha: "a".repeat(40) }))],
      ["tasks/T-001/events.jsonl", Buffer.from("{}\n")],
      ["tasks/T-002/task.json", json(fakeTask("T-002", 2, 2, { branch: "*" }))],
      ["tasks/T-003/task.json", json(fakeTask("T-003", 3, 3, { baseSha: "--output=C:/evil" }))],
      ["tasks/T-004/task.json", json(fakeTask("T-004", 4, 4, { stages: [{ kind: "coding", status: "approved", rounds: [{ n: 1, attempt: 1, startedAt: at(4), author: { summary: "", responses: [], commit: "-x", at: at(4) } }], nextCommentNumber: 1 }] }))],
      ["tasks/T-005/task.json", json(fakeTask("T-009", 5, 5))],
      ["tasks/T-006/task.json", json(fakeTask("T-006", 6, 6, { baseRef: "--upload-pack=evil" }))],
      ["tasks/../task.json", json(fakeTask("..", 7, 7))],
      // Records the task list cannot show would break every page that lists tasks.
      ["tasks/T-007/task.json", json(fakeTask("T-007", 7, 7, { agents: "x" as unknown as Task["agents"] }))],
      ["tasks/T-008/task.json", json(fakeTask("T-008", 8, 8, { stages: [{ kind: "coding" }] as unknown as Task["stages"] }))],
      ["tasks/T-010/task.json", json(fakeTask("T-010", 10, 10, { review: { target: null } } as unknown as Partial<Task>))],
      // Files Windows treats specially, or with very long names, are not written.
      ["tasks/T-001/CON", Buffer.from("x")],
      ["tasks/T-001/nul.txt", Buffer.from("x")],
      ["tasks/T-001/trailing.", Buffer.from("x")],
      [`tasks/T-001/${"a".repeat(150)}.html`, Buffer.from("x")],
      ["todos.json", json([fakeTodo("TD-001", 1, 1, { baseRef: "--upload-pack=evil" }), fakeTodo("TD-002", 2, 2, { baseRef: "release/1.0" })])],
    ]);
    const snapshot = parseSnapshot(files);
    assert.deepEqual(snapshot.tasks.map((item) => item.task.id), ["T-001"]);
    assert.deepEqual([...snapshot.tasks[0]!.files.keys()], ["events.jsonl"]);
    assert.deepEqual(snapshot.todos.map((item) => item.id), ["TD-002"]);
    assert.equal(snapshot.skipped, 9);
    assert.throws(() => parseSnapshot(new Map([["agent-hub-data.json", json({ format: 2 })]])), httpError(400, /newer version of Agent Hub/));
  });

  test("HTTP: info, branches, push, preview and load; a branch without hub data is refused", async () => {
    const source = await hubWithData("DEVBOX");
    const h = source.h;
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
        todos: source.todos,
        sync: source.sync,
        build: { version: "test", commit: null, ui: "test" },
      }),
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) }),
      });
      return { status: response.status, json: (await response.json()) as any };
    };
    try {
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      const bare = shareRemote(h);
      assert.deepEqual((await call("GET", "/api/sync")).json, { prefix: "task_data/", host: "DEVBOX", suggestedName: "devbox" });
      assert.deepEqual((await call("GET", "/api/sync/branches")).status, 400);
      assert.deepEqual((await call("GET", "/api/sync/branches?repoId=nope")).status, 404);
      assert.deepEqual((await call("GET", "/api/sync/branches?repoId=sample")).json, { remote: { name: "origin", url: bare }, branches: [] });

      const pushed = await call("POST", "/api/sync/push", { repoId: "sample", name: "devbox" });
      assert.equal(pushed.status, 200, pushed.json.error);
      assert.equal(pushed.json.branch, "task_data/devbox");
      assert.deepEqual((await call("GET", "/api/sync/branches?repoId=sample")).json.branches, [{ name: "devbox", branch: "task_data/devbox", sha: pushed.json.sha }]);

      const preview = await call("GET", "/api/sync/preview?repoId=sample&name=devbox");
      assert.equal(preview.status, 200, preview.json.error);
      assert.deepEqual(preview.json.merge.tasks, { added: 0, renumbered: 0, updated: 0, unchanged: 1, keptNewer: 0, keptBusy: 1 });
      assert.deepEqual(preview.json.replace.blockedBy, ["T-002"]);

      // A load refuses a branch that changed since its preview.
      source.todos.update("TD-002", { title: "Runbook" });
      const moved = await call("POST", "/api/sync/push", { repoId: "sample", name: "devbox" });
      const stale = await call("POST", "/api/sync/load", { repoId: "sample", name: "devbox", mode: "merge", sha: pushed.json.sha });
      assert.deepEqual([stale.status, stale.json.error], [409, "task_data/devbox changed on origin since it was previewed; preview it again"]);
      const merged = await call("POST", "/api/sync/load", { repoId: "sample", name: "devbox", mode: "merge", sha: moved.json.sha });
      assert.equal(merged.status, 200, merged.json.error);
      assert.deepEqual(merged.json.todos, { added: 0, renumbered: 0, updated: 0, unchanged: 2, keptNewer: 0, keptBusy: 0 });
      assert.equal((await call("POST", "/api/sync/load", { repoId: "sample", name: "devbox", mode: "overwrite" })).status, 400);

      // A data branch must hold hub data.
      const junk = git(h.repoPath, "commit-tree", git(h.repoPath, "write-tree"), "-m", "not hub data");
      git(h.repoPath, "push", "-q", "origin", `${junk}:refs/heads/task_data/junk`);
      const refused = await call("GET", "/api/sync/preview?repoId=sample&name=junk");
      assert.deepEqual([refused.status, refused.json.error], [400, "This branch holds no Agent Hub data (agent-hub-data.json is missing)"]);
    } finally {
      server.close();
      h.cleanup();
    }
  });
});
