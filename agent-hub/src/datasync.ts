import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BuildInfo } from "./build.ts";
import type { Bus } from "./bus.ts";
import { git, gitBuffer, identityArgs, type GitResult } from "./git.ts";
import { branchWebUrl, parseRemote, primaryRemote, remoteLocation, sanitizeRemoteUrl, type RemoteDetails } from "./remote.ts";
import { isArtifactName, type Store } from "./store.ts";
import type { TodoService } from "./todos.ts";
import { ACTIVE_STATUSES, TASK_KINDS, type CommEntry, type Repo, type Task, type TaskStatus, type Todo } from "./types.ts";
import { HttpError, nowIso, randomId, slugify } from "./util.ts";
import type { TaskRunner } from "./workflow/runner.ts";
import { summarizeTask } from "./workflow/summary.ts";

/**
 * Data sync: pushes the hub's tasks (task.json, timeline, document snapshots), to-dos and manager log to a branch
 * `task_data/<name>` on a repository's remote, and loads such a branch back - merged into the data here, or
 * replacing it. Moves work between machines and keeps backups; settings, repositories, sign-in data and worktrees stay
 * on each machine.
 *
 * Data branches have their own history (no common commit with the code), are written with git plumbing (the
 * repository's checkout, index and branches are never touched) and are only pushed fast-forward.
 */

export const DATA_BRANCH_PREFIX = "task_data/";
/** Layout version of the data on a branch. */
export const DATA_FORMAT = 1;
const MANIFEST_FILE = "agent-hub-data.json";
const ROOT_FILES = new Set([MANIFEST_FILE, "repos.json", "todos.json", "manager-log.jsonl"]);
const MAX_DATA_BYTES = 1024 * 1024 * 1024;
/** Loaded tasks and to-dos keep their number only up to this (the hub counts from 1). */
const MAX_ID_NUMBER = 999_999;
const FILE_NAME = /^[\w.-]+$/;
const NAME_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "needs-input", "completed", "failed", "cancelled", "interrupted"];
/** Fields of a task record that git gets as commits or refs (diffs, retries, review anchors, pushes). */
const SHA_FIELDS = new Set(["sha", "commit", "prevCommit", "reviewedSha", "headSha", "baseSha", "baseTipSha"]);
const REF_FIELDS = new Set(["branch", "headRef", "baseRef", "baseBranch", "headBranch", "defaultBranch"]);
const SHA_VALUE = /^[0-9a-f]{7,64}$/i;
/** A ref git cannot mistake for an option or a pattern (and that check-ref-format accepts). */
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+$/;
const TASK_BRANCH = /^agent-hub\/[\w.-]+$/;

/** What a data branch holds, from its agent-hub-data.json. */
export interface DataManifest {
  format: number;
  /** The machine the data was pushed from. */
  host: string;
  hub: { version: string; commit: string | null };
  counts: { tasks: number; todos: number; managerMessages: number };
  nextTaskNumber: number;
  nextTodoNumber: number;
}

/** A repository as a data branch records it: enough to find the same repository on another machine. */
export interface DataRepo {
  id: string;
  name: string;
  defaultBranch?: string;
  remoteUrl: string | null;
}

export interface Snapshot {
  manifest: DataManifest;
  repos: DataRepo[];
  todos: Todo[];
  /** Each task with the other files of its folder (timeline, document snapshots). */
  tasks: Array<{ task: Task; files: Map<string, Buffer> }>;
  comm: CommEntry[];
  /** Records that were not valid and were left out. */
  skipped: number;
}

export interface DataBranch {
  /** Name without the prefix. */
  name: string;
  branch: string;
  sha: string;
  webUrl?: string;
}

/** What loading does with the tasks (or to-dos) of a branch. */
export interface RecordCounts {
  /** New here; `renumbered` of them got another id because theirs is taken here. */
  added: number;
  renumbered: number;
  /** The branch's copy is newer and replaced the copy here. */
  updated: number;
  /** Both sides have the same version. */
  unchanged: number;
  /** The copy here is newer and was kept. */
  keptNewer: number;
  /** In progress here (queued, running, being sent...) and kept. */
  keptBusy: number;
}

/** A repository the branch's tasks and to-dos refer to, and the repository registered here they now refer to. */
export interface RepoMapping {
  id: string;
  name: string;
  /** The repository here; null when it is not registered here. */
  localId: string | null;
  tasks: number;
  todos: number;
}

export interface PushResult {
  branch: string;
  remote: string;
  sha: string;
  /** The branch did not exist yet. */
  created: boolean;
  /** The branch already held exactly this data, so nothing was pushed. */
  unchanged: boolean;
  counts: DataManifest["counts"];
  webUrl?: string;
  summary: string;
}

export interface LoadPreview {
  branch: string;
  remote: string;
  sha: string;
  pushedAt: string | null;
  manifest: DataManifest;
  merge: { tasks: RecordCounts; todos: RecordCounts; managerMessages: number };
  replace: {
    tasks: number;
    todos: number;
    managerMessages: number;
    removes: { tasks: number; todos: number };
    /** Tasks here that must finish or be cancelled before the data can be replaced. */
    blockedBy: string[];
  };
  repositories: RepoMapping[];
  skipped: number;
}

export type LoadMode = "merge" | "replace";

export interface LoadResult {
  mode: LoadMode;
  branch: string;
  sha: string;
  tasks: RecordCounts;
  todos: RecordCounts;
  managerMessages: number;
  /** Replace: what was removed, and where it was backed up first. */
  removed?: { tasks: number; todos: number };
  backup?: string;
  repositories: RepoMapping[];
  summary: string;
}

/** The data here that a load is planned against. */
export interface LocalState {
  tasks: readonly Task[];
  todos: readonly Todo[];
  repos: readonly Repo[];
  counters: { nextTaskNumber: number; nextTodoNumber: number };
  busyTask(id: string): boolean;
  busyTodo(id: string): boolean;
  /** The manager log here, so messages it already has are not added twice. */
  comm: readonly CommEntry[];
}

export interface LoadPlan {
  /** Tasks to write, under their id here. */
  tasks: Array<{ task: Task; files: Map<string, Buffer>; sourceId: string; renumbered: boolean; replaces: boolean }>;
  /** The whole to-do list after loading. */
  todos: Todo[];
  /** Manager messages to add (oldest first). */
  comm: Array<Omit<CommEntry, "seq">>;
  taskCounts: RecordCounts;
  todoCounts: RecordCounts;
  nextTaskNumber: number;
  nextTodoNumber: number;
  repositories: RepoMapping[];
}

export interface DataSyncDeps {
  store: Store;
  bus: Bus;
  runner: Pick<TaskRunner, "isBusy" | "remove" | "forgetResume">;
  todos: Pick<TodoService, "isSending">;
  build: Pick<BuildInfo, "version" | "commit">;
  /** This machine's name, recorded with the data it pushes (default: the host name). */
  host?: string;
}

/** `task_data/<name>` for the name the user typed (with or without the prefix). */
export function dataBranchName(input: unknown): string {
  let name = typeof input === "string" ? input.trim().replace(/^refs\/heads\//, "") : "";
  if (name.startsWith(DATA_BRANCH_PREFIX)) name = name.slice(DATA_BRANCH_PREFIX.length);
  if (!name) throw new HttpError(400, "Enter a name for the data branch, for example this machine's name");
  const valid =
    name.length <= 100 &&
    name.split("/").every((segment) => NAME_SEGMENT.test(segment) && !segment.endsWith(".") && !segment.endsWith(".lock") && !segment.includes(".."));
  if (!valid) throw new HttpError(400, `'${name}' cannot be a branch name: use letters, digits, '.', '_', '-' and '/'`);
  return `${DATA_BRANCH_PREFIX}${name}`;
}

/** A task's or to-do's identity across hubs: the id and creation time it got on the hub that created it. */
export const identityOf = (record: { id: string; createdAt: string; syncId?: string }): string => record.syncId ?? `${record.id}@${record.createdAt}`;

export class DataSync {
  private readonly deps: DataSyncDeps;
  private readonly host: string;
  /** The push or load in progress (one at a time). */
  private operation: string | null = null;

  constructor(deps: DataSyncDeps) {
    this.deps = deps;
    this.host = deps.host ?? os.hostname();
  }

  info(): { prefix: string; host: string; suggestedName: string } {
    return { prefix: DATA_BRANCH_PREFIX, host: this.host, suggestedName: slugify(this.host, 40) };
  }

  /** The data branches on the repository's remote. */
  async branches(repoId: unknown): Promise<{ remote: { name: string; url: string }; branches: DataBranch[] }> {
    const { repo, remote } = await this.target(repoId);
    return { remote: { name: remote.name, url: remote.url }, branches: await listDataBranches(repo.path, remote) };
  }

  /** Pushes the data here to `task_data/<name>`: a new commit on top of the branch when it exists. */
  async push(input: { repoId?: unknown; name?: unknown }): Promise<PushResult> {
    const branch = dataBranchName(input.name);
    return this.exclusive(`pushing to ${branch}`, async () => {
      const { repo, remote } = await this.target(input.repoId);
      const existing = (await listDataBranches(repo.path, remote)).find((candidate) => candidate.branch === branch);
      const fetched = existing ? await fetchDataBranch(repo.path, remote, branch) : null;
      try {
        const data = await this.collect();
        const tree = await writeTree(repo.path, data.entries);
        const webUrl = branchWebUrl(remote, branch) ?? undefined;
        const where = `${branch} on ${remote.name}`;
        if (fetched && (await git(repo.path, ["rev-parse", `${fetched.sha}^{tree}`])).stdout.trim() === tree) {
          return { branch, remote: remote.name, sha: fetched.sha, created: false, unchanged: true, counts: data.counts, webUrl, summary: `${where} already has this data` };
        }
        const message = [
          `Agent Hub data from ${this.host}: ${plural(data.counts.tasks, "task")}, ${plural(data.counts.todos, "to-do")}`,
          "",
          `Pushed by Copilot Agent Hub v${this.deps.build.version}${this.deps.build.commit ? ` (${this.deps.build.commit})` : ""}. Load it in Agent Hub: Settings > Data sync. This branch is not source code: never merge it into another branch.`,
        ].join("\n");
        const commit = (await git(repo.path, [...(await identityArgs(repo.path)), "commit-tree", tree, ...(fetched ? ["-p", fetched.sha] : []), "-m", message])).stdout.trim();
        const pushed = await git(repo.path, ["push", "--porcelain", remote.name, `${commit}:refs/heads/${branch}`], { allowFailure: true, timeoutMs: 10 * 60_000 });
        if (pushed.code !== 0) {
          if (/\[rejected\]|non-fast-forward|fetch first/i.test(`${pushed.stdout}\n${pushed.stderr}`)) {
            throw new HttpError(409, `${branch} changed on ${remote.name} while the data was being pushed; push again`);
          }
          throw remoteError(`push ${branch} to ${remote.name}`, pushed);
        }
        const what = `${plural(data.counts.tasks, "task")}, ${plural(data.counts.todos, "to-do")} and ${plural(data.counts.managerMessages, "manager message")}`;
        return {
          branch,
          remote: remote.name,
          sha: commit,
          created: !fetched,
          unchanged: false,
          counts: data.counts,
          webUrl,
          summary: `Pushed ${what} to ${where} (${commit.slice(0, 10)})`,
        };
      } finally {
        await fetched?.release();
      }
    });
  }

  /** What merging or replacing with the branch would do (nothing is changed). */
  async preview(input: { repoId?: unknown; name?: unknown }): Promise<LoadPreview> {
    const branch = dataBranchName(input.name);
    return this.exclusive(`reading ${branch}`, async () => {
      const { repo, remote } = await this.target(input.repoId);
      const fetched = await fetchDataBranch(repo.path, remote, branch);
      try {
        const { snapshot, pushedAt } = await readDataBranch(repo.path, fetched.sha);
        const { store, runner } = this.deps;
        const comm = await store.exclusive(() => store.readCommLogSync());
        const plan = planLoad(snapshot, this.localState(comm), { keepLowIds: false });
        return {
          branch,
          remote: remote.name,
          sha: fetched.sha,
          pushedAt,
          manifest: snapshot.manifest,
          merge: { tasks: plan.taskCounts, todos: plan.todoCounts, managerMessages: plan.comm.length },
          replace: {
            tasks: snapshot.tasks.length,
            todos: snapshot.todos.length,
            managerMessages: snapshot.comm.length,
            removes: { tasks: store.tasks.length, todos: store.todos.length },
            blockedBy: store.tasks.filter((task) => runner.isBusy(task.id)).map((task) => task.id),
          },
          repositories: plan.repositories,
          skipped: snapshot.skipped,
        };
      } finally {
        await fetched.release();
      }
    });
  }

  /**
   * Loads the branch. Merge adds what is new and updates what is newer on the branch; replace backs the data here up,
   * deletes the tasks here (like Delete: worktrees and agent branches go, task branches stay) and loads the branch.
   * With `sha` (from the preview), refuses a branch that changed since.
   */
  async load(input: { repoId?: unknown; name?: unknown; mode?: unknown; sha?: unknown }): Promise<LoadResult> {
    const branch = dataBranchName(input.name);
    if (input.mode !== undefined && input.mode !== "merge" && input.mode !== "replace") throw new HttpError(400, "'mode' must be merge or replace");
    const mode: LoadMode = input.mode === "replace" ? "replace" : "merge";
    const expected = typeof input.sha === "string" && input.sha ? input.sha : null;
    return this.exclusive(`loading ${branch}`, async () => {
      const { store, runner, todos, bus } = this.deps;
      const { repo, remote } = await this.target(input.repoId);
      const fetched = await fetchDataBranch(repo.path, remote, branch);
      try {
        if (expected && fetched.sha !== expected) throw new HttpError(409, `${branch} changed on ${remote.name} since it was previewed; preview it again`);
        const { snapshot, pushedAt } = await readDataBranch(repo.path, fetched.sha);
        if (todos.isSending()) throw new HttpError(409, "A to-do is being sent to the manager right now; load the data once it has been sent");
        let removed: LoadResult["removed"];
        let backup: string | undefined;
        if (mode === "replace") {
          const busy = store.tasks.filter((task) => runner.isBusy(task.id)).map((task) => task.id);
          if (busy.length) {
            throw new HttpError(409, `Replacing the data deletes every task here, and ${listIds(busy)} ${busy.length === 1 ? "is" : "are"} in progress: cancel ${busy.length === 1 ? "it" : "them"} or let ${busy.length === 1 ? "it" : "them"} finish first`);
          }
          backup = path.join(store.paths.backups, `${nowIso().replace(/[:.]/g, "-")}-before-${slugify(branch.slice(DATA_BRANCH_PREFIX.length), 40)}`);
          await store.exclusive(() => store.copyDataSync(backup!));
          removed = { tasks: store.tasks.length, todos: store.todos.length };
          for (const task of [...store.tasks]) await runner.remove(task.id);
          await store.exclusive(() => {
            store.clearCommLogSync();
            store.setTodos([]);
          });
        }
        const when = pushedAt ? ` on ${pushedAt.slice(0, 16).replace("T", " ")} UTC` : "";
        const plan = await store.exclusive(() => {
          const plan = planLoad(snapshot, this.localState(store.readCommLogSync()), { keepLowIds: mode === "replace" });
          // Numbers first: whatever fails below, ids already given to loaded tasks are never handed out again.
          store.reserveNumbers({ nextTaskNumber: plan.nextTaskNumber, nextTodoNumber: plan.nextTodoNumber });
          store.putLoadedTasks(plan.tasks);
          for (const item of plan.tasks) {
            runner.forgetResume(item.task.id);
            const was = item.renumbered ? `; it is ${item.sourceId} there` : "";
            store.appendEvent(item.task, {
              type: "info",
              text: `${item.replaces ? "Updated with the newer copy" : "Loaded"} from ${branch} on ${remote.name} (pushed from ${snapshot.manifest.host}${when})${was}`,
            });
          }
          store.setTodos(plan.todos);
          for (const entry of plan.comm) store.appendLoadedComm(entry);
          return plan;
        });
        const summary =
          mode === "replace"
            ? `Replaced this hub's data (${plural(removed!.tasks, "task")}, ${plural(removed!.todos, "to-do")}) with ${branch}: ${plural(plan.taskCounts.added, "task")}, ${plural(plan.todoCounts.added, "to-do")} and ${plural(plan.comm.length, "manager message")}`
            : `Merged ${branch}: ${describeCounts(plan.taskCounts, "task")}; ${describeCounts(plan.todoCounts, "to-do")}; ${plural(plan.comm.length, "manager message")} added`;
        bus.publishGlobal({ type: "data-loaded", text: summary });
        return {
          mode,
          branch,
          sha: fetched.sha,
          tasks: plan.taskCounts,
          todos: plan.todoCounts,
          managerMessages: plan.comm.length,
          ...(removed ? { removed, backup } : {}),
          repositories: plan.repositories,
          summary,
        };
      } finally {
        await fetched.release();
      }
    });
  }

  private localState(comm: readonly CommEntry[]): LocalState {
    const { store, runner, todos } = this.deps;
    return {
      tasks: store.tasks,
      todos: store.todos,
      repos: store.repos,
      counters: store.counters,
      busyTask: (id) => runner.isBusy(id),
      busyTodo: (id) => todos.isSending(id),
      comm,
    };
  }

  private async exclusive<T>(label: string, work: () => Promise<T>): Promise<T> {
    if (this.operation) throw new HttpError(409, `Data sync is busy ${this.operation}; try again once it has finished`);
    this.operation = label;
    try {
      return await work();
    } finally {
      this.operation = null;
    }
  }

  private async target(repoId: unknown): Promise<{ repo: Repo; remote: RemoteDetails }> {
    if (typeof repoId !== "string" || !repoId) throw new HttpError(400, "Choose the repository whose remote holds the data branches");
    const repo = this.deps.store.getRepo(repoId);
    if (!repo) throw new HttpError(404, `Repository ${repoId} not found`);
    if (!fs.existsSync(repo.path)) throw new HttpError(400, `${repo.name} is not at ${repo.path} anymore`);
    const remote = await primaryRemote(repo.path);
    if (!remote) throw new HttpError(400, `${repo.name} has no git remote for data branches; add one (git remote add origin <url>)`);
    return { repo, remote };
  }

  /**
   * The files of the data here, read consistently: while they are read, no timeline, manager log or document snapshot
   * write runs (the task records are taken from memory first, so their event counters cover the timelines read).
   */
  private collect(): Promise<{ entries: TreeEntry[]; counts: DataManifest["counts"] }> {
    const { store, build } = this.deps;
    return store.exclusive(async () => {
      const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      const tasks = [...store.tasks];
      const known = new Set(tasks.map((task) => task.id));
      const comm = store.readCommLogSync().filter((entry) => known.has(entry.taskId));
      const entries: TreeEntry[] = tasks.map((task) => ({ path: `tasks/${task.id}/task.json`, content: json(task) }));
      for (const task of tasks) {
        for (const name of store.taskFiles(task.id)) {
          try {
            entries.push({ path: `tasks/${task.id}/${name}`, content: await fsp.readFile(path.join(store.taskDir(task.id), name)) });
          } catch (error) {
            // The task was deleted meanwhile.
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      const repos: DataRepo[] = store.repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        defaultBranch: repo.defaultBranch,
        remoteUrl: repo.remoteUrl ? sanitizeRemoteUrl(repo.remoteUrl) : null,
      }));
      const counts = { tasks: tasks.length, todos: store.todos.length, managerMessages: comm.length };
      const manifest: DataManifest = { format: DATA_FORMAT, host: this.host, hub: { version: build.version, commit: build.commit }, counts, ...store.counters };
      entries.push(
        { path: MANIFEST_FILE, content: json(manifest) },
        { path: "repos.json", content: json(repos) },
        { path: "todos.json", content: json(store.todos) },
        { path: "manager-log.jsonl", content: Buffer.from(comm.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8") },
        { path: "README.md", content: Buffer.from(readme(this.host), "utf8") },
      );
      return { entries, counts };
    });
  }
}

// ---- Planning a load ------------------------------------------------------------------------------

/**
 * How the branch's records fit into the data here. Records are matched by identity; the newer copy wins, unless the
 * record is in progress here. New records keep their id when it was never used here (any free id with `keepLowIds`,
 * i.e. after the data here was removed) and get the next free id otherwise. References between tasks, to-dos and
 * repositories follow the new ids.
 */
export function planLoad(snapshot: Snapshot, local: LocalState, options: { keepLowIds: boolean }): LoadPlan {
  const repoIds = mapRepositories(snapshot.repos, local.repos);
  const repoOf = (id: string) => repoIds.get(id) ?? id;
  const tasks = place(
    snapshot.tasks.map((item) => item.task),
    local.tasks,
    { prefix: "T-", counter: local.counters.nextTaskNumber, busy: local.busyTask, keepLowIds: options.keepLowIds },
  );
  const todos = place(snapshot.todos, local.todos, { prefix: "TD-", counter: local.counters.nextTodoNumber, busy: local.busyTodo, keepLowIds: options.keepLowIds });
  const filesOf = new Map(snapshot.tasks.map((item) => [item.task.id, item.files]));

  const loadedTasks = tasks.placements.map(({ record, localId, renumbered, replaces }) => {
    const task = structuredClone(record);
    task.id = localId;
    setSyncId(task, identityOf(record));
    task.repoId = repoOf(task.repoId);
    task.repoName = local.repos.find((repo) => repo.id === task.repoId)?.name ?? task.repoName;
    const todoId = task.todoId ? todos.ids.get(task.todoId) : undefined;
    if (todoId) task.todoId = todoId;
    else delete task.todoId;
    // Folders and agent sessions of the machine the data comes from mean nothing here.
    delete task.workspaceRoot;
    delete task.worktreePath;
    task.sessions = [];
    for (const agent of task.agents ?? []) {
      delete agent.workspace;
      delete agent.sessionId;
    }
    // A task runs on the hub that started it; here it can be retried.
    if (ACTIVE_STATUSES.includes(task.status)) {
      task.status = "interrupted";
      delete task.activity;
      delete task.pendingInput;
      for (const agent of task.agents ?? []) if (agent.status === "working" || agent.status === "idle") agent.status = "cancelled";
    }
    if (task.push?.status === "pushing") task.push = { ...task.push, status: "failed", reason: "The data was pushed while this branch was being pushed; push it again" };
    delete task.autoResumes;
    // New events continue after every event of the timeline (a torn last line, from a crash, is dropped).
    const files = new Map(filesOf.get(record.id) ?? []);
    const events = files.get("events.jsonl");
    if (events) {
      const complete = events.subarray(0, events.lastIndexOf(0x0a) + 1);
      files.set("events.jsonl", complete);
      task.lastSeq = Math.max(task.lastSeq, highestSeq(complete));
    }
    return { task, files, sourceId: record.id, renumbered, replaces };
  });

  const loadedTodos = new Map(
    todos.placements.map(({ record, localId }) => {
      const todo: Todo = { ...record, id: localId };
      setSyncId(todo, identityOf(record));
      if (todo.repoId) todo.repoId = repoOf(todo.repoId);
      const taskId = todo.taskId ? tasks.ids.get(todo.taskId) : undefined;
      if (taskId) todo.taskId = taskId;
      else delete todo.taskId;
      return [localId, todo] as const;
    }),
  );
  const todoList = [...local.todos.map((todo) => loadedTodos.get(todo.id) ?? todo), ...[...loadedTodos.values()].filter((todo) => !local.todos.some((existing) => existing.id === todo.id))];

  // Manager messages of the loaded tasks that the log here does not have yet.
  const localIdOf = new Map(loadedTasks.map((item) => [item.sourceId, item.task.id]));
  const loadedIds = new Set(localIdOf.values());
  const key = (entry: Pick<CommEntry, "ts" | "from" | "to" | "kind" | "text">, taskId: string) => [taskId, entry.ts, entry.from, entry.to, entry.kind, entry.text].join("\u0000");
  const known = new Set(local.comm.filter((entry) => loadedIds.has(entry.taskId)).map((entry) => key(entry, entry.taskId)));
  const comm: LoadPlan["comm"] = [];
  for (const entry of snapshot.comm) {
    const taskId = localIdOf.get(entry.taskId);
    if (!taskId || known.has(key(entry, taskId))) continue;
    known.add(key(entry, taskId));
    const { seq: _seq, ...rest } = entry;
    comm.push({ ...rest, taskId });
  }
  comm.sort((a, b) => a.ts.localeCompare(b.ts));

  const usage = new Map<string, { tasks: number; todos: number }>();
  const use = (id: string | undefined, kind: "tasks" | "todos") => {
    if (!id) return;
    const entry = usage.get(id) ?? { tasks: 0, todos: 0 };
    entry[kind]++;
    usage.set(id, entry);
  };
  for (const item of snapshot.tasks) use(item.task.repoId, "tasks");
  for (const todo of snapshot.todos) use(todo.repoId, "todos");
  const repositories = [...usage].map(([id, count]) => {
    const localId = repoOf(id);
    return {
      id,
      name: snapshot.repos.find((repo) => repo.id === id)?.name ?? id,
      localId: local.repos.some((repo) => repo.id === localId) ? localId : null,
      ...count,
    };
  });

  return {
    tasks: loadedTasks,
    todos: todoList,
    comm,
    taskCounts: tasks.counts,
    todoCounts: todos.counts,
    nextTaskNumber: tasks.next,
    nextTodoNumber: todos.next,
    repositories,
  };
}

interface Versioned {
  id: string;
  createdAt: string;
  updatedAt: string;
  syncId?: string;
}

function place<T extends Versioned>(
  incoming: readonly T[],
  local: readonly T[],
  options: { prefix: string; counter: number; busy: (id: string) => boolean; keepLowIds: boolean },
): { counts: RecordCounts; ids: Map<string, string>; placements: Array<{ record: T; localId: string; renumbered: boolean; replaces: boolean }>; next: number } {
  const counts: RecordCounts = { added: 0, renumbered: 0, updated: 0, unchanged: 0, keptNewer: 0, keptBusy: 0 };
  const ids = new Map<string, string>();
  const placements: Array<{ record: T; localId: string; renumbered: boolean; replaces: boolean }> = [];
  const byIdentity = new Map(local.map((record) => [identityOf(record), record] as const));
  const taken = new Set(local.map((record) => record.id));
  const pattern = new RegExp(`^${options.prefix}(\\d+)$`);
  const fresh: T[] = [];
  for (const record of incoming) {
    const match = byIdentity.get(identityOf(record));
    if (!match) {
      fresh.push(record);
      continue;
    }
    ids.set(record.id, match.id);
    if (options.busy(match.id)) counts.keptBusy++;
    else if (record.updatedAt > match.updatedAt) {
      counts.updated++;
      placements.push({ record, localId: match.id, renumbered: false, replaces: true });
    } else if (record.updatedAt === match.updatedAt) counts.unchanged++;
    else counts.keptNewer++;
  }
  // An id below the counter here may have belonged to a task deleted here (its messages are still in the log); an
  // id beyond any plausible count would break numbering here.
  let next = options.counter;
  const renumber: T[] = [];
  for (const record of fresh) {
    const n = Number(pattern.exec(record.id)?.[1] ?? 0);
    if (Number.isSafeInteger(n) && n > 0 && n <= MAX_ID_NUMBER && !taken.has(record.id) && (options.keepLowIds || n >= options.counter)) {
      taken.add(record.id);
      ids.set(record.id, record.id);
      next = Math.max(next, n + 1);
      placements.push({ record, localId: record.id, renumbered: false, replaces: false });
      counts.added++;
    } else {
      renumber.push(record);
    }
  }
  for (const record of renumber) {
    let localId: string;
    do localId = `${options.prefix}${String(next++).padStart(3, "0")}`;
    while (taken.has(localId));
    taken.add(localId);
    ids.set(record.id, localId);
    placements.push({ record, localId, renumbered: true, replaces: false });
    counts.added++;
    counts.renumbered++;
  }
  return { counts, ids, placements, next };
}

function setSyncId(record: { id: string; createdAt: string; syncId?: string }, identity: string): void {
  if (identity === `${record.id}@${record.createdAt}`) delete record.syncId;
  else record.syncId = identity;
}

/** The highest event number in a timeline (events.jsonl). */
function highestSeq(timeline: Buffer): number {
  let highest = 0;
  for (const line of timeline.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const seq = (JSON.parse(line) as { seq?: unknown }).seq;
      if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > highest) highest = seq;
    } catch {
      // Not an event.
    }
  }
  return highest;
}

/** The repository here for each repository of the branch: the same remote, else the same id, else the only one with its name. */
function mapRepositories(repos: readonly DataRepo[], local: readonly Repo[]): Map<string, string> {
  const locationOf = (url: string | null | undefined) => {
    const location = url ? remoteLocation(parseRemote("origin", url)) : null;
    return location ? `${location.host}/${location.path}` : null;
  };
  const map = new Map<string, string>();
  for (const repo of repos) {
    const location = locationOf(repo.remoteUrl);
    const named = local.filter((candidate) => candidate.name.toLowerCase() === repo.name.toLowerCase());
    const match =
      (location ? local.find((candidate) => locationOf(candidate.remoteUrl) === location) : undefined) ??
      local.find((candidate) => candidate.id === repo.id) ??
      (named.length === 1 ? named[0] : undefined);
    if (match) map.set(repo.id, match.id);
  }
  return map;
}

// ---- Reading a data branch -------------------------------------------------------------------------

/** Validates the files of a data branch; invalid records are left out (and counted), invalid data is refused. */
export function parseSnapshot(files: ReadonlyMap<string, Buffer>): Snapshot {
  const manifest = parseJson(files.get(MANIFEST_FILE));
  if (!isObject(manifest) || typeof manifest.format !== "number") throw new HttpError(400, `This branch holds no Agent Hub data (${MANIFEST_FILE} is missing)`);
  if (manifest.format > DATA_FORMAT) throw new HttpError(400, "This branch was pushed by a newer version of Agent Hub; update this hub to load it");
  let skipped = 0;

  const repos: DataRepo[] = asArray(parseJson(files.get("repos.json")))
    .filter((repo): repo is Record<string, unknown> => isObject(repo) && typeof repo.id === "string" && typeof repo.name === "string")
    .map((repo) => ({
      id: repo.id as string,
      name: repo.name as string,
      ...(typeof repo.defaultBranch === "string" ? { defaultBranch: repo.defaultBranch } : {}),
      remoteUrl: typeof repo.remoteUrl === "string" ? repo.remoteUrl : null,
    }));

  const todos: Todo[] = [];
  for (const raw of asArray(parseJson(files.get("todos.json")))) {
    if (validTodo(raw)) todos.push({ ...raw, title: typeof raw.title === "string" ? raw.title : "" } as Todo);
    else skipped++;
  }

  const folders = new Map<string, Map<string, Buffer>>();
  for (const [file, content] of files) {
    const match = /^tasks\/([^/]+)\/([^/]+)$/.exec(file);
    if (!match || !isFileName(match[1]!) || !isFileName(match[2]!)) continue;
    const folder = folders.get(match[1]!) ?? new Map<string, Buffer>();
    folder.set(match[2]!, content);
    folders.set(match[1]!, folder);
  }
  const tasks: Snapshot["tasks"] = [];
  for (const [id, folder] of folders) {
    const raw = parseJson(folder.get("task.json"));
    if (!validTask(raw) || raw.id !== id) {
      skipped++;
      continue;
    }
    folder.delete("task.json");
    const task = raw as unknown as Task;
    if (!isObject(task.usage)) task.usage = { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 };
    if (!Array.isArray(task.sessions)) task.sessions = [];
    if (typeof task.attempt !== "number") task.attempt = 1;
    // A record the task list cannot show would break every page that lists tasks.
    try {
      summarizeTask(task);
    } catch {
      skipped++;
      continue;
    }
    tasks.push({ task, files: folder });
  }

  const comm: CommEntry[] = [];
  for (const line of (files.get("manager-log.jsonl")?.toString("utf8") ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isObject(entry) && ["taskId", "ts", "from", "to", "kind", "text"].every((field) => typeof entry[field] === "string")) comm.push(entry as unknown as CommEntry);
    } catch {
      // A torn line.
    }
  }

  const counts = isObject(manifest.counts) ? manifest.counts : {};
  const hub = isObject(manifest.hub) ? manifest.hub : {};
  return {
    manifest: {
      format: manifest.format,
      host: typeof manifest.host === "string" ? manifest.host : "unknown",
      hub: { version: typeof hub.version === "string" ? hub.version : "unknown", commit: typeof hub.commit === "string" ? hub.commit : null },
      counts: {
        tasks: Number(counts.tasks) || tasks.length,
        todos: Number(counts.todos) || todos.length,
        managerMessages: Number(counts.managerMessages) || comm.length,
      },
      nextTaskNumber: Number(manifest.nextTaskNumber) || 1,
      nextTodoNumber: Number(manifest.nextTodoNumber) || 1,
    },
    repos,
    todos: newestCopies(todos),
    tasks: newestCopies(tasks.map((item) => ({ ...item, id: item.task.id, createdAt: item.task.createdAt, updatedAt: item.task.updatedAt, syncId: item.task.syncId }))).map(
      ({ task, files: taskFiles }) => ({ task, files: taskFiles }),
    ),
    comm,
    skipped,
  };
}

/** One record per identity (and per id): the most recently updated. */
function newestCopies<T extends Versioned>(records: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const record of records) {
    const current = best.get(identityOf(record));
    if (!current || record.updatedAt > current.updatedAt) best.set(identityOf(record), record);
  }
  const seen = new Set<string>();
  return [...best.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((record) => !seen.has(record.id) && Boolean(seen.add(record.id)));
}

function validTask(raw: unknown): raw is Record<string, unknown> {
  return (
    isObject(raw) &&
    typeof raw.id === "string" &&
    isFileName(raw.id) &&
    typeof raw.title === "string" &&
    typeof raw.description === "string" &&
    TASK_KINDS.includes(raw.kind as Task["kind"]) &&
    TASK_STATUSES.includes(raw.status as TaskStatus) &&
    typeof raw.repoId === "string" &&
    typeof raw.repoName === "string" &&
    typeof raw.baseRef === "string" &&
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string" &&
    Array.isArray(raw.stages) &&
    raw.stages.every((stage) => isObject(stage) && Array.isArray(stage.rounds) && stage.rounds.every(isObject)) &&
    (raw.agents === undefined || (Array.isArray(raw.agents) && raw.agents.every(isObject))) &&
    typeof raw.lastSeq === "number" &&
    (raw.syncId === undefined || typeof raw.syncId === "string") &&
    (raw.todoId === undefined || typeof raw.todoId === "string") &&
    (raw.branch === undefined || (typeof raw.branch === "string" && TASK_BRANCH.test(raw.branch) && !raw.branch.includes(".."))) &&
    gitSafe(raw, 0)
  );
}

/**
 * Commit ids and branch names reach git as arguments when a task is retried, diffed or deleted: a data branch anyone
 * with push access wrote must not smuggle in options (`--output=...`) or patterns (`*`).
 */
function gitSafe(value: unknown, depth: number): boolean {
  if (depth > 40) return false;
  if (Array.isArray(value)) return value.every((item) => gitSafe(item, depth + 1));
  if (!isObject(value)) return true;
  for (const [key, field] of Object.entries(value)) {
    if (field === null || field === undefined) continue;
    if (SHA_FIELDS.has(key) && !(typeof field === "string" && SHA_VALUE.test(field))) return false;
    if (REF_FIELDS.has(key) && !(typeof field === "string" && SAFE_REF.test(field))) return false;
    if (typeof field === "object" && !gitSafe(field, depth + 1)) return false;
  }
  return true;
}

function validTodo(raw: unknown): raw is Record<string, unknown> {
  const optional = (value: unknown) => value === undefined || typeof value === "string";
  return (
    isObject(raw) &&
    typeof raw.id === "string" &&
    /^TD-\d+$/.test(raw.id) &&
    typeof raw.description === "string" &&
    raw.description.trim() !== "" &&
    (raw.status === "open" || raw.status === "sent") &&
    typeof raw.createdAt === "string" &&
    typeof raw.updatedAt === "string" &&
    ["title", "repoId", "baseRef", "taskId", "sentAt", "syncId"].every((field) => optional(raw[field])) &&
    (raw.baseRef === undefined || SAFE_REF.test(raw.baseRef as string))
  );
}

const isFileName = (name: string) => FILE_NAME.test(name) && isArtifactName(name);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(content: Buffer | undefined): unknown {
  if (!content) return undefined;
  try {
    return JSON.parse(content.toString("utf8"));
  } catch {
    return undefined;
  }
}

// ---- Git plumbing ----------------------------------------------------------------------------------

/** A file of the data branch. */
interface TreeEntry {
  path: string;
  content: Buffer;
}

async function listDataBranches(cwd: string, remote: RemoteDetails): Promise<DataBranch[]> {
  const result = await git(cwd, ["ls-remote", "--heads", remote.name, `refs/heads/${DATA_BRANCH_PREFIX}*`], { allowFailure: true, timeoutMs: 2 * 60_000 });
  if (result.code !== 0) throw remoteError(`list the branches of ${remote.name}`, result);
  const branches: DataBranch[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref?.startsWith(`refs/heads/${DATA_BRANCH_PREFIX}`)) continue;
    const branch = ref.slice("refs/heads/".length);
    branches.push({ name: branch.slice(DATA_BRANCH_PREFIX.length), branch, sha, ...(branchWebUrl(remote, branch) ? { webUrl: branchWebUrl(remote, branch)! } : {}) });
  }
  return branches.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fetches the branch onto a private ref (never FETCH_HEAD, which tasks may be using); `release` removes the ref. */
async function fetchDataBranch(cwd: string, remote: RemoteDetails, branch: string): Promise<{ sha: string; release: () => Promise<void> }> {
  const ref = `refs/agent-hub/data-sync/${Date.now().toString(36)}-${randomId(6)}`;
  const release = async () => {
    await git(cwd, ["update-ref", "-d", ref], { allowFailure: true });
  };
  const result = await git(cwd, ["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", remote.name, `+refs/heads/${branch}:${ref}`], {
    allowFailure: true,
    timeoutMs: 10 * 60_000,
  });
  if (result.code !== 0) {
    await release();
    if (/couldn't find remote ref/i.test(result.stderr)) throw new HttpError(404, `${branch} does not exist on ${remote.name}`);
    throw remoteError(`fetch ${branch} from ${remote.name}`, result);
  }
  try {
    return { sha: (await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim(), release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function readDataBranch(cwd: string, sha: string): Promise<{ snapshot: Snapshot; pushedAt: string | null }> {
  const listing = await git(cwd, ["ls-tree", "-r", "-l", "-z", "--full-tree", sha], { maxBuffer: 256 * 1024 * 1024 });
  const wanted: Array<{ path: string; sha: string; size: number }> = [];
  for (const record of listing.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, objectSha, size] = record.slice(0, tab).trim().split(/\s+/);
    const file = record.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !objectSha || !isDataPath(file)) continue;
    wanted.push({ path: file, sha: objectSha, size: Number(size) || 0 });
  }
  const total = wanted.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_DATA_BYTES) throw new HttpError(413, `The data on this branch is too large to load (${Math.round(total / 1024 / 1024)} MB)`);
  const blobs = await readBlobs(cwd, [...new Set(wanted.map((entry) => entry.sha))], total);
  const snapshot = parseSnapshot(new Map(wanted.map((entry) => [entry.path, blobs.get(entry.sha) ?? Buffer.alloc(0)])));
  const date = await git(cwd, ["show", "-s", "--format=%cI", sha], { allowFailure: true });
  const pushedAt = date.code === 0 && date.stdout.trim() ? new Date(date.stdout.trim()).toISOString() : null;
  return { snapshot, pushedAt };
}

function isDataPath(file: string): boolean {
  if (ROOT_FILES.has(file)) return true;
  const match = /^tasks\/([^/]+)\/([^/]+)$/.exec(file);
  return Boolean(match && isFileName(match[1]!) && isFileName(match[2]!));
}

/** Contents of blobs, read in one `git cat-file --batch`. */
async function readBlobs(cwd: string, shas: string[], totalBytes: number): Promise<Map<string, Buffer>> {
  const blobs = new Map<string, Buffer>();
  if (!shas.length) return blobs;
  const output = await gitBuffer(cwd, ["cat-file", "--batch"], { input: `${shas.join("\n")}\n`, maxBytes: totalBytes + shas.length * 128 + 1024 });
  let offset = 0;
  for (let index = 0; index < shas.length; index++) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("git cat-file ended early while reading the data branch");
    const [sha, type, size] = output.toString("utf8", offset, newline).split(" ");
    if (!sha || type !== "blob") throw new Error(`Cannot read ${sha ?? "an object"} of the data branch`);
    const start = newline + 1;
    const end = start + Number(size);
    blobs.set(sha, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

/** Writes the files as git objects and returns their tree; a temporary index keeps the repository's own index untouched. */
async function writeTree(cwd: string, entries: readonly TreeEntry[]): Promise<string> {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-hub-data-"));
  try {
    const sources: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const file = path.join(temp, `${index}.blob`);
      await fsp.writeFile(file, entry.content);
      sources.push(file);
    }
    // --no-filters: the data is stored byte for byte, whatever core.autocrlf or .gitattributes say.
    const hashed = await git(cwd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: `${sources.join("\n")}\n`, timeoutMs: 10 * 60_000 });
    const shas = hashed.stdout.split(/\r?\n/).filter(Boolean);
    if (shas.length !== entries.length) throw new Error("git hash-object did not store every file");
    const env = { GIT_INDEX_FILE: path.join(temp, "index") };
    await git(cwd, ["update-index", "--add", "--index-info"], { input: entries.map((entry, index) => `100644 ${shas[index]}\t${entry.path}\n`).join(""), env });
    return (await git(cwd, ["write-tree"], { env })).stdout.trim();
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

function remoteError(action: string, result: GitResult): HttpError {
  const detail = sanitizeRemoteUrl((result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" "));
  return new HttpError(502, `Could not ${action}: ${detail || `git exited with code ${result.code}`}`);
}

// ---- Text -------------------------------------------------------------------------------------------

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function listIds(ids: string[]): string {
  return ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")} and ${ids.length - 5} more`;
}

function describeCounts(counts: RecordCounts, noun: string): string {
  const parts = [
    counts.added ? `${plural(counts.added, noun)} added${counts.renumbered ? ` (${counts.renumbered} under new ids)` : ""}` : null,
    counts.updated ? `${plural(counts.updated, noun)} updated` : null,
    counts.unchanged ? `${plural(counts.unchanged, noun)} already up to date` : null,
    counts.keptNewer ? `${plural(counts.keptNewer, noun)} newer here (kept)` : null,
    counts.keptBusy ? `${plural(counts.keptBusy, noun)} in progress here (kept)` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `no ${noun}s`;
}

function readme(host: string): string {
  return [
    "# Copilot Agent Hub data",
    "",
    `This branch holds the data of a Copilot Agent Hub, pushed from ${host}: its tasks (state, timeline and document snapshots), to-dos and the manager's log.`,
    "",
    "Load it into a hub in **Settings > Data sync > Load from a branch**: *Merge* adds what is new and updates what is newer on the branch; *Replace* swaps the hub's data for this.",
    "",
    "This branch is not source code: never merge it into another branch.",
    "",
  ].join("\n");
}
