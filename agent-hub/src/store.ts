import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_PARALLEL_TASKS, type CommEntry, type NewTaskEvent, type Repo, type Settings, type Task, type TaskEvent } from "./types.ts";
import { nowIso } from "./util.ts";

interface HubMeta {
  version: 2;
  nextTaskNumber: number;
  createdAt: string;
  migratedFrom?: string;
}

/** Single-file layout used before v2 (data/state.json). */
interface LegacyState {
  settings?: Partial<Settings>;
  repos?: Repo[];
  tasks?: Task[];
  nextTaskNumber?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  authorModel: null,
  reviewerModel: null,
  resolverModel: null,
  managerModel: null,
  maxRounds: 3,
  maxConcurrency: MAX_PARALLEL_TASKS,
  designDocDir: "docs/designs",
  documentDir: "docs",
  docFormat: "html",
  turnTimeoutMinutes: 90,
  inputTimeoutMinutes: 30,
  isolation: "branch",
  cleanupWorktrees: true,
  resumeInterruptedTasks: true,
};

export interface StorageInfo {
  dataDir: string;
  files: Array<{ label: string; path: string; description: string }>;
  repos: number;
  tasks: number;
  commEntries: number;
}

const RECENT_EVENT_LIMIT = 500;
const RECENT_COMM_LIMIT = 1000;
const COMM_TAIL_BYTES = 1024 * 1024;
const COMM_ROTATE_BYTES = 8 * 1024 * 1024;
const TASK_SAVE_DELAY_MS = 250;
const ARTIFACT_NAME = /^[\w.-]+$/;
const TASK_ID = /^[\w.-]+$/;

/**
 * Local-disk persistence in the data folder:
 * - `hub.json` (format version, task counter), `settings.json`, `repos.json`
 * - `tasks/<id>/task.json` (last known state of each task), `events.jsonl` (timeline) and artifacts
 *   (document snapshots per review round)
 * - `manager-log.jsonl` (manager <-> sub-agent communication)
 *
 * JSON files are replaced atomically (temp file + rename) so a crash never leaves a torn file.
 */
export class Store {
  readonly dataDir: string;
  private meta: HubMeta = { version: 2, nextTaskNumber: 1, createdAt: nowIso() };
  private settingsValue: Settings = { ...DEFAULT_SETTINGS };
  private repoList: Repo[] = [];
  private taskList: Task[] = [];
  private readonly dirtyTasks = new Set<string>();
  private taskTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly pendingLines = new Map<string, string[]>();
  private readonly recent = new Map<string, TaskEvent[]>();
  private comm: CommEntry[] = [];
  private commSeq = 0;
  private pendingComm: string[] = [];

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  get paths() {
    return {
      hub: path.join(this.dataDir, "hub.json"),
      settings: path.join(this.dataDir, "settings.json"),
      repos: path.join(this.dataDir, "repos.json"),
      tasks: path.join(this.dataDir, "tasks"),
      managerLog: path.join(this.dataDir, "manager-log.jsonl"),
      legacyState: path.join(this.dataDir, "state.json"),
    };
  }

  load(): void {
    fs.mkdirSync(this.paths.tasks, { recursive: true });
    this.migrateLegacyState();
    const settings = readJson<Partial<Settings>>(this.paths.settings);
    this.settingsValue = { ...DEFAULT_SETTINGS, ...(isObject(settings) ? settings : {}) };
    const repos = readJson<Repo[]>(this.paths.repos);
    this.repoList = Array.isArray(repos) ? repos : [];
    this.taskList = this.loadTasks();
    const meta = readJson<Partial<HubMeta>>(this.paths.hub);
    const highest = Math.max(0, ...this.taskList.map((task) => taskNumber(task.id)));
    this.meta = {
      ...(isObject(meta) ? meta : {}),
      version: 2,
      createdAt: meta?.createdAt ?? nowIso(),
      nextTaskNumber: Math.max(Number(meta?.nextTaskNumber) || 1, highest + 1),
    };
    this.writeMeta();
    this.loadCommTail();
  }

  // ---- Settings -------------------------------------------------------------------------

  get settings(): Settings {
    return this.settingsValue;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.settingsValue, patch);
    writeJsonAtomic(this.paths.settings, this.settingsValue);
    return this.settingsValue;
  }

  // ---- Repositories ---------------------------------------------------------------------

  get repos(): readonly Repo[] {
    return this.repoList;
  }

  getRepo(id: string): Repo | undefined {
    return this.repoList.find((repo) => repo.id === id);
  }

  addRepo(repo: Repo): void {
    this.repoList.push(repo);
    writeJsonAtomic(this.paths.repos, this.repoList);
  }

  removeRepo(id: string): void {
    this.repoList = this.repoList.filter((repo) => repo.id !== id);
    writeJsonAtomic(this.paths.repos, this.repoList);
  }

  // ---- Tasks ----------------------------------------------------------------------------

  get tasks(): readonly Task[] {
    return this.taskList;
  }

  getTask(id: string): Task | undefined {
    return this.taskList.find((task) => task.id === id);
  }

  addTask(task: Task): void {
    if (!TASK_ID.test(task.id)) throw new Error(`Invalid task id: ${task.id}`);
    this.taskList.push(task);
    this.writeTask(task);
  }

  /** Schedules a (debounced) write of the task's `task.json`. */
  saveTask(task: Task): void {
    if (!this.getTask(task.id)) return;
    this.dirtyTasks.add(task.id);
    this.taskTimer ??= setTimeout(() => this.flushTasks(), TASK_SAVE_DELAY_MS);
  }

  removeTask(id: string): void {
    this.taskList = this.taskList.filter((task) => task.id !== id);
    this.dirtyTasks.delete(id);
    this.recent.delete(id);
    this.pendingLines.delete(id);
    this.comm = this.comm.filter((entry) => entry.taskId !== id);
  }

  allocateTaskId(): string {
    const n = this.meta.nextTaskNumber++;
    this.writeMeta();
    return `T-${String(n).padStart(3, "0")}`;
  }

  taskDir(taskId: string): string {
    return path.join(this.paths.tasks, taskId);
  }

  taskFile(taskId: string): string {
    return path.join(this.taskDir(taskId), "task.json");
  }

  // ---- Task timeline --------------------------------------------------------------------

  appendEvent(task: Task, event: NewTaskEvent): TaskEvent {
    const full: TaskEvent = { seq: ++task.lastSeq, ts: nowIso(), ...event };
    const ring = this.recent.get(task.id) ?? [];
    ring.push(full);
    if (ring.length > RECENT_EVENT_LIMIT) ring.splice(0, ring.length - RECENT_EVENT_LIMIT);
    this.recent.set(task.id, ring);
    const lines = this.pendingLines.get(task.id) ?? [];
    lines.push(`${JSON.stringify(full)}\n`);
    this.pendingLines.set(task.id, lines);
    this.scheduleFlush();
    this.saveTask(task);
    return full;
  }

  async readEvents(taskId: string, options: { after?: number; limit?: number } = {}): Promise<TaskEvent[]> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 2000;
    const ring = this.recent.get(taskId);
    const firstInRing = ring?.[0];
    if (ring && firstInRing && firstInRing.seq <= after + 1) {
      return ring.filter((event) => event.seq > after).slice(-limit);
    }
    await this.flushEvents();
    let content: string;
    try {
      content = await fsp.readFile(path.join(this.taskDir(taskId), "events.jsonl"), "utf8");
    } catch {
      return [];
    }
    const events: TaskEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as TaskEvent;
        if (event.seq > after) events.push(event);
      } catch {
        // Ignore a torn final line from an unclean shutdown.
      }
    }
    return events.slice(-limit);
  }

  // ---- Manager communication log --------------------------------------------------------

  appendComm(entry: Omit<CommEntry, "seq" | "ts">): CommEntry {
    const full: CommEntry = { seq: ++this.commSeq, ts: nowIso(), ...entry };
    this.comm.push(full);
    if (this.comm.length > RECENT_COMM_LIMIT) this.comm.splice(0, this.comm.length - RECENT_COMM_LIMIT);
    this.pendingComm.push(`${JSON.stringify(full)}\n`);
    this.scheduleFlush();
    return full;
  }

  /** Most recent manager <-> agent messages, oldest first. */
  recentComm(options: { limit?: number; taskId?: string } = {}): CommEntry[] {
    const entries = options.taskId ? this.comm.filter((entry) => entry.taskId === options.taskId) : this.comm;
    return entries.slice(-(options.limit ?? 300));
  }

  // ---- Artifacts ------------------------------------------------------------------------

  async writeArtifact(taskId: string, name: string, content: string): Promise<void> {
    if (!ARTIFACT_NAME.test(name)) throw new Error(`Invalid artifact name: ${name}`);
    const dir = this.taskDir(taskId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name), content, "utf8");
  }

  async readArtifact(taskId: string, name: string): Promise<string | null> {
    if (!ARTIFACT_NAME.test(name)) return null;
    try {
      return await fsp.readFile(path.join(this.taskDir(taskId), name), "utf8");
    } catch {
      return null;
    }
  }

  async deleteTaskData(taskId: string): Promise<void> {
    await this.flushEvents();
    await fsp.rm(this.taskDir(taskId), { recursive: true, force: true });
  }

  storageInfo(): StorageInfo {
    const { paths } = this;
    return {
      dataDir: this.dataDir,
      files: [
        { label: "Settings", path: paths.settings, description: "Models, rounds, concurrency, isolation and document options" },
        { label: "Repositories", path: paths.repos, description: "Registered repositories" },
        { label: "Tasks", path: paths.tasks, description: "Per task: task.json (last state), events.jsonl (timeline), document snapshots" },
        { label: "Manager log", path: paths.managerLog, description: "Manager <-> sub-agent communication" },
        { label: "Hub", path: paths.hub, description: "Storage format version and task counter" },
      ],
      repos: this.repoList.length,
      tasks: this.taskList.length,
      commEntries: this.commSeq,
    };
  }

  // ---- Flushing -------------------------------------------------------------------------

  flushEvents(): Promise<void> {
    const batch = [...this.pendingLines.entries()];
    const comm = this.pendingComm;
    this.pendingLines.clear();
    this.pendingComm = [];
    this.flushChain = this.flushChain
      .then(async () => {
        for (const [taskId, lines] of batch) {
          const dir = this.taskDir(taskId);
          await fsp.mkdir(dir, { recursive: true });
          await fsp.appendFile(path.join(dir, "events.jsonl"), lines.join(""), "utf8");
        }
        if (comm.length) await fsp.appendFile(this.paths.managerLog, comm.join(""), "utf8");
      })
      .catch((error: unknown) => {
        console.error("[store] failed to flush logs:", error);
      });
    return this.flushChain;
  }

  /** Synchronously persists everything; used during shutdown. */
  flushAllSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushTasks();
    for (const [taskId, lines] of this.pendingLines) {
      const dir = this.taskDir(taskId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "events.jsonl"), lines.join(""), "utf8");
    }
    this.pendingLines.clear();
    if (this.pendingComm.length) fs.appendFileSync(this.paths.managerLog, this.pendingComm.join(""), "utf8");
    this.pendingComm = [];
    this.writeMeta();
  }

  private scheduleFlush(): void {
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.flushEvents();
    }, 200);
  }

  private flushTasks(): void {
    if (this.taskTimer) {
      clearTimeout(this.taskTimer);
      this.taskTimer = null;
    }
    const ids = [...this.dirtyTasks];
    this.dirtyTasks.clear();
    for (const id of ids) {
      const task = this.getTask(id);
      if (!task) continue;
      try {
        this.writeTask(task);
      } catch (error) {
        console.error(`[store] failed to save task ${id}:`, error);
      }
    }
  }

  private writeTask(task: Task): void {
    fs.mkdirSync(this.taskDir(task.id), { recursive: true });
    writeJsonAtomic(this.taskFile(task.id), task);
  }

  private writeMeta(): void {
    writeJsonAtomic(this.paths.hub, this.meta);
  }

  private loadTasks(): Task[] {
    const tasks: Task[] = [];
    for (const entry of fs.readdirSync(this.paths.tasks, { withFileTypes: true })) {
      if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
      const task = readJson<Task>(this.taskFile(entry.name));
      if (isObject(task) && task.id === entry.name && Array.isArray(task.stages)) tasks.push(task);
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Splits the pre-v2 `state.json` into per-entity files, then keeps it as a backup. */
  private migrateLegacyState(): void {
    const legacyFile = this.paths.legacyState;
    if (!fs.existsSync(legacyFile)) return;
    if (!fs.existsSync(this.paths.hub)) {
      let legacy: LegacyState;
      try {
        legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8")) as LegacyState;
      } catch (error) {
        throw new Error(`Cannot migrate ${legacyFile}: ${(error as Error).message}`);
      }
      writeJsonAtomic(this.paths.settings, { ...DEFAULT_SETTINGS, ...(legacy.settings ?? {}) });
      writeJsonAtomic(this.paths.repos, legacy.repos ?? []);
      for (const task of legacy.tasks ?? []) {
        if (!TASK_ID.test(task.id)) continue;
        this.writeTask(task);
      }
      // hub.json is written last: its presence marks a completed migration.
      writeJsonAtomic(this.paths.hub, {
        version: 2,
        nextTaskNumber: legacy.nextTaskNumber ?? (legacy.tasks?.length ?? 0) + 1,
        createdAt: nowIso(),
        migratedFrom: "state.json",
      } satisfies HubMeta);
      console.log(`[store] migrated ${legacyFile} to per-entity files`);
    }
    try {
      fs.renameSync(legacyFile, path.join(this.dataDir, "state.v1.backup.json"));
    } catch {
      // Harmless: hub.json takes precedence over state.json.
    }
  }

  /** Loads the most recent manager log entries (and rotates the log when it grows large). */
  private loadCommTail(): void {
    const file = this.paths.managerLog;
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    const start = Math.max(0, size - COMM_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const known = new Set(this.taskList.map((task) => task.id));
    const entries: CommEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as CommEntry;
        this.commSeq = Math.max(this.commSeq, entry.seq);
        if (known.has(entry.taskId)) entries.push(entry);
      } catch {
        // Ignore a torn line from an unclean shutdown.
      }
    }
    this.comm = entries.slice(-RECENT_COMM_LIMIT);
    if (size > COMM_ROTATE_BYTES) {
      try {
        fs.renameSync(file, path.join(this.dataDir, "manager-log.1.jsonl"));
      } catch {
        // Keep appending to the current file.
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskNumber(id: string): number {
  const match = /^T-(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** Reads a JSON file; a missing file yields null and a corrupt one is set aside (and yields null). */
function readJson<T>(file: string): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const aside = `${file}.corrupt-${Date.now()}`;
    console.error(`[store] ${file} is not valid JSON (${(error as Error).message}); moved it to ${aside}`);
    try {
      fs.renameSync(file, aside);
    } catch {
      // Leave it in place; it will be overwritten on the next save.
    }
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, json, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // rename can fail on Windows while another process (antivirus, indexer) holds the file.
    fs.writeFileSync(file, json, "utf8");
    fs.rmSync(tmp, { force: true });
  }
}
