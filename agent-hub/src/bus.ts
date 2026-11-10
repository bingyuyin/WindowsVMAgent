import { EventEmitter } from "node:events";
import type { Activity, AgentRole, CommEntry, Repo, Settings, Task, TaskEvent, Todo } from "./types.ts";
import type { AuthState } from "./copilot/service.ts";
import type { TaskSummary } from "./workflow/summary.ts";

export type GlobalMessage =
  | { type: "task"; task: TaskSummary }
  | { type: "task-removed"; id: string }
  | { type: "auth"; auth: AuthState }
  | { type: "repos"; repos: readonly Repo[] }
  | { type: "todos"; todos: readonly Todo[] }
  | { type: "settings"; settings: Settings }
  | { type: "comm"; entry: CommEntry }
  | { type: "manager"; lastCheckAt: string | null }
  /** Tasks, to-dos and the manager log were loaded from a data branch: pages reload everything they show. */
  | { type: "data-loaded"; text: string };

export type TaskMessage =
  | { type: "task"; task: Task }
  | { type: "event"; event: TaskEvent }
  | { type: "delta"; role: AgentRole; messageId: string; text: string }
  | { type: "activity"; activity: Activity };

/** In-process pub/sub that fans out state changes to Server-Sent Event subscribers. */
export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publishGlobal(message: GlobalMessage): void {
    this.emitter.emit("global", message);
  }

  onGlobal(listener: (message: GlobalMessage) => void): () => void {
    this.emitter.on("global", listener);
    return () => this.emitter.off("global", listener);
  }

  publishTask(taskId: string, message: TaskMessage): void {
    this.emitter.emit(`task:${taskId}`, message);
  }

  onTask(taskId: string, listener: (message: TaskMessage) => void): () => void {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
