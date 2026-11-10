import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import type { CopilotService } from "../src/copilot/service.ts";
import { DataSync } from "../src/datasync.ts";
import { createApiRouter, DESCRIPTION_BODY_BYTES } from "../src/http/api.ts";
import { createHttpServer } from "../src/http/server.ts";
import type { RepoService } from "../src/repos.ts";
import { Store } from "../src/store.ts";
import { TodoService } from "../src/todos.ts";
import type { Task, Todo } from "../src/types.ts";
import { HttpError } from "../src/util.ts";
import type { SubmitTaskInput } from "../src/workflow/runner.ts";
import { summarizeTask } from "../src/workflow/summary.ts";
import { createHarness, steps, submitPlan, submitReview, submitWork, writeFile, type Harness } from "./helpers.ts";

/** Matches an HttpError with this status and message. */
const httpError =
  (status: number, message: RegExp) =>
  (error: unknown): true => {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    assert.match(error.message, message);
    return true;
  };

/** The fields the user controls (without timestamps). */
const fields = ({ createdAt: _created, updatedAt: _updated, ...rest }: Todo) => rest;

/** The hub's HTTP API for the harness, on a free local port. */
async function serveApi(h: Harness) {
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  const todos = new TodoService(h.store, h.bus, h.runner);
  const router = createApiRouter({
    store: h.store,
    bus: h.bus,
    runner: h.runner,
    copilot: {} as CopilotService,
    repos: {} as RepoService,
    todos,
    sync: new DataSync({ store: h.store, bus: h.bus, runner: h.runner, todos, build: { version: "test", commit: null } }),
    build: { version: "test", commit: null, ui: "test" },
  });
  const server = createHttpServer({ host: "127.0.0.1", port, publicDir: path.join(import.meta.dirname, "..", "public"), router });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const call = async (method: string, url: string, body: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      ...(method === "GET" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, json: (await response.json()) as any };
  };
  return { router, call, close: () => server.close() };
}

describe("to-do list", () => {
  test("to-dos get ids that are never reused, and are validated, edited, deleted and kept across restarts", () => {
    const h = createHarness({}, { ready: false });
    const todos = new TodoService(h.store, h.bus, h.runner);
    const published: string[][] = [];
    h.bus.onGlobal((message) => {
      if (message.type === "todos") published.push(message.todos.map((todo) => `${todo.id}:${todo.status}`));
    });
    try {
      assert.throws(() => todos.create({}), httpError(400, /^Describe the work: the description is what the manager agent gets$/));
      assert.throws(() => todos.create({ description: "  \n " }), httpError(400, /^Describe the work/));
      assert.throws(() => todos.create({ description: 42 }), httpError(400, /^'description' must be a string$/));
      assert.throws(() => todos.create({ description: "x", title: "t".repeat(201) }), httpError(400, /^'title' is too long \(max 200 characters\)$/));
      assert.throws(() => todos.create({ description: "x", repoId: "nope" }), httpError(400, /^Repository 'nope' is not registered$/));
      assert.throws(() => todos.create({ description: "x", baseRef: "main" }), httpError(400, /^Choose the repository before the branch$/));
      assert.throws(() => todos.create({ description: "x", repoId: "sample", baseRef: "--force" }), httpError(400, /^'--force' is not a branch name$/));
      assert.deepEqual(todos.list(), []);
      assert.deepEqual(published, [], "rejected input changes nothing");

      const first = todos.create({ description: "  Add retry support to the uploader\n\nKeep the API unchanged.  ", repoId: "sample", baseRef: "refs/heads/main" });
      assert.deepEqual(fields(first), {
        id: "TD-001",
        title: "",
        description: "Add retry support to the uploader\n\nKeep the API unchanged.",
        repoId: "sample",
        baseRef: "main",
        status: "open",
      });
      const second = todos.create({ description: "Write the runbook", title: "  Runbook  " });
      assert.deepEqual(fields(second), { id: "TD-002", title: "Runbook", description: "Write the runbook", status: "open" }, "the repository can be chosen later");
      assert.deepEqual(published, [["TD-001:open"], ["TD-001:open", "TD-002:open"]], "every change is published to the pages");

      // Only the given fields change; choosing another repository clears the branch unless one is given.
      h.store.addRepo({ id: "other", name: "other", path: h.repoPath, defaultBranch: "main", remoteUrl: null, addedAt: new Date().toISOString() });
      const titled = todos.update("TD-001", { title: "Retry uploads" });
      assert.deepEqual([titled.title, titled.repoId, titled.baseRef, titled.description], ["Retry uploads", "sample", "main", first.description]);
      assert.equal(todos.update("TD-001", { repoId: "sample" }).baseRef, "main", "the same repository keeps the branch");
      const moved = todos.update("TD-001", { repoId: "other" });
      assert.deepEqual([moved.repoId, moved.baseRef], ["other", undefined]);
      assert.equal(Object.hasOwn(moved, "baseRef"), false);
      const back = todos.update("TD-001", { repoId: "sample", baseRef: "main" });
      assert.deepEqual([back.repoId, back.baseRef], ["sample", "main"]);
      assert.throws(() => todos.update("TD-001", { description: " " }), httpError(400, /^The description cannot be empty; delete the to-do instead$/));
      assert.throws(() => todos.update("TD-001", { repoId: "nope" }), httpError(400, /^Repository 'nope' is not registered$/));
      assert.deepEqual([todos.get("TD-001").repoId, todos.get("TD-001").title], ["sample", "Retry uploads"], "a rejected edit changes nothing");
      todos.update("TD-002", { repoId: "sample", baseRef: "main" });
      const cleared = todos.update("TD-002", { repoId: null, title: "" });
      assert.deepEqual(fields(cleared), { id: "TD-002", title: "", description: "Write the runbook", status: "open" }, "clearing the repository clears the branch too");
      assert.throws(() => todos.update("TD-009", { title: "x" }), httpError(404, /^To-do TD-009 not found$/));
      assert.throws(() => todos.get("TD-009"), httpError(404, /^To-do TD-009 not found$/));

      todos.remove("TD-001");
      assert.deepEqual(todos.list().map((todo) => todo.id), ["TD-002"]);
      assert.deepEqual(published.at(-1), ["TD-002:open"]);
      assert.throws(() => todos.remove("TD-001"), httpError(404, /not found/));

      // A restarted hub has the same list and continues the numbering.
      const dataDir = path.join(h.root, "data");
      const restarted = new Store(dataDir);
      restarted.load();
      assert.deepEqual(restarted.todos, todos.list());
      assert.equal(restarted.allocateTodoId(), "TD-003", "ids are never reused, even after a delete");
      // A hub.json written before to-dos existed continues after the highest id on the list.
      const hubFile = path.join(dataDir, "hub.json");
      const meta = JSON.parse(fs.readFileSync(hubFile, "utf8")) as Record<string, unknown>;
      delete meta.nextTodoNumber;
      fs.writeFileSync(hubFile, JSON.stringify(meta));
      fs.writeFileSync(path.join(dataDir, "todos.json"), JSON.stringify([...todos.list(), { id: "bogus" }, null]));
      const older = new Store(dataDir);
      older.load();
      assert.deepEqual(older.todos.map((todo) => todo.id), ["TD-002"], "invalid entries are ignored");
      assert.equal(older.allocateTodoId(), "TD-003");
      assert.equal(older.storageInfo().todos, 1);
    } finally {
      h.cleanup();
    }
  });

  test("sending a to-do hands it to the manager as an Auto task; it can be reopened, changed and sent again once that task stops", async () => {
    const h = createHarness({}, { ready: false });
    const todos = new TodoService(h.store, h.bus, h.runner);
    try {
      const todo = todos.create({ description: "Add retry support to the uploader\nKeep the API unchanged.", title: "Retry uploads", repoId: "sample", baseRef: "main" });
      const later = todos.create({ description: "Write the runbook" });
      await assert.rejects(todos.send(later.id), httpError(400, /^Choose the repository TD-002 is for before sending it to the manager$/));
      assert.equal(h.store.tasks.length, 0);

      // Two quick clicks send it once.
      const [sent, again] = await Promise.allSettled([todos.send(todo.id), todos.send(todo.id)]);
      if (sent.status !== "fulfilled") assert.fail(String(sent.reason));
      assert.equal(again.status, "rejected");
      httpError(409, /^TD-001 is being sent to the manager right now$/)(again.reason);
      const task = sent.value.task;
      assert.equal(h.store.tasks.length, 1);
      assert.deepEqual(
        [task.kind, task.title, task.description, task.repoId, task.baseRef, task.todoId, task.status],
        ["auto", "Retry uploads", "Add retry support to the uploader\nKeep the API unchanged.", "sample", "main", "TD-001", "queued"],
      );
      const stored = todos.get(todo.id);
      assert.deepEqual([stored.status, stored.taskId], ["sent", task.id]);
      assert.ok(stored.sentAt && stored.sentAt >= stored.createdAt);
      assert.equal(sent.value.todo, stored);
      assert.equal(summarizeTask(task).todoId, "TD-001");
      assert.ok(
        h.store.recentComm({ taskId: task.id }).some((entry) => entry.text === "New Auto (manager plans) task on sample @ main (from to-do TD-001): Add retry support to the uploader"),
        "the manager's log says where the task came from",
      );

      // A sent to-do is read-only until it is reopened, and it can only be reopened once its task stops.
      assert.throws(() => todos.update(todo.id, { title: "x" }), httpError(409, new RegExp(`^TD-001 was already sent to the manager as ${task.id}; reopen it to change it$`)));
      await assert.rejects(todos.send(todo.id), httpError(409, new RegExp(`^TD-001 was already sent to the manager as ${task.id}; reopen it to send it again$`)));
      assert.throws(() => todos.reopen(later.id), httpError(409, /^TD-002 has not been sent to the manager$/));
      assert.throws(() => todos.reopen(todo.id), httpError(409, new RegExp(`^${task.id} is still queued; cancel it or let it finish before reopening TD-001$`)));

      h.runner.cancel(task.id);
      const reopened = todos.reopen(todo.id);
      assert.deepEqual([reopened.status, reopened.taskId, reopened.sentAt], ["open", task.id, stored.sentAt], "a reopened to-do remembers where it was last sent");
      todos.update(todo.id, { description: "Add retry support to the uploader, with exponential backoff" });
      const resent = await todos.send(todo.id);
      assert.notEqual(resent.task.id, task.id);
      assert.equal(resent.task.description, "Add retry support to the uploader, with exponential backoff");
      assert.equal(todos.get(todo.id).taskId, resent.task.id);
      assert.equal(h.store.getTask(task.id)?.status, "cancelled", "the earlier task is kept");

      // Once its task is deleted, a sent to-do can be reopened; deleting a to-do keeps its task.
      h.runner.cancel(resent.task.id);
      await h.runner.remove(resent.task.id);
      assert.equal(todos.reopen(todo.id).status, "open");
      const third = await todos.send(todo.id);
      todos.remove(todo.id);
      assert.ok(h.store.getTask(third.task.id), "deleting a to-do keeps its task");
      assert.equal(h.store.getTask(third.task.id)?.todoId, "TD-001");
    } finally {
      h.cleanup();
    }
  });

  test("a send in flight blocks edits, deletes and second sends; a failed send leaves the to-do on the list", async () => {
    const h = createHarness({}, { ready: false });
    const submitted: SubmitTaskInput[] = [];
    let failure: Error | null = null;
    let release: () => void = () => assert.fail("no send is waiting");
    const runner = {
      submit: async (input: SubmitTaskInput): Promise<Task> => {
        submitted.push(input);
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { id: "T-042" } as Task;
      },
    };
    const todos = new TodoService(h.store, h.bus, runner);
    try {
      const todo = todos.create({ description: "Add retry support", repoId: "sample" });
      failure = new HttpError(400, "Choose the author and reviewer models first (Settings)");
      await assert.rejects(todos.send(todo.id), httpError(400, /^Choose the author and reviewer models first \(Settings\)$/));
      assert.deepEqual([todos.get(todo.id).status, todos.get(todo.id).taskId], ["open", undefined], "a failed send leaves the to-do open");

      failure = null;
      const sending = todos.send(todo.id);
      assert.throws(() => todos.update(todo.id, { title: "x" }), httpError(409, /^TD-001 is being sent to the manager right now$/));
      assert.throws(() => todos.remove(todo.id), httpError(409, /^TD-001 is being sent to the manager right now$/));
      await assert.rejects(todos.send(todo.id), httpError(409, /^TD-001 is being sent to the manager right now$/));
      release();
      const { todo: sent } = await sending;
      assert.deepEqual([sent.status, sent.taskId], ["sent", "T-042"]);
      assert.equal(submitted.length, 2, "the blocked send never reached the manager");
      assert.deepEqual(submitted[1], { kind: "auto", title: undefined, description: "Add retry support", repoId: "sample", baseRef: undefined, todoId: "TD-001" });
      todos.remove(todo.id);
      assert.deepEqual(todos.list(), []);
    } finally {
      h.cleanup();
    }
  });

  test("the manager agent plans and runs a to-do it was sent", async () => {
    const h = createHarness({
      planner: [
        steps((spec, prompt) => {
          assert.equal(spec.submit.kind, "plan");
          assert.match(prompt, /Add multiplication support to calc\.js and cover it with a unit test/);
        }, submitPlan(["coding"], { coding: "Add mul(a, b) to calc.js with a unit test" })),
      ],
      coder: [
        steps((_spec, prompt) => {
          assert.match(prompt, /## Manager's assignment for this stage\n\nAdd mul\(a, b\) to calc\.js with a unit test/);
        }, writeFile("calc.js", "export const mul = (a, b) => a * b;\n"), submitWork("Added mul()")),
      ],
      "code-reviewer": [submitReview("approve")],
    });
    const todos = new TodoService(h.store, h.bus, h.runner);
    try {
      const todo = todos.create({ description: "Add multiplication support to calc.js and cover it with a unit test", repoId: "sample" });
      const { task: created } = await todos.send(todo.id);
      assert.throws(() => todos.reopen(todo.id), httpError(409, new RegExp(`^${created.id} is still (queued|running)`)));
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.deepEqual([task.kind, task.todoId, task.title], ["auto", "TD-001", "Add multiplication support to calc.js and cover it with a unit test"]);
      assert.deepEqual(task.plan?.stages, ["coding"]);
      assert.deepEqual((task.agents ?? []).map((agent) => agent.role), ["planner", "coder", "code-reviewer"]);
      assert.equal(task.result?.approved, true);
      assert.equal(todos.get(todo.id).status, "sent");
      assert.equal(todos.reopen(todo.id).status, "open", "once the task finished, the to-do can be reopened");
    } finally {
      h.cleanup();
    }
  });

  test("HTTP: list, add, edit, send, reopen and delete to-dos", async () => {
    const h = createHarness({}, { ready: false });
    const { call, close } = await serveApi(h);
    try {
      assert.deepEqual(await call("GET", "/api/todos"), { status: 200, json: [] });
      const invalid = await call("POST", "/api/todos", { title: "No description" });
      assert.deepEqual([invalid.status, invalid.json.error], [400, "Describe the work: the description is what the manager agent gets"]);

      const created = await call("POST", "/api/todos", { description: "Add retry support" });
      assert.equal(created.status, 200);
      assert.deepEqual([created.json.id, created.json.status, created.json.repoId], ["TD-001", "open", undefined]);
      const unready = await call("POST", "/api/todos/TD-001/send");
      assert.deepEqual([unready.status, unready.json.error], [400, "Choose the repository TD-001 is for before sending it to the manager"]);

      const edited = await call("PATCH", "/api/todos/TD-001", { title: "Retry uploads", repoId: "sample", baseRef: "main" });
      assert.equal(edited.status, 200);
      assert.deepEqual([edited.json.title, edited.json.repoId, edited.json.baseRef], ["Retry uploads", "sample", "main"]);

      const sent = await call("POST", "/api/todos/TD-001/send");
      assert.equal(sent.status, 200);
      assert.deepEqual([sent.json.todo.status, sent.json.todo.taskId], ["sent", sent.json.task.id]);
      assert.deepEqual([sent.json.task.kind, sent.json.task.status, sent.json.task.todoId, sent.json.task.title], ["auto", "queued", "TD-001", "Retry uploads"]);
      assert.equal(sent.json.task.description, undefined, "the task comes back as a summary, like the live stream sends it");
      assert.equal((await call("POST", "/api/todos/TD-001/reopen")).status, 409);
      assert.equal((await call("PATCH", "/api/todos/TD-001", { title: "x" })).status, 409);
      assert.equal((await call("POST", "/api/todos/TD-001/send")).status, 409);

      h.runner.cancel(sent.json.task.id);
      const reopened = await call("POST", "/api/todos/TD-001/reopen");
      assert.deepEqual([reopened.status, reopened.json.status], [200, "open"]);
      assert.deepEqual((await call("DELETE", "/api/todos/TD-404")).status, 404);
      assert.deepEqual(await call("DELETE", "/api/todos/TD-001"), { status: 200, json: { ok: true } });
      assert.deepEqual(await call("GET", "/api/todos"), { status: 200, json: [] });
      assert.ok(h.store.getTask(sent.json.task.id), "the task stays");
    } finally {
      close();
      h.cleanup();
    }
  });

  test("task and to-do descriptions have no length limit", async () => {
    const h = createHarness({}, { ready: false });
    const api = await serveApi(h);
    try {
      // Megabytes of text: far past the former 50,000-character limit and the 1 MiB cap on other requests.
      const log = "2026-11-09T08:00:00Z [INFO] uploader: retrying chunk 17 of 40 after a timeout\n".repeat(40_000);
      const description = `Fix the flaky upload test; the full log follows.\n\n${log}`.trim();
      assert.ok(description.length > 3_000_000);

      const created = await api.call("POST", "/api/tasks", { kind: "coding", repoId: "sample", description });
      assert.equal(created.status, 200, created.json.error);
      assert.equal(created.json.title, "Fix the flaky upload test; the full log follows.");
      assert.equal(h.store.getTask(created.json.id)?.description, description);

      const todo = await api.call("POST", "/api/todos", { description, repoId: "sample" });
      assert.equal(todo.status, 200, todo.json.error);
      const longer = `${description}\n\nAlso check the retry limit.`;
      const edited = await api.call("PATCH", `/api/todos/${todo.json.id}`, { description: longer });
      assert.equal(edited.status, 200, edited.json.error);
      const sent = await api.call("POST", `/api/todos/${todo.json.id}/send`);
      assert.equal(sent.status, 200, sent.json.error);
      assert.equal(h.store.getTask(sent.json.task.id)?.description, longer, "the manager gets the whole description");

      // Only the requests that carry a description accept large bodies; the others keep the 1 MiB guard.
      const bodyLimit = (method: string, url: string) => {
        const match = api.router.match(method, url);
        assert.ok(match && match !== "method-not-allowed", `${method} ${url}`);
        return match.route.maxBodyBytes;
      };
      assert.deepEqual(
        [bodyLimit("POST", "/api/tasks"), bodyLimit("POST", "/api/todos"), bodyLimit("PATCH", "/api/todos/TD-001")],
        [DESCRIPTION_BODY_BYTES, DESCRIPTION_BODY_BYTES, DESCRIPTION_BODY_BYTES],
      );
      assert.deepEqual([bodyLimit("PUT", "/api/settings"), bodyLimit("POST", "/api/tasks/T-001/change-request")], [1024 * 1024, 1024 * 1024]);
    } finally {
      api.close();
      h.cleanup();
    }
  });
});
