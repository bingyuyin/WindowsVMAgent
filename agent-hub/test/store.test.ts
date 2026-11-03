import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_SETTINGS, Store } from "../src/store.ts";
import type { Task } from "../src/types.ts";

function tempDataDir(): { dir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-store-"));
  return { dir: path.join(root, "data"), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function sampleTask(id: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id, title: `Task ${id}`, description: "Do it", kind: "coding", repoId: "r1", repoName: "repo", baseRef: "main",
    authorModel: "a", reviewerModel: "r", maxRounds: 3, status: "completed", phase: "done", currentRound: 1, stages: [],
    sessions: [], usage: { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 }, attempt: 1,
    createdAt: now, updatedAt: now, lastSeq: 0, ...overrides,
  };
}

const repo = { id: "r1", name: "repo", path: "C:/repo", defaultBranch: "main", remoteUrl: null, addedAt: "2025-01-01T00:00:00.000Z" };

describe("store", () => {
  test("migrates the legacy state.json into per-entity files and keeps a backup", () => {
    const { dir, cleanup } = tempDataDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const legacy = {
        version: 1,
        settings: { authorModel: "m1", maxRounds: 5 },
        repos: [repo],
        tasks: [sampleTask("T-001"), sampleTask("T-002", { status: "failed" })],
        nextTaskNumber: 7,
      };
      fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(legacy));

      const store = new Store(dir);
      store.load();
      assert.equal(store.settings.authorModel, "m1");
      assert.equal(store.settings.maxRounds, 5);
      assert.equal(store.settings.docFormat, DEFAULT_SETTINGS.docFormat);
      assert.deepEqual(store.repos, [repo]);
      assert.deepEqual(store.tasks.map((task) => task.id), ["T-001", "T-002"]);
      assert.equal(store.getTask("T-002")?.status, "failed");
      assert.equal(store.allocateTaskId(), "T-007");
      for (const file of ["hub.json", "settings.json", "repos.json", "tasks/T-001/task.json", "tasks/T-002/task.json", "state.v1.backup.json"]) {
        assert.ok(fs.existsSync(path.join(dir, file)), `${file} exists`);
      }
      assert.equal(fs.existsSync(path.join(dir, "state.json")), false);

      const reloaded = new Store(dir);
      reloaded.load();
      assert.equal(reloaded.allocateTaskId(), "T-008", "the task counter survives restarts");
    } finally {
      cleanup();
    }
  });

  test("saves each task's last state to its own file and restores it, with the manager log", () => {
    const { dir, cleanup } = tempDataDir();
    try {
      const store = new Store(dir);
      store.load();
      store.addRepo(repo);
      store.updateSettings({ maxConcurrency: 4 });
      const task = sampleTask(store.allocateTaskId(), { status: "running" });
      store.addTask(task);
      store.appendEvent(task, { type: "status", text: "Started" });
      task.phase = "reviewing";
      task.currentRound = 2;
      store.saveTask(task);
      store.appendComm({ taskId: task.id, taskTitle: task.title, from: "manager", to: "coder", kind: "assign", text: "Implement" });
      store.appendComm({ taskId: task.id, taskTitle: task.title, from: "coder", to: "manager", kind: "submit", text: "Done" });
      store.flushAllSync();

      const saved = JSON.parse(fs.readFileSync(path.join(dir, "tasks", task.id, "task.json"), "utf8")) as Task;
      assert.equal(saved.phase, "reviewing");
      assert.equal(saved.lastSeq, 1);

      const reloaded = new Store(dir);
      reloaded.load();
      assert.equal(reloaded.settings.maxConcurrency, 4);
      assert.deepEqual(reloaded.repos.map((entry) => entry.id), ["r1"]);
      const restored = reloaded.getTask(task.id)!;
      assert.equal(restored.status, "running");
      assert.equal(restored.currentRound, 2);
      assert.deepEqual(reloaded.recentComm().map((entry) => entry.kind), ["assign", "submit"]);
      const next = reloaded.appendComm({ taskId: task.id, taskTitle: task.title, from: "manager", to: "user", kind: "lifecycle", text: "x" });
      assert.equal(next.seq, 3, "log sequence numbers continue after a restart");

      reloaded.removeTask(task.id);
      assert.deepEqual(reloaded.recentComm(), []);
      assert.equal(reloaded.storageInfo().tasks, 0);
    } finally {
      cleanup();
    }
  });

  test("sets a corrupt settings file aside and falls back to defaults", () => {
    const { dir, cleanup } = tempDataDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "settings.json"), "{ not json");
      fs.writeFileSync(path.join(dir, "hub.json"), JSON.stringify({ version: 2, nextTaskNumber: 1 }));
      const original = console.error;
      console.error = () => {};
      try {
        const store = new Store(dir);
        store.load();
        assert.equal(store.settings.maxRounds, DEFAULT_SETTINGS.maxRounds);
      } finally {
        console.error = original;
      }
      assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("settings.json.corrupt-")));
    } finally {
      cleanup();
    }
  });
});
