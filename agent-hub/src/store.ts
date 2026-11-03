import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { NewTaskEvent, Repo, Settings, Task, TaskEvent } from "./types.ts";
import { nowIso } from "./util.ts";

interface PersistedState {
  version: 1;
  settings: Settings;
  repos: Repo[];
  tasks: Task[];
  nextTaskNumber: number;
}

export const DEFAULT_SETTINGS: Settings = {
  authorModel: null,
  reviewerModel: null,
  resolverModel: null,
  maxRounds: 3,
  maxConcurrency: 2,
  designDocDir: "docs/designs",
  turnTimeoutMinutes: 90,
  inputTimeoutMinutes: 30,
  isolation: "branch",
  cleanupWorktrees: true,
};

const RECENT_EVENT_LIMIT = 500;
const ARTIFACT_NAME = /^[\w.-]+$/;

/**
 * File-backed persistence: `state.json` (settings, repos, tasks) plus one append-only
 * `events.jsonl` per task and small per-task artifacts (design document snapshots).
 */
export class Store {
  readonly dataDir: string;
  private readonly stateFile: string;
  private state: PersistedState;
  private saveTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly pendingLines = new Map<string, string[]>();
  private readonly recent = new Map<string, TaskEvent[]>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, "state.json");
    this.state = { version: 1, settings: { ...DEFAULT_SETTINGS }, repos: [], tasks: [], nextTaskNumber: 1 };
  }

  load(): void {
    fs.mkdirSync(path.join(this.dataDir, "tasks"), { recursive: true });
    if (!fs.existsSync(this.stateFile)) return;
    const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as Partial<PersistedState>;
    this.state = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      repos: raw.repos ?? [],
      tasks: raw.tasks ?? [],
      nextTaskNumber: raw.nextTaskNumber ?? (raw.tasks?.length ?? 0) + 1,
    };
  }

  get settings(): Settings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    Object.assign(this.state.settings, patch);
    this.save();
    return this.state.settings;
  }

  get repos(): readonly Repo[] {
    return this.state.repos;
  }

  getRepo(id: string): Repo | undefined {
    return this.state.repos.find((repo) => repo.id === id);
  }

  addRepo(repo: Repo): void {
    this.state.repos.push(repo);
    this.save();
  }

  removeRepo(id: string): void {
    this.state.repos = this.state.repos.filter((repo) => repo.id !== id);
    this.save();
  }

  get tasks(): readonly Task[] {
    return this.state.tasks;
  }

  getTask(id: string): Task | undefined {
    return this.state.tasks.find((task) => task.id === id);
  }

  addTask(task: Task): void {
    this.state.tasks.push(task);
    this.save();
  }

  removeTask(id: string): void {
    this.state.tasks = this.state.tasks.filter((task) => task.id !== id);
    this.recent.delete(id);
    this.pendingLines.delete(id);
    this.save();
  }

  allocateTaskId(): string {
    const n = this.state.nextTaskNumber++;
    this.save();
    return `T-${String(n).padStart(3, "0")}`;
  }

  /** Debounced persistence of state.json. */
  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeStateNow();
    }, 250);
  }

  private writeStateNow(): void {
    const json = JSON.stringify(this.state, null, 2);
    const tmp = `${this.stateFile}.tmp`;
    try {
      fs.writeFileSync(tmp, json, "utf8");
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // rename can fail on Windows if another process holds the file; fall back to a direct write.
      fs.writeFileSync(this.stateFile, json, "utf8");
    }
  }

  taskDir(taskId: string): string {
    return path.join(this.dataDir, "tasks", taskId);
  }

  appendEvent(task: Task, event: NewTaskEvent): TaskEvent {
    const full: TaskEvent = { seq: ++task.lastSeq, ts: nowIso(), ...event };
    const ring = this.recent.get(task.id) ?? [];
    ring.push(full);
    if (ring.length > RECENT_EVENT_LIMIT) ring.splice(0, ring.length - RECENT_EVENT_LIMIT);
    this.recent.set(task.id, ring);
    const lines = this.pendingLines.get(task.id) ?? [];
    lines.push(`${JSON.stringify(full)}\n`);
    this.pendingLines.set(task.id, lines);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushEvents();
      }, 200);
    }
    this.save();
    return full;
  }

  flushEvents(): Promise<void> {
    const batch = [...this.pendingLines.entries()];
    this.pendingLines.clear();
    this.flushChain = this.flushChain.then(async () => {
      for (const [taskId, lines] of batch) {
        const dir = this.taskDir(taskId);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.appendFile(path.join(dir, "events.jsonl"), lines.join(""), "utf8");
      }
    }).catch((error: unknown) => {
      console.error("[store] failed to flush events:", error);
    });
    return this.flushChain;
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
    const file = path.join(this.taskDir(taskId), "events.jsonl");
    let content: string;
    try {
      content = await fsp.readFile(file, "utf8");
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

  /** Synchronously persists everything; used during shutdown. */
  flushAllSync(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const [taskId, lines] of this.pendingLines) {
      const dir = this.taskDir(taskId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "events.jsonl"), lines.join(""), "utf8");
    }
    this.pendingLines.clear();
    this.writeStateNow();
  }
}
