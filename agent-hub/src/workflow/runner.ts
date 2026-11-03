import fs from "node:fs";
import path from "node:path";
import type { AgentDriver, AgentObserver, UserQuestion } from "../agents/driver.ts";
import type { Bus } from "../bus.ts";
import { describeContext, discoverContext, type HubSkills } from "../context.ts";
import { formatOfPath, type DocTemplates } from "../docs.ts";
import { branchWebUrl, primaryRemote, pullRequestPageUrl, pushBranch, sanitizeRemoteUrl, type PullRequestCreator } from "../remote.ts";
import {
  deleteBranch,
  deleteBranchesWithPrefix,
  diffBetween,
  diffStatBetween,
  GitTaskWorkspace,
  inspectRepo,
  isValidBranchName,
  resolveCommit,
  uniqueBranchName,
} from "../git.ts";
import type { Store } from "../store.ts";
import {
  ACTIVE_STATUSES,
  isDocStage,
  MAX_PARALLEL_TASKS,
  ROLE_LABELS,
  stageKindsOf,
  stagesFor,
  TASK_KINDS,
  type AgentInfo,
  type AgentRole,
  type CommEntry,
  type DocFormat,
  type NewCommEntry,
  type NewTaskEvent,
  type PullRequestInfo,
  type PushInfo,
  type Repo,
  type Round,
  type Stage,
  type StageKind,
  type Task,
  type TaskKind,
} from "../types.ts";
import { CancelledError, errorMessage, firstLine, HttpError, KeyedMutex, nowIso, randomId, slugify, truncate } from "../util.ts";
import { modelFor, WorkflowEngine, type EngineHooks } from "./engine.ts";
import { summarizeTask } from "./summary.ts";

export interface SubmitTaskInput {
  title?: string;
  description: string;
  kind: TaskKind;
  repoId: string;
  baseRef?: string;
  authorModel?: string;
  reviewerModel?: string;
  resolverModel?: string;
  managerModel?: string;
  maxRounds?: number;
}

/** The subset of the Copilot service the runner depends on. */
export interface RuntimeGate {
  isReady(): boolean;
  deleteSessions(sessionIds: readonly string[]): Promise<void>;
}

export interface RunnerDeps {
  store: Store;
  bus: Bus;
  runtime: RuntimeGate;
  driver: AgentDriver;
  worktreesDir: string;
  hubSkills?: HubSkills;
  docTemplates?: DocTemplates | null;
  /** Creates pull requests directly (e.g. with the GitHub CLI); without it the host's create page is used. */
  pullRequests?: PullRequestCreator;
  /** How often the manager checks on working agents (default 60 s). */
  monitorIntervalMs?: number;
  /** Silence after which the manager posts a check-in about a working agent (default 5 min). */
  stallAfterMs?: number;
}

interface RunningTask {
  controller: AbortController;
  engine: WorkflowEngine | null;
  done: Promise<void> | null;
}

interface InputWaiter {
  inputId: string;
  resolve: (answer: string) => void;
}

/** Result of asking for a pull request: either it exists/was created, or the host's create page to open. */
export interface PullRequestOutcome {
  pullRequest?: PullRequestInfo;
  /** The host's "create pull request" page (with branches filled in) when it cannot be created directly. */
  createUrl?: string;
  message: string;
}

/** What the manager is doing right now (for the Agents view). */
export interface ManagerOverview {
  online: boolean;
  startedAt: string;
  capacity: number;
  running: number;
  queued: number;
  needsInput: number;
  workingAgents: number;
  monitorIntervalSec: number;
  lastCheckAt: string | null;
  comm: CommEntry[];
}

const NO_ANSWER =
  "The user did not answer in time. Proceed using your best judgment and state your assumptions explicitly in your summary.";
const SHA = /^[0-9a-f]{7,40}$/i;
const MAX_AUTO_RESUMES = 3;
/** Heartbeats are frequent (streaming, tool output); publish them to the UI at most this often per task. */
const HEARTBEAT_PUBLISH_MS = 30_000;

export const KIND_LABELS: Record<TaskKind, string> = {
  auto: "Auto (manager plans)",
  coding: "Coding",
  design: "Design",
  document: "Document",
  testing: "Execute & verify",
  "design-coding": "Design → Coding",
};

/** Queues tasks, prepares git worktrees, runs workflow engines and relays their progress. */
export class TaskRunner {
  private readonly deps: RunnerDeps;
  private readonly running = new Map<string, RunningTask>();
  private readonly waiters = new Map<string, InputWaiter>();
  private readonly repoLocks = new KeyedMutex();
  private readonly updateTimers = new Map<string, NodeJS.Timeout>();
  /** Work that runs after a task has released its slot (pushing its branch). */
  private readonly postWork = new Set<Promise<unknown>>();
  /** Tasks interrupted by the last hub stop that resume once the runtime is signed in. */
  private readonly resumeQueue = new Set<string>();
  private readonly checkIns = new Set<string>();
  private readonly heartbeatsPublished = new Map<string, number>();
  private readonly startedAt = nowIso();
  private monitorTimer: NodeJS.Timeout | null = null;
  private lastCheckAt: string | null = null;
  private shuttingDown = false;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  /** Restores tasks from the last run: running ones become interrupted (and are queued to resume if enabled). */
  init(): void {
    const { store } = this.deps;
    for (const task of store.tasks) {
      if (task.push?.status === "pushing") {
        task.push = { ...task.push, status: "failed", reason: "The hub stopped while the branch was being pushed; push it again", at: nowIso() };
        store.saveTask(task);
      }
      if (task.status !== "running" && task.status !== "needs-input") continue;
      task.status = "interrupted";
      task.activity = undefined;
      task.pendingInput = undefined;
      for (const agent of task.agents ?? []) {
        if (agent.status === "working" || agent.status === "idle") agent.status = "cancelled";
      }
      const resume = store.settings.resumeInterruptedTasks && (task.autoResumes ?? 0) < MAX_AUTO_RESUMES;
      if (resume) this.resumeQueue.add(task.id);
      this.emit(task, {
        type: "status",
        text: resume
          ? "Interrupted: the hub stopped while this task was running. It resumes automatically once the hub is signed in."
          : "Interrupted: the hub stopped while this task was running. Use Retry to resume.",
      });
      this.comm(task, {
        from: "manager",
        to: "user",
        kind: "lifecycle",
        text: resume ? "Interrupted by a hub restart; will resume automatically" : "Interrupted by a hub restart; waiting for Retry",
      });
      store.saveTask(task);
    }
    this.startMonitor();
  }

  get(id: string): Task {
    const task = this.deps.store.getTask(id);
    if (!task) throw new HttpError(404, `Task ${id} not found`);
    return task;
  }

  hasActiveTasks(): boolean {
    return this.deps.store.tasks.some((task) => ACTIVE_STATUSES.includes(task.status));
  }

  async submit(input: SubmitTaskInput): Promise<Task> {
    const { store } = this.deps;
    const description = typeof input.description === "string" ? input.description.trim() : "";
    if (!description) throw new HttpError(400, "A task description is required");
    if (description.length > 50_000) throw new HttpError(400, "The description is too long (max 50,000 characters)");
    if (!TASK_KINDS.includes(input.kind)) throw new HttpError(400, `Task type must be one of: ${TASK_KINDS.join(", ")}`);
    const repo = store.getRepo(String(input.repoId ?? ""));
    if (!repo) throw new HttpError(400, "Select a registered repository");

    const settings = store.settings;
    const authorModel = (input.authorModel || settings.authorModel || "").trim();
    const reviewerModel = (input.reviewerModel || settings.reviewerModel || authorModel).trim();
    const resolverModel = (input.resolverModel || settings.resolverModel || authorModel).trim();
    const managerModel = input.kind === "auto" ? (input.managerModel || settings.managerModel || authorModel).trim() : undefined;
    if (!authorModel || !reviewerModel) throw new HttpError(400, "Choose the author and reviewer models first (Settings)");
    const maxRounds = clampInt(input.maxRounds ?? settings.maxRounds, 1, 10);

    let baseRef: string;
    let baseSha: string;
    try {
      const info = await inspectRepo(repo.path);
      baseRef = input.baseRef?.trim() || info.branch || repo.defaultBranch;
      baseSha = await resolveCommit(repo.path, baseRef);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }

    const now = nowIso();
    const title = truncate((input.title ?? "").trim() || firstLine(description), 100);
    const task: Task = {
      id: store.allocateTaskId(),
      title,
      description,
      kind: input.kind,
      repoId: repo.id,
      repoName: repo.name,
      baseRef,
      baseSha,
      isolation: settings.isolation,
      layout: 2,
      authorModel,
      reviewerModel,
      resolverModel,
      managerModel,
      maxRounds,
      status: "queued",
      phase: "queued",
      currentRound: 0,
      stages: stagesFor(input.kind).map((kind) => ({ kind, status: "pending", rounds: [], nextCommentNumber: 1 })),
      agents: [],
      sessions: [],
      usage: { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 },
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    };
    store.addTask(task);
    this.emit(task, { type: "status", text: `Queued ${KIND_LABELS[task.kind]} task on ${repo.name} @ ${baseRef} (${baseSha.slice(0, 10)})` });
    this.comm(task, {
      from: "user",
      to: "manager",
      kind: "lifecycle",
      text: `New ${KIND_LABELS[task.kind]} task on ${repo.name} @ ${baseRef}: ${truncate(firstLine(description), 140)}`,
    });
    this.publish(task);
    this.pump();
    return task;
  }

  cancel(id: string): Task {
    const task = this.get(id);
    if (task.status === "queued" && !this.running.has(id)) {
      task.status = "cancelled";
      task.finishedAt = nowIso();
      this.emit(task, { type: "status", text: "Cancelled before it started" });
      this.comm(task, { from: "user", to: "manager", kind: "lifecycle", text: "Cancelled before it started" });
      this.publish(task);
      return task;
    }
    const run = this.running.get(id);
    if (!run) throw new HttpError(409, `Task ${id} is not running`);
    this.emit(task, { type: "status", text: "Cancellation requested" });
    this.comm(task, { from: "user", to: "manager", kind: "lifecycle", text: "Cancel requested; stopping the agents" });
    run.controller.abort();
    void run.engine?.abortAgents();
    return task;
  }

  retry(id: string, extraRounds?: number): Task {
    const task = this.get(id);
    const unapproved = task.status === "completed" && task.result?.approved === false;
    if (!["failed", "cancelled", "interrupted"].includes(task.status) && !unapproved) {
      throw new HttpError(409, "Only failed, cancelled, interrupted or unapproved tasks can be retried");
    }
    this.resumeQueue.delete(id);
    task.autoResumes = 0;
    const verb = unapproved ? "Continuing" : "Retrying";
    this.requeue(task, extraRounds ?? task.maxRounds, verb);
    this.comm(task, { from: "user", to: "manager", kind: "lifecycle", text: `${verb} (attempt ${task.attempt}, up to ${task.roundsBudget} more review round(s))` });
    this.publish(task);
    this.pump();
    return task;
  }

  /**
   * Asks for further changes to a finished task, approved or not. The request becomes comment U<n> in a new
   * round of the chosen stage (the last one by default): that stage's author - the comment resolver for code,
   * the test fixer for tests - makes the change on its own branch and the stage's reviewer (or the test
   * executor) verifies it, round by round. Later stages then bring their work in line with it (the test
   * executor re-runs the tests), and the task completes and is pushed again.
   */
  requestChanges(id: string, input: { request: string; stage?: string; rounds?: number }): Task {
    const task = this.get(id);
    if (this.running.has(id) || task.status !== "completed") throw new HttpError(409, "Changes can be requested once the task has finished");
    const text = (input.request ?? "").trim();
    if (!text) throw new HttpError(400, "Describe the changes you want");
    if (text.length > 20_000) throw new HttpError(400, "The change request is too long (max 20,000 characters)");
    const kinds = stageKindsOf(task);
    const target = (input.stage || kinds.at(-1)) as StageKind | undefined;
    const index = target ? kinds.indexOf(target) : -1;
    if (!target || index < 0) throw new HttpError(400, kinds.length ? `Stage must be one of: ${kinds.join(", ")}` : "This task has no stages to change");
    const rounds = input.rounds ?? task.maxRounds;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new HttpError(400, "Rounds must be an integer between 1 and 10");

    const requestId = `U${(task.changeRequests?.length ?? 0) + 1}`;
    this.resumeQueue.delete(id);
    task.autoResumes = 0;
    this.requeue(task, rounds, `Change request ${requestId}`);
    const now = nowIso();
    const stageOf = (kind: StageKind): Stage => {
      let stage = task.stages.find((candidate) => candidate.kind === kind);
      if (!stage) task.stages.push((stage = { kind, status: "pending", rounds: [], nextCommentNumber: 1 }));
      return stage;
    };
    // The request is a round of its own: a "review" by the user whose comment the stage's agents must address.
    const addRequestRound = (stage: Stage, body: string, summary: string): Round => {
      const round: Round = {
        n: stage.rounds.length + 1,
        attempt: task.attempt,
        startedAt: now,
        review: { verdict: "request_changes", by: "user", summary, comments: [{ id: requestId, severity: "major", body, status: "open" }], at: now },
      };
      stage.rounds.push(round);
      stage.status = "pending";
      return round;
    };
    const round = addRequestRound(stageOf(target), text, `Change request ${requestId} from the user`);
    const later = kinds.slice(index + 1);
    for (const kind of later) {
      const stage = stageOf(kind);
      if (kind === "testing") {
        stage.rerun = true;
        stage.status = "pending";
      } else {
        addRequestRound(stage, cascadeRequest(target, kind, requestId, text), `Bring this stage in line with change request ${requestId}`);
      }
    }
    (task.changeRequests ??= []).push({ id: requestId, text, stage: target, round: round.n, attempt: task.attempt, rounds: task.roundsBudget ?? rounds, requestedAt: now });
    this.emit(task, {
      type: "info",
      stage: target,
      round: round.n,
      text: `Change request ${requestId} from the user (${STAGE_TITLES[target]} stage): ${truncate(text, 2000)}`,
      data: { changeRequest: requestId },
    });
    this.comm(task, { from: "user", to: "manager", kind: "lifecycle", stage: target, round: round.n, text: `Change request ${requestId} for the ${STAGE_TITLES[target]} stage: ${truncate(firstLine(text), 160)}` });
    if (later.length) {
      this.comm(task, {
        from: "manager",
        to: "manager",
        kind: "lifecycle",
        text: `After ${requestId}: ${later.map((kind) => (kind === "testing" ? "re-run the tests" : `update the ${STAGE_TITLES[kind]} stage to match`)).join(", then ")}`,
      });
    }
    this.publish(task);
    this.pump();
    return task;
  }

  private requeue(task: Task, rounds: number, verb: string): void {
    task.attempt += 1;
    task.roundsBudget = clampInt(rounds, 1, 10);
    task.status = "queued";
    task.phase = "queued";
    task.error = undefined;
    task.finishedAt = undefined;
    task.result = undefined;
    this.emit(task, { type: "status", text: `${verb} (attempt ${task.attempt}, up to ${task.roundsBudget} more review round(s))` });
  }

  /** Re-queues tasks interrupted by the last hub stop (once the runtime is signed in). */
  private resumeInterrupted(): void {
    for (const id of [...this.resumeQueue]) {
      this.resumeQueue.delete(id);
      const task = this.deps.store.getTask(id);
      if (task?.status !== "interrupted") continue;
      task.autoResumes = (task.autoResumes ?? 0) + 1;
      this.requeue(task, task.roundsBudget ?? task.maxRounds, "Resuming after the hub restart");
      this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: `Resuming after the hub restart (attempt ${task.attempt})` });
      this.publish(task);
    }
  }

  answer(id: string, inputId: string, answer: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter || waiter.inputId !== inputId) throw new HttpError(409, "This task has no pending question with that id");
    const text = String(answer ?? "").trim();
    if (!text) throw new HttpError(400, "An answer is required");
    waiter.resolve(truncate(text, 10_000));
  }

  async remove(id: string, options: { deleteBranch?: boolean } = {}): Promise<void> {
    const { store, bus, runtime } = this.deps;
    const task = this.get(id);
    if (this.running.has(id) || ACTIVE_STATUSES.includes(task.status)) {
      throw new HttpError(409, "Cancel the task before deleting it");
    }
    const repo = store.getRepo(task.repoId);
    const root = task.workspaceRoot ?? task.worktreePath ?? path.join(this.deps.worktreesDir, task.id);
    if (repo && fs.existsSync(repo.path) && task.baseSha && task.branch) {
      await this.workspaceFor(task, repo, root).removeWorktrees();
      await this.repoLocks.run(repo.path, async () => {
        await deleteBranchesWithPrefix(repo.path, `${task.branch}--`);
        if (options.deleteBranch) await deleteBranch(repo.path, task.branch!);
      });
    } else if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    await runtime.deleteSessions(task.sessions.map((session) => session.sessionId));
    store.removeTask(id);
    await store.deleteTaskData(id);
    bus.publishGlobal({ type: "task-removed", id });
  }

  /** Starts queued tasks while there is capacity and the Copilot runtime is signed in; the rest stay queued. */
  pump(): void {
    if (this.shuttingDown || !this.deps.runtime.isReady()) return;
    this.resumeInterrupted();
    const limit = this.capacity();
    const queued = this.deps.store.tasks
      .filter((task) => task.status === "queued" && !this.running.has(task.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const task of queued) {
      if (this.running.size >= limit) break;
      const entry: RunningTask = { controller: new AbortController(), engine: null, done: null };
      this.running.set(task.id, entry);
      entry.done = this.execute(task, entry);
    }
  }

  /** Waits until no task is running and post-completion work (pushes) has finished (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running.size || this.postWork.size) {
      await Promise.all([...[...this.running.values()].map((entry) => entry.done), ...this.postWork]);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopMonitor();
    const entries = [...this.running.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map((entry) => entry.engine?.abortAgents()));
    await Promise.race([Promise.all([...entries.map((entry) => entry.done), ...this.postWork]), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  /** How many tasks may run at once: the Parallel tasks setting, never more than MAX_PARALLEL_TASKS. */
  capacity(): number {
    return clampInt(this.deps.store.settings.maxConcurrency, 1, MAX_PARALLEL_TASKS);
  }

  /** The manager's state plus its recent communication with sub-agents. */
  overview(options: { limit?: number; taskId?: string } = {}): ManagerOverview {
    const { store, runtime } = this.deps;
    const tasks = store.tasks;
    return {
      online: runtime.isReady(),
      startedAt: this.startedAt,
      capacity: this.capacity(),
      running: this.running.size,
      queued: tasks.filter((task) => task.status === "queued").length,
      needsInput: tasks.filter((task) => task.status === "needs-input").length,
      workingAgents: tasks.reduce((count, task) => count + (task.agents ?? []).filter((agent) => agent.status === "working").length, 0),
      monitorIntervalSec: Math.round((this.deps.monitorIntervalMs ?? 60_000) / 1000),
      lastCheckAt: this.lastCheckAt,
      comm: store.recentComm({ limit: options.limit ?? 300, taskId: options.taskId }),
    };
  }

  async diff(id: string, from?: string, to?: string): Promise<{ from: string; to: string; stat: string; text: string; truncated: boolean }> {
    const task = this.get(id);
    const repo = this.deps.store.getRepo(task.repoId);
    if (!repo || !task.baseSha || !task.branch) throw new HttpError(404, "This task has no changes yet");
    const fromRef = from && SHA.test(from) ? from : task.baseSha;
    const toRef = to && SHA.test(to) ? to : task.branch;
    const [diff, stat] = await Promise.all([diffBetween(repo.path, fromRef, toRef, 3_000_000), diffStatBetween(repo.path, fromRef, toRef)]);
    return { from: fromRef, to: toRef, stat, ...diff };
  }

  /** The task's design/document deliverable as of a review round (default: the latest). */
  async document(
    id: string,
    round?: number,
  ): Promise<{ stage: StageKind; path: string | null; format: DocFormat; round: number | null; rounds: number[]; content: string | null }> {
    const task = this.get(id);
    const stage = task.stages.find((candidate) => isDocStage(candidate.kind));
    if (!stage) throw new HttpError(404, "This task has no design or document stage");
    const format = stage.docFormat ?? (stage.docPath ? formatOfPath(stage.docPath) : "markdown");
    const rounds = stage.rounds.filter((candidate) => candidate.author?.docSnapshot);
    const target = round ? rounds.find((candidate) => candidate.n === round) : rounds.at(-1);
    const base = { stage: stage.kind, path: stage.docPath ?? null, format, rounds: rounds.map((candidate) => candidate.n) };
    if (!target?.author?.docSnapshot) return { ...base, round: null, content: null };
    const content = await this.deps.store.readArtifact(task.id, target.author.docSnapshot);
    return { ...base, round: target.n, content };
  }

  /** Pushes the task branch now (e.g. after a failed automatic push, or with automatic pushes turned off). */
  async pushNow(id: string): Promise<Task> {
    const task = this.get(id);
    if (this.running.has(id) || ACTIVE_STATUSES.includes(task.status)) throw new HttpError(409, "Wait until the task has finished before pushing its branch");
    if (task.push?.status === "pushing") throw new HttpError(409, "The branch is being pushed right now");
    await this.pushTask(task, false);
    return task;
  }

  /**
   * Opens a pull request for the task branch: pushes the latest commit first, then creates the pull request
   * directly when a creator (the GitHub CLI) can, otherwise returns the host's prefilled create page.
   */
  async pullRequest(id: string): Promise<PullRequestOutcome> {
    const task = this.get(id);
    if (this.running.has(id) || ACTIVE_STATUSES.includes(task.status)) throw new HttpError(409, "Wait until the task has finished before opening a pull request");
    if (task.pullRequest) return { pullRequest: task.pullRequest, message: `Pull request ${prName(task.pullRequest)} already exists` };
    const repo = this.deps.store.getRepo(task.repoId);
    if (!repo || !task.branch || !task.baseSha) throw new HttpError(409, "This task has no branch to open a pull request for");
    const remote = await primaryRemote(repo.path);
    if (!remote) throw new HttpError(409, "No git remote is configured for this repository, so there is nowhere to open a pull request");
    const head = await resolveCommit(repo.path, `refs/heads/${task.branch}`);
    if (!(task.push?.status === "pushed" && task.push.sha === head)) {
      const push = await this.pushTask(task, false, true);
      if (push.status !== "pushed") throw new HttpError(409, `The branch could not be pushed: ${push.reason ?? push.status}`);
    }
    const request = {
      head: task.branch,
      base: pullRequestBase(task, repo),
      title: task.title,
      body: pullRequestBody(task),
      draft: !task.result?.approved,
    };
    const creator = this.deps.pullRequests;
    if (creator && (await creator.canCreate(remote))) {
      try {
        const created = (await creator.findOpen(remote, request.head)) ?? (await creator.create(remote, request));
        task.pullRequest = { ...created, base: request.base, createdAt: nowIso() };
      } catch (error) {
        throw new HttpError(502, sanitizeRemoteUrl(errorMessage(error)));
      }
      const name = prName(task.pullRequest);
      this.emit(task, { type: "info", text: `Pull request ${name} opened: ${task.pullRequest.url}`, data: { pullRequest: task.pullRequest } });
      this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: `Opened pull request ${name}${task.pullRequest.draft ? " (draft)" : ""} into ${request.base}` });
      this.publish(task);
      return { pullRequest: task.pullRequest, message: `Opened pull request ${name}` };
    }
    const createUrl = pullRequestPageUrl(remote, request);
    if (!createUrl) throw new HttpError(409, `Pull requests are not supported for this remote (${remote.url})`);
    return { createUrl, message: `Opening the ${remote.host ?? "remote"} page to create the pull request` };
  }

  /** What the UI's pull request button can do for this task. */
  async pullRequestStatus(id: string): Promise<{
    remote: { name: string; url: string; provider: string; host?: string } | null;
    /** True when the pull request can be created directly (GitHub CLI signed in); otherwise the host's page opens. */
    direct: boolean;
    supported: boolean;
    pullRequest?: PullRequestInfo;
  }> {
    const task = this.get(id);
    const repo = this.deps.store.getRepo(task.repoId);
    const remote = repo ? await primaryRemote(repo.path) : null;
    if (!remote) return { remote: null, direct: false, supported: false, pullRequest: task.pullRequest };
    const direct = Boolean(this.deps.pullRequests && (await this.deps.pullRequests.canCreate(remote)));
    return {
      remote: { name: remote.name, url: remote.url, provider: remote.provider, host: remote.host },
      direct,
      supported: direct || remote.webUrl !== null,
      pullRequest: task.pullRequest,
    };
  }

  /**
   * Pushes the task branch to the repository's remote; never throws (the outcome is recorded on the task).
   * With `reuseCurrent`, a push that already sent the current head (e.g. an automatic push that finished
   * while this call waited for the lock) is returned as is.
   */
  private async pushTask(task: Task, auto: boolean, reuseCurrent = false): Promise<PushInfo> {
    const repo = this.deps.store.getRepo(task.repoId);
    const branch = task.branch;
    const record = (info: PushInfo): PushInfo => {
      task.push = info;
      const where = info.remote ? `${info.remote}/${info.branch}` : info.branch;
      if (info.status === "pushed") {
        this.emit(task, { type: "info", text: `Pushed ${info.branch} to ${info.remote} (${info.sha?.slice(0, 10)})`, data: { push: info } });
        this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: `Pushed the task branch to ${where} (${info.sha?.slice(0, 10)})` });
      } else if (info.status === "failed") {
        this.emit(task, { type: "warning", text: `Could not push ${info.branch} to ${info.remote}: ${info.reason}`, data: { push: info } });
        this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: `Could not push ${where}: ${truncate(info.reason ?? "", 200)}` });
      } else if (info.status === "skipped") {
        this.emit(task, { type: "info", text: `Branch not pushed: ${info.reason}`, data: { push: info } });
      }
      this.publish(task);
      return info;
    };
    if (!repo || !branch || !task.baseSha) return record({ status: "skipped", branch: branch ?? "", reason: "The task has no branch", auto, at: nowIso() });
    // Pushes on one repository go one at a time; other tasks' worktree work is not blocked.
    return this.repoLocks.run(`${repo.path}#push`, async () => {
      try {
        const remote = await primaryRemote(repo.path);
        if (!remote) return record({ status: "skipped", branch, reason: "No git remote is configured for this repository", auto, at: nowIso() });
        const sha = await resolveCommit(repo.path, `refs/heads/${branch}`);
        if (reuseCurrent && task.push?.status === "pushed" && task.push.sha === sha && task.push.remote === remote.name) return task.push;
        const target = { branch, remote: remote.name, remoteUrl: remote.url, sha, auto };
        if (sha === task.baseSha) return record({ ...target, status: "skipped", reason: "The task made no changes, so there is nothing to push", at: nowIso() });
        task.push = { ...target, status: "pushing", at: nowIso() };
        this.publish(task);
        await pushBranch(repo.path, remote.name, branch);
        return record({ ...target, status: "pushed", webUrl: branchWebUrl(remote, branch) ?? undefined, at: nowIso() });
      } catch (error) {
        return record({ status: "failed", branch, remote: task.push?.remote, remoteUrl: task.push?.remoteUrl, sha: task.push?.sha, reason: truncate(errorMessage(error), 1000), auto, at: nowIso() });
      }
    });
  }

  private async execute(task: Task, entry: RunningTask): Promise<void> {
    const { store, driver } = this.deps;
    const hooks = this.hooksFor(task, entry.controller);
    try {
      task.status = "running";
      task.phase = "preparing";
      task.phaseStartedAt = nowIso();
      task.currentRound = 0;
      task.startedAt ??= nowIso();
      task.attemptStartedAt = nowIso();
      task.finishedAt = undefined;
      task.error = undefined;
      this.emit(task, { type: "status", text: `Started (attempt ${task.attempt})` });
      this.comm(task, {
        from: "manager",
        to: "manager",
        kind: "lifecycle",
        text: `Picked up the task (attempt ${task.attempt}; ${this.running.size} of ${this.capacity()} slots in use); preparing workspaces`,
      });
      this.publish(task);
      const repo = store.getRepo(task.repoId);
      if (!repo) throw new Error("The repository is no longer registered");
      const workspace = await this.prepareWorkspace(task, repo);
      if (entry.controller.signal.aborted) throw new CancelledError();
      task.context = await discoverContext(repo.path, task.baseSha!);
      this.emit(task, { type: "info", text: `Repository context: ${describeContext(task.context)}`, data: { context: true } });
      this.publish(task);
      const engine = new WorkflowEngine(task, {
        driver,
        workspace,
        settings: store.settings,
        hooks,
        hubSkills: this.deps.hubSkills,
        docTemplates: this.deps.docTemplates,
      });
      entry.engine = engine;
      await engine.run();
      task.status = "completed";
      task.roundsBudget = undefined;
      this.emit(task, { type: "status", text: completionText(task) });
    } catch (error) {
      if (this.shuttingDown) {
        task.status = "interrupted";
        this.emit(task, { type: "status", text: "Interrupted by hub shutdown" });
      } else if (entry.controller.signal.aborted || error instanceof CancelledError) {
        task.status = "cancelled";
        this.emit(task, { type: "status", text: "Cancelled" });
      } else {
        task.status = "failed";
        task.error = errorMessage(error);
        this.emit(task, { type: "error", text: `Failed: ${task.error}` });
      }
    } finally {
      task.finishedAt = nowIso();
      task.activity = undefined;
      task.pendingInput = undefined;
      if (task.status !== "interrupted") task.autoResumes = undefined;
      for (const agent of task.agents ?? []) {
        if (agent.status === "working" || agent.status === "idle") {
          agent.status = task.status === "completed" ? "done" : task.status === "failed" ? "failed" : "cancelled";
        }
      }
      this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: this.outcomeText(task) });
      this.running.delete(task.id);
      this.waiters.delete(task.id);
      this.heartbeatsPublished.delete(task.id);
      this.publish(task);
      this.pump();
      if (task.status === "completed" && store.settings.pushOnComplete && !this.shuttingDown) this.afterTask(this.pushTask(task, true));
    }
  }

  /** Tracks work that continues after the task has released its slot. */
  private afterTask(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => console.error("[runner] post-task work failed:", error)).finally(() => this.postWork.delete(tracked));
    this.postWork.add(tracked);
  }

  private outcomeText(task: Task): string {
    switch (task.status) {
      case "completed": {
        const result = task.result;
        const tests = result?.tests;
        const detail = [
          result?.shortStat,
          tests ? `tests ${tests.status}${tests.total !== undefined ? ` (${tests.passed ?? tests.total - (tests.failed ?? 0)}/${tests.total})` : ""}` : "",
          result?.docPath ? `document ${result.docPath}` : "",
        ]
          .filter(Boolean)
          .join("; ");
        return `${completionText(task)}${detail ? ` - ${detail}` : ""}`;
      }
      case "failed":
        return `Failed: ${truncate(task.error ?? "unknown error", 200)}`;
      case "interrupted":
        return "Interrupted by hub shutdown";
      default:
        return "Cancelled";
    }
  }

  private workspaceFor(task: Task, repo: Repo, root = task.workspaceRoot ?? path.join(this.deps.worktreesDir, task.id)): GitTaskWorkspace {
    return new GitTaskWorkspace({
      repoPath: repo.path,
      baseSha: task.baseSha!,
      taskBranch: task.branch!,
      root,
      isolation: task.isolation ?? this.deps.store.settings.isolation,
      lock: (work) => this.repoLocks.run(repo.path, work),
    });
  }

  private async prepareWorkspace(task: Task, repo: Repo): Promise<GitTaskWorkspace> {
    await this.repoLocks.run(repo.path, async () => {
      task.baseSha ??= await resolveCommit(repo.path, task.baseRef);
      if (!task.branch) {
        let base = `agent-hub/${task.id.toLowerCase()}-${slugify(task.title, 32)}`;
        if (!(await isValidBranchName(repo.path, base))) base = `agent-hub/${task.id.toLowerCase()}`;
        task.branch = await uniqueBranchName(repo.path, base);
      }
    });
    task.workspaceRoot ??= path.join(this.deps.worktreesDir, task.id);
    task.isolation ??= this.deps.store.settings.isolation;
    const workspace = this.workspaceFor(task, repo);
    if (task.layout !== 2) {
      // Tasks created before per-agent workspaces had one worktree on the task branch itself.
      if (await workspace.migrateLegacyWorktree()) {
        this.emit(task, { type: "info", text: "Moved this task to per-agent branches and worktrees." });
      }
      task.layout = 2;
      task.worktreePath = undefined;
    }
    await this.repoLocks.run(repo.path, () => workspace.ensureTaskBranch());
    this.emit(task, {
      type: "info",
      text:
        task.isolation === "worktree"
          ? `Task branch ${task.branch}; each sub-agent gets its own worktree and branch under ${task.workspaceRoot}`
          : `Task branch ${task.branch}; author agents work on their own branches in ${path.join(task.workspaceRoot, "author")}, reviewers in ${path.join(task.workspaceRoot, "review")}`,
    });
    this.publish(task);
    return workspace;
  }

  private hooksFor(task: Task, controller: AbortController): EngineHooks {
    return {
      signal: controller.signal,
      emit: (event) => this.emit(task, event),
      update: () => this.publish(task),
      observer: (role, stage) => this.observer(task, role, stage),
      askUser: (role, question) => this.askUser(task, role, question, controller.signal),
      saveArtifact: (name, content) => this.deps.store.writeArtifact(task.id, name, content),
      readArtifact: (name) => this.deps.store.readArtifact(task.id, name),
      trackSession: (role, sessionId) => {
        task.sessions.push({ role, sessionId, attempt: task.attempt });
        this.publish(task);
      },
      agent: (role, mutate) => {
        mutate(this.agentInfo(task, role));
        this.publish(task);
      },
      comm: (entry) => this.comm(task, entry),
    };
  }

  /** Live state of a sub-agent, created on first use. */
  private agentInfo(task: Task, role: AgentRole): AgentInfo {
    task.agents ??= [];
    let info = task.agents.find((candidate) => candidate.role === role);
    if (!info) {
      info = {
        role,
        model: modelFor(task, role),
        status: "idle",
        turns: 0,
        rounds: [],
        usage: { inputTokens: 0, outputTokens: 0, premiumRequests: 0, modelCalls: 0 },
      };
      task.agents.push(info);
    }
    info.updatedAt = nowIso();
    return info;
  }

  private observer(task: Task, role: AgentRole, stage?: StageKind): AgentObserver {
    return {
      onDelta: (messageId, text) => this.deps.bus.publishTask(task.id, { type: "delta", role, messageId, text }),
      onMessage: (text) => {
        this.agentInfo(task, role).lastMessage = truncate(text.trim(), 400);
        this.emit(task, { type: "agent.message", role, stage, text: truncate(text, 20_000) });
        this.scheduleUpdate(task);
      },
      onIntent: (text) => this.setActivity(task, role, text),
      onToolStart: (info) => {
        this.emit(task, { type: "tool.start", role, stage, text: info.label, data: { toolCallId: info.id, tool: info.name, subAgent: info.subAgent } });
        if (!info.subAgent) this.setActivity(task, role, info.label);
      },
      onToolDone: (info) =>
        this.emit(task, {
          type: "tool.done",
          role,
          stage,
          text: info.success ? "" : truncate(info.error ?? "failed", 600),
          data: { toolCallId: info.id, tool: info.name, success: info.success },
        }),
      onUsage: (usage) => {
        for (const target of [task.usage, this.agentInfo(task, role).usage]) {
          target.inputTokens += usage.inputTokens;
          target.outputTokens += usage.outputTokens;
          target.premiumRequests += usage.premiumRequests;
          target.modelCalls += 1;
        }
        this.scheduleUpdate(task);
      },
      onError: (message) => this.emit(task, { type: "error", role, stage, text: message }),
      onInfo: (message) => this.emit(task, { type: "info", role, stage, text: message }),
      onHeartbeat: () => {
        // agentInfo() stamps updatedAt, the agent's last sign of life that the monitor measures silence from.
        this.agentInfo(task, role);
        const now = Date.now();
        if (now - (this.heartbeatsPublished.get(task.id) ?? 0) < HEARTBEAT_PUBLISH_MS) return;
        this.heartbeatsPublished.set(task.id, now);
        this.scheduleUpdate(task);
      },
    };
  }

  private setActivity(task: Task, role: AgentRole, text: string): void {
    task.activity = { role, text: truncate(firstLine(text), 200), at: nowIso() };
    this.agentInfo(task, role).lastActivity = task.activity.text;
    this.deps.bus.publishTask(task.id, { type: "activity", activity: task.activity });
    this.scheduleUpdate(task);
  }

  private askUser(task: Task, role: AgentRole, question: UserQuestion, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new CancelledError());
    const inputId = randomId(10);
    task.pendingInput = {
      id: inputId,
      role,
      question: question.question,
      choices: question.choices,
      allowFreeform: question.allowFreeform,
      askedAt: nowIso(),
    };
    task.status = "needs-input";
    this.emit(task, { type: "input.request", role, text: question.question, data: { choices: question.choices } });
    this.comm(task, { from: role, to: "user", kind: "question", text: truncate(question.question, 300) });
    this.publish(task);
    return new Promise<string>((resolve, reject) => {
      const finish = (answer: string | null, error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(task.id);
        task.pendingInput = undefined;
        if (task.status === "needs-input") task.status = "running";
        // Waiting for the user is not silence: restart the agent's clock.
        this.agentInfo(task, role);
        if (answer !== null) {
          this.emit(task, { type: "input.answer", role, text: answer });
          this.comm(task, {
            from: answer === NO_ANSWER ? "manager" : "user",
            to: role,
            kind: "answer",
            text: answer === NO_ANSWER ? "No answer in time - proceed with your best judgment" : truncate(answer, 300),
          });
        }
        this.publish(task);
        if (error) reject(error);
        else resolve(answer ?? NO_ANSWER);
      };
      const onAbort = () => finish(null, new CancelledError());
      const timer = setTimeout(() => {
        this.emit(task, { type: "warning", role, text: "No answer received in time; the agent will proceed with its best judgment." });
        finish(NO_ANSWER);
      }, this.deps.store.settings.inputTimeoutMinutes * 60_000);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(task.id, { inputId, resolve: (answer) => finish(answer) });
    });
  }

  private emit(task: Task, event: NewTaskEvent): void {
    const full = this.deps.store.appendEvent(task, {
      ...event,
      stage: event.stage ?? task.currentStage,
      round: event.round ?? (task.currentRound || undefined),
    });
    this.deps.bus.publishTask(task.id, { type: "event", event: full });
  }

  /** Records a manager <-> agent message in the manager log and streams it to the Agents view. */
  private comm(task: Task, entry: NewCommEntry): void {
    if (!this.deps.store.getTask(task.id)) return;
    const full = this.deps.store.appendComm({
      ...entry,
      taskId: task.id,
      taskTitle: task.title,
      stage: entry.stage ?? task.currentStage,
      round: entry.round ?? (task.currentRound || undefined),
    });
    this.deps.bus.publishGlobal({ type: "comm", entry: full });
  }

  private publish(task: Task): void {
    const timer = this.updateTimers.get(task.id);
    if (timer) {
      clearTimeout(timer);
      this.updateTimers.delete(task.id);
    }
    if (!this.deps.store.getTask(task.id)) return;
    task.updatedAt = nowIso();
    this.deps.store.saveTask(task);
    this.deps.bus.publishGlobal({ type: "task", task: summarizeTask(task) });
    this.deps.bus.publishTask(task.id, { type: "task", task });
  }

  private scheduleUpdate(task: Task): void {
    if (this.updateTimers.has(task.id)) return;
    this.updateTimers.set(
      task.id,
      setTimeout(() => {
        this.updateTimers.delete(task.id);
        this.publish(task);
      }, 1000),
    );
  }

  private startMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(() => this.checkOnAgents(), this.deps.monitorIntervalMs ?? 60_000);
    this.monitorTimer.unref();
  }

  private stopMonitor(): void {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
  }

  /**
   * The manager's periodic check on working agents. Silence is measured from each agent's last sign of
   * life (any session event or a new turn): after a while it posts a check-in, and once the agent counts
   * as stuck (Settings: stuckAgentMinutes) it has the engine recover it - interrupt the turn and let the
   * agent continue, or kill the session and restart the agent with its full assignment.
   */
  checkOnAgents(now = Date.now()): void {
    this.lastCheckAt = new Date(now).toISOString();
    const stallAfter = this.deps.stallAfterMs ?? 5 * 60_000;
    const stuckMinutes = this.deps.store.settings.stuckAgentMinutes;
    for (const [id, entry] of this.running) {
      const task = this.deps.store.getTask(id);
      if (!task || task.status !== "running") continue;
      for (const agent of task.agents ?? []) {
        if (agent.status !== "working" || !agent.updatedAt) continue;
        const silentMs = now - Date.parse(agent.updatedAt);
        const minutes = Math.round(silentMs / 60_000);
        const last = agent.lastActivity ? ` (last: ${truncate(agent.lastActivity, 80)})` : "";
        const key = `${task.id}:${agent.role}:${agent.updatedAt}`;
        if (silentMs >= stuckMinutes * 60_000) {
          if (!this.checkIns.has(`${key}:stuck`) && entry.engine?.recover(agent.role, `no activity for ${minutes} min${last}`)) {
            this.checkIns.add(`${key}:stuck`);
          }
          continue;
        }
        if (silentMs < stallAfter || this.checkIns.has(key)) continue;
        this.checkIns.add(key);
        this.comm(task, {
          from: "manager",
          to: agent.role,
          kind: "monitor",
          text: `Check-in: no new activity for ${minutes} min${last}; the manager recovers agents that stay silent for ${stuckMinutes} min`,
        });
      }
    }
    if (this.checkIns.size > 1000) this.checkIns.clear();
    this.deps.bus.publishGlobal({ type: "manager", lastCheckAt: this.lastCheckAt });
  }
}

function clampInt(value: unknown, min: number, max: number): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function completionText(task: Task): string {
  const result = task.result;
  const testsLast = stageKindsOf(task).at(-1) === "testing";
  if (result?.approved) return testsLast ? "Completed: all tests pass (verified by the test executor)" : "Completed: approved by the reviewer";
  return testsLast
    ? `Completed with failing tests (${result?.openComments ?? 0} failure(s) remain)`
    : `Completed without approval (${result?.openComments ?? 0} open comment(s))`;
}

function prName(pullRequest: PullRequestInfo): string {
  return pullRequest.number ? `#${pullRequest.number}` : pullRequest.url;
}

/** The branch a pull request targets: the branch the task started from, or the repository's default branch. */
export function pullRequestBase(task: Pick<Task, "baseRef">, repo: Pick<Repo, "defaultBranch">): string {
  const ref = (task.baseRef ?? "").trim().replace(/^refs\/heads\//, "");
  if (ref && ref !== "HEAD" && !SHA.test(ref)) return ref;
  return repo.defaultBranch && repo.defaultBranch !== "HEAD" ? repo.defaultBranch : "main";
}

/** Pull request description: the outcome, the request, the plan, tests and the agents that worked on it. */
export function pullRequestBody(task: Task): string {
  const result = task.result;
  const lines: string[] = [];
  if (result?.summary.trim()) lines.push(result.summary.trim(), "");
  lines.push("---", "", "**Request**", "", ...truncate(task.description.trim(), 1500).split(/\r?\n/).map((line) => `> ${line}`), "");
  if (task.plan) {
    lines.push(`**Manager's plan:** ${task.plan.stages.map((stage) => STAGE_TITLES[stage]).join(" → ")} — ${task.plan.rationale}`, "");
  }
  if (result) {
    const testsLast = stageKindsOf(task).at(-1) === "testing";
    lines.push(
      `**Outcome:** ${
        result.approved
          ? testsLast
            ? "all tests pass (verified by the test executor)"
            : "approved by the reviewer"
          : `not approved — ${result.openComments} open ${testsLast ? "failure" : "comment"}(s)`
      }${result.shortStat ? ` · ${result.shortStat}` : ""}`,
    );
    if (result.tests) {
      const counts = result.tests.total !== undefined ? ` (${result.tests.passed ?? "?"}/${result.tests.total} passed)` : "";
      const commands = result.tests.commands.length ? ` · ${result.tests.commands.slice(0, 3).map((command) => `\`${command}\``).join(", ")}` : "";
      lines.push(`**Tests:** ${result.tests.status}${counts}${commands}`);
    }
  }
  const agents = (task.agents ?? []).filter((agent) => agent.turns > 0);
  if (agents.length) lines.push(`**Agents:** ${agents.map((agent) => `${ROLE_LABELS[agent.role]} (${agent.model})`).join(", ")}`);
  lines.push("", `_Created with Copilot Agent Hub — task ${task.id}._`);
  return lines.join("\n");
}

const STAGE_TITLES: Record<StageKind, string> = { design: "Design", coding: "Coding", testing: "Execute & verify", document: "Document" };

const CHANGED_ARTIFACT: Record<StageKind, string> = { design: "design document", coding: "code", testing: "code and tests", document: "document" };

/** What a later stage is asked to do after an earlier stage changed for a change request. */
function cascadeRequest(changed: StageKind, stage: StageKind, id: string, request: string): string {
  const action =
    stage === "coding"
      ? "Bring the implementation (and its tests) in line with it"
      : stage === "design"
        ? "Update the design document to match"
        : "Update the document to match";
  const quoted = truncate(request, 4000)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `The ${CHANGED_ARTIFACT[changed]} changed in the ${STAGE_TITLES[changed]} stage for the user's change request ${id} (quoted below). ${action}; decline with the reason if nothing here needs to change.\n\n${quoted}`;
}
