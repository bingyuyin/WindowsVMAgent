import type { Bus } from "./bus.ts";
import type { Store } from "./store.ts";
import { ACTIVE_STATUSES, type Task, type Todo } from "./types.ts";
import { HttpError, nowIso } from "./util.ts";
import type { TaskRunner } from "./workflow/runner.ts";

/** Fields of a to-do the user sets; null or "" clears an optional field. */
export interface TodoInput {
  title?: unknown;
  description?: unknown;
  repoId?: unknown;
  baseRef?: unknown;
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 50_000;

/**
 * The to-do list: work the user notes down for the agents, kept (and editable) until it is sent to the manager
 * agent. Sending a to-do submits it as an Auto task - the manager reads it, decides which sub-agents to create
 * and runs it - and links the to-do to that task.
 */
export class TodoService {
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly runner: Pick<TaskRunner, "submit">;
  /** To-dos being sent right now: a second send, an edit or a delete waits for the result. */
  private readonly sending = new Set<string>();

  constructor(store: Store, bus: Bus, runner: Pick<TaskRunner, "submit">) {
    this.store = store;
    this.bus = bus;
    this.runner = runner;
  }

  list(): readonly Todo[] {
    return this.store.todos;
  }

  get(id: string): Todo {
    const todo = this.store.getTodo(id);
    if (!todo) throw new HttpError(404, `To-do ${id} not found`);
    return todo;
  }

  create(input: TodoInput): Todo {
    const description = text(input.description, "description", MAX_DESCRIPTION);
    if (!description) throw new HttpError(400, "Describe the work: the description is what the manager agent gets");
    const title = text(input.title, "title", MAX_TITLE);
    const location = this.location(optional(input.repoId, "repoId"), optional(input.baseRef, "baseRef"));
    const now = nowIso();
    const todo: Todo = { id: this.store.allocateTodoId(), title, description, ...location, status: "open", createdAt: now, updatedAt: now };
    this.store.addTodo(todo);
    this.publish();
    return todo;
  }

  /** Changes the fields present in `input`. Choosing another repository clears the branch unless one is given. */
  update(id: string, input: TodoInput): Todo {
    const todo = this.open(id, "change it");
    let description = todo.description;
    if (input.description !== undefined) {
      description = text(input.description, "description", MAX_DESCRIPTION);
      if (!description) throw new HttpError(400, "The description cannot be empty; delete the to-do instead");
    }
    const title = input.title !== undefined ? text(input.title, "title", MAX_TITLE) : todo.title;
    const repoId = input.repoId !== undefined ? optional(input.repoId, "repoId") : todo.repoId;
    const baseRef = input.baseRef !== undefined ? optional(input.baseRef, "baseRef") : repoId === todo.repoId ? todo.baseRef : undefined;
    const location = this.location(repoId, baseRef);
    Object.assign(todo, { title, description, updatedAt: nowIso() });
    delete todo.repoId;
    delete todo.baseRef;
    Object.assign(todo, location);
    this.store.saveTodos();
    this.publish();
    return todo;
  }

  remove(id: string): void {
    this.get(id);
    if (this.sending.has(id)) throw new HttpError(409, `${id} is being sent to the manager right now`);
    this.store.removeTodo(id);
    this.publish();
  }

  /** Sends the to-do to the manager agent: it becomes an Auto task, which the manager plans and runs. */
  async send(id: string): Promise<{ todo: Todo; task: Task }> {
    const todo = this.open(id, "send it again");
    if (!todo.repoId) throw new HttpError(400, `Choose the repository ${id} is for before sending it to the manager`);
    this.sending.add(id);
    try {
      const task = await this.runner.submit({
        kind: "auto",
        title: todo.title || undefined,
        description: todo.description,
        repoId: todo.repoId,
        baseRef: todo.baseRef,
        todoId: todo.id,
      });
      const at = nowIso();
      Object.assign(todo, { status: "sent", taskId: task.id, sentAt: at, updatedAt: at });
      this.store.saveTodos();
      this.publish();
      return { todo, task };
    } finally {
      this.sending.delete(id);
    }
  }

  /** Puts a sent to-do back on the list, to change it and send it again, once its task is no longer running. */
  reopen(id: string): Todo {
    const todo = this.get(id);
    if (todo.status !== "sent") throw new HttpError(409, `${id} has not been sent to the manager`);
    const task = todo.taskId ? this.store.getTask(todo.taskId) : undefined;
    if (task && ACTIVE_STATUSES.includes(task.status)) {
      throw new HttpError(409, `${task.id} is still ${task.status === "queued" ? "queued" : "running"}; cancel it or let it finish before reopening ${id}`);
    }
    Object.assign(todo, { status: "open", updatedAt: nowIso() });
    this.store.saveTodos();
    this.publish();
    return todo;
  }

  /** A to-do that can still be changed or sent. */
  private open(id: string, action: string): Todo {
    const todo = this.get(id);
    if (this.sending.has(id)) throw new HttpError(409, `${id} is being sent to the manager right now`);
    if (todo.status === "sent") throw new HttpError(409, `${id} was already sent to the manager as ${todo.taskId}; reopen it to ${action}`);
    return todo;
  }

  private location(repoId: string | undefined, baseRef: string | undefined): Pick<Todo, "repoId" | "baseRef"> {
    if (repoId && !this.store.getRepo(repoId)) throw new HttpError(400, `Repository '${repoId}' is not registered`);
    if (baseRef && !repoId) throw new HttpError(400, "Choose the repository before the branch");
    if (baseRef && (/\s/.test(baseRef) || baseRef.startsWith("-"))) throw new HttpError(400, `'${baseRef}' is not a branch name`);
    return { ...(repoId ? { repoId } : {}), ...(baseRef ? { baseRef: baseRef.replace(/^refs\/heads\//, "") } : {}) };
  }

  private publish(): void {
    this.bus.publishGlobal({ type: "todos", todos: this.store.todos });
  }
}

function text(value: unknown, key: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, `'${key}' must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `'${key}' is too long (max ${max.toLocaleString("en-US")} characters)`);
  return trimmed;
}

function optional(value: unknown, key: string): string | undefined {
  return text(value, key, 300) || undefined;
}
