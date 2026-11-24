import fs from "node:fs";
import path from "node:path";
import type { AgentDriver, AgentObserver, UserQuestion } from "../agents/driver.ts";
import type { Bus } from "../bus.ts";
import { describeContext, discoverContext, type HubSkills } from "../context.ts";
import { formatOfPath, type DocTemplates } from "../docs.ts";
import { branchWebUrl, primaryRemote, pullRequestPageUrl, pushBranch, remoteBranchHead, sanitizeRemoteUrl, type PullRequestCreator } from "../remote.ts";
import { nextFinalNumber } from "../review/discussion.ts";
import { commentableLines, pendingChanges, publishReview, REVIEW_EVENTS, reviewMarkdown, type ReviewPublisher } from "../review/publish.ts";
import { defaultBranchOf, resolveReviewTarget, type PullRequestLookup, type ResolvedReviewTarget } from "../review/target.ts";
import type { CommandRunner } from "../shell.ts";
import {
  deleteBranch,
  deleteBranchesWithPrefix,
  diffBetween,
  diffStatBetween,
  git,
  GitTaskWorkspace,
  inspectRepo,
  isValidBranchName,
  resolveCommit,
  uniqueBranchName,
} from "../git.ts";
import type { Store } from "../store.ts";
import {
  ACTIVE_STATUSES,
  isCodeReview,
  isDocStage,
  MAX_PARALLEL_TASKS,
  ROLE_LABELS,
  SEVERITIES,
  stageKindsOf,
  stagesFor,
  TASK_KINDS,
  type AgentInfo,
  type AgentRole,
  type ApprovedWork,
  type ChangeRequest,
  type CodeReview,
  type CommEntry,
  type CuratedComment,
  type DocFormat,
  type NewCommEntry,
  type NewTaskEvent,
  type PullRequestInfo,
  type PushInfo,
  type Repo,
  type ReviewEvent,
  type ReviewPullRequest,
  type Round,
  type Severity,
  type Stage,
  type StageKind,
  type Task,
  type TaskKind,
} from "../types.ts";
import { CancelledError, errorMessage, firstLine, HttpError, KeyedMutex, nowIso, randomId, slugify, truncate } from "../util.ts";
import { modelFor, reviewedChange, WorkflowEngine, type EngineHooks } from "./engine.ts";
import { applyChangePlan, pendingChangeRequests } from "./changes.ts";
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
  /** Code review tasks: model of the peer reviewer (the lead reviewer uses the reviewer model). */
  peerReviewerModel?: string;
  /** Code review tasks: the pull request (number or URL) or the branch, tag or commit to review. */
  reviewTarget?: string;
  maxRounds?: number;
  /** The to-do the task is created from (sent to the manager from the to-do list). */
  todoId?: string;
}

/** The subset of the Copilot service the runner depends on. */
export interface RuntimeGate {
  isReady(): boolean;
  deleteSessions(sessionIds: readonly string[]): Promise<void>;
}

/** Looks up pull requests to review and publishes code reviews on them (the GitHub CLI). */
export type ReviewHost = PullRequestLookup & ReviewPublisher;

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
  /** Code review tasks: pull request details and publishing; without it, reviews can only be copied as Markdown. */
  reviewHost?: ReviewHost;
  /** The hub's version and commit, recorded when a task starts (shows which code ran it). */
  hubBuild?: string;
  /** How often the manager checks on working agents (default 60 s). */
  monitorIntervalMs?: number;
  /** Silence after which the manager posts a check-in about a working agent (default 5 min). */
  stallAfterMs?: number;
  /** Runs the coding agents' unit test commands when the manager verifies them (default: the real shell). */
  runCommand?: CommandRunner;
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
/** Focus of a code review task when the user gives none. */
const DEFAULT_REVIEW_FOCUS =
  "Review the change for correctness, security, error handling, performance, tests and maintainability, and give the author actionable comments.";
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
  review: "Code review",
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
  /** Code review tasks whose review is being published right now. */
  private readonly publishing = new Set<string>();
  private readonly anchorCache = new Map<string, Map<string, Set<number>>>();
  /** One question to the user at a time per task (code review reviewers work in parallel). */
  private readonly askLocks = new KeyedMutex();
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

  /**
   * The task is being worked on: queued, running, waiting for an answer, publishing its review or pushing its branch.
   * Its record must not be swapped (Data sync).
   */
  isBusy(id: string): boolean {
    const task = this.deps.store.getTask(id);
    if (this.running.has(id) || this.publishing.has(id)) return true;
    return Boolean(task && (ACTIVE_STATUSES.includes(task.status) || task.push?.status === "pushing"));
  }

  /** The task's record was replaced by one loaded from a data branch: it does not resume automatically after the restart. */
  forgetResume(id: string): void {
    this.resumeQueue.delete(id);
  }

  async submit(input: SubmitTaskInput): Promise<Task> {
    const { store } = this.deps;
    const isReview = input.kind === "review";
    const description = (typeof input.description === "string" ? input.description.trim() : "") || (isReview ? DEFAULT_REVIEW_FOCUS : "");
    if (!description) throw new HttpError(400, "A task description is required");
    if (!TASK_KINDS.includes(input.kind)) throw new HttpError(400, `Task type must be one of: ${TASK_KINDS.join(", ")}`);
    const repo = store.getRepo(String(input.repoId ?? ""));
    if (!repo) throw new HttpError(400, "Select a registered repository");

    const settings = store.settings;
    let authorModel = (input.authorModel || settings.authorModel || "").trim();
    const reviewerModel = (input.reviewerModel || settings.reviewerModel || authorModel).trim();
    const resolverModel = (input.resolverModel || settings.resolverModel || authorModel).trim();
    const managerModel = input.kind === "auto" ? (input.managerModel || settings.managerModel || authorModel).trim() : undefined;
    const peerReviewerModel =
      isReview || input.kind === "auto" ? (input.peerReviewerModel || settings.peerReviewerModel || authorModel || reviewerModel).trim() : undefined;
    if (isReview) {
      if (!reviewerModel || !peerReviewerModel) throw new HttpError(400, "Choose the lead and peer reviewer models first");
      authorModel ||= peerReviewerModel;
    } else if (!authorModel || !reviewerModel) {
      throw new HttpError(400, "Choose the author and reviewer models first (Settings)");
    }
    const maxRounds = clampInt(input.maxRounds ?? settings.maxRounds, 1, 10);

    let baseRef: string;
    let baseSha: string;
    let review: CodeReview | undefined;
    let suggestedTitle: string | undefined;
    try {
      const info = await inspectRepo(repo.path);
      if (isReview) {
        const target = (input.reviewTarget ?? "").trim();
        if (!target) throw new Error("Enter the pull request (number or URL) or the branch to review");
        const resolved = await resolveReviewTarget(repo.path, target, {
          baseRef: input.baseRef?.trim() || undefined,
          defaultBranch: await defaultBranchOf(repo.path, repo.defaultBranch),
          lookup: this.deps.reviewHost,
        });
        review = { target: resolved.target, rounds: [], comments: [] };
        baseRef = resolved.target.baseRef;
        baseSha = resolved.baseSha;
        suggestedTitle = resolved.title;
      } else {
        baseRef = input.baseRef?.trim() || info.branch || repo.defaultBranch;
        baseSha = await resolveCommit(repo.path, baseRef);
      }
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }

    const now = nowIso();
    const title = truncate((input.title ?? "").trim() || suggestedTitle || firstLine(description), 100);
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
      peerReviewerModel,
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
      ...(review ? { review } : {}),
      ...(input.todoId ? { todoId: input.todoId } : {}),
    };
    if (review) {
      // The reviewed head gets a branch right away, so the fetched commits stay referenced while the task waits.
      const headSha = review.target.headSha;
      try {
        await this.repoLocks.run(repo.path, async () => {
          const branch = await uniqueBranchName(repo.path, await this.taskBranchBase(task, repo));
          await git(repo.path, ["branch", branch, headSha]);
          task.branch = branch;
        });
      } catch (error) {
        throw new HttpError(500, `Could not create a branch for the reviewed change: ${errorMessage(error)}`);
      }
    }
    store.addTask(task);
    const where = review
      ? `${review.target.pullRequest ? `pull request #${review.target.pullRequest.number}` : review.target.headRef} (${review.target.headSha.slice(0, 10)}) against ${baseRef}`
      : `${repo.name} @ ${baseRef} (${baseSha.slice(0, 10)})`;
    const fromTodo = input.todoId ? ` (from to-do ${input.todoId})` : "";
    this.emit(task, { type: "status", text: `Queued ${KIND_LABELS[task.kind]} task ${review ? `of ${where} on ${repo.name}` : `on ${where}`}${fromTodo}` });
    this.comm(task, {
      from: "user",
      to: "manager",
      kind: "lifecycle",
      text: review
        ? `New code review of ${where} on ${repo.name}${fromTodo}`
        : `New ${KIND_LABELS[task.kind]} task on ${repo.name} @ ${baseRef}${fromTodo}: ${truncate(firstLine(description), 140)}`,
    });
    this.publish(task);
    this.pump();
    return task;
  }

  /** agent-hub/<id>-<title> (or agent-hub/<id> when the title does not make a valid branch name). */
  private async taskBranchBase(task: Task, repo: Repo): Promise<string> {
    const base = `agent-hub/${task.id.toLowerCase()}-${slugify(task.title, 32)}`;
    return (await isValidBranchName(repo.path, base)) ? base : `agent-hub/${task.id.toLowerCase()}`;
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
    if (isCodeReview(task) && task.status === "completed") {
      throw new HttpError(409, "This code review is finished: keep, drop or edit its comments and publish them, request changes to it, or start a new review");
    }
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
   * Asks for further changes to a task in any state but running: finished (approved or not), failed, cancelled,
   * interrupted or still queued. The request becomes U<n>. By default the manager re-evaluates the task for it when the
   * task next runs: which teams handle it - the stage that revises its work, new stages (e.g. coding for a finished
   * design), stages the request makes unnecessary - and the task type follows. With `stage`, the user hands it to that
   * stage directly: its author (the comment resolver for code, the test fixer for tests) makes the change and its
   * reviewer (or the test executor) verifies it, round by round; later stages then bring their work in line. A code
   * review's request goes to its reviewers: the lead reviewer revises the review for it, the peer reviewer checks the
   * revision (`rounds`: final-review rounds).
   */
  requestChanges(id: string, input: { request: string; stage?: string; rounds?: number }): Task {
    const task = this.get(id);
    if (this.running.has(id) || task.status === "running" || task.status === "needs-input") {
      throw new HttpError(409, "The task is running: cancel it or let it finish, then request the changes");
    }
    const text = (input.request ?? "").trim();
    if (!text) throw new HttpError(400, "Describe the changes you want");
    if (text.length > 20_000) throw new HttpError(400, "The change request is too long (max 20,000 characters)");
    const review = isCodeReview(task);
    if (review && input.stage) throw new HttpError(400, "A code review has no stages: its reviewers revise the review for the request");
    if (review && this.publishing.has(id)) throw new HttpError(409, "The review is being published; request the changes once publishing has finished");
    const kinds = stageKindsOf(task);
    const target = (review ? undefined : input.stage || undefined) as StageKind | undefined;
    if (target && !kinds.includes(target)) {
      throw new HttpError(400, kinds.length ? `Stage must be one of: ${kinds.join(", ")}` : "This task has no stages yet: leave the request to the manager");
    }
    const pending = pendingChangeRequests(task);
    if (target && pending.length) {
      throw new HttpError(409, `The manager has yet to re-plan the task for ${pending.map((request) => request.id).join(", ")}: leave this request to the manager too`);
    }
    const rounds = input.rounds ?? task.maxRounds;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new HttpError(400, "Rounds must be an integer between 1 and 10");

    const requestId = `U${(task.changeRequests?.length ?? 0) + 1}`;
    const from = task.status;
    const failure = task.status === "failed" ? truncate(task.error ?? "", 1000) : undefined;
    this.resumeQueue.delete(id);
    task.autoResumes = 0;
    // A queued task has not started: it takes the request when it does.
    if (task.status === "queued") task.roundsBudget = clampInt(rounds, 1, 10);
    else this.requeue(task, rounds, `Change request ${requestId}`);
    const now = nowIso();
    const request: ChangeRequest = {
      id: requestId,
      text,
      attempt: task.attempt,
      rounds: task.roundsBudget ?? rounds,
      requestedAt: now,
      routing: review ? "reviewers" : target ? "user" : "manager",
      from,
      ...(failure ? { failure } : {}),
    };
    (task.changeRequests ??= []).push(request);
    if (review) {
      const finished = Boolean(task.review?.curated);
      this.emit(task, {
        type: "info",
        text: `Change request ${requestId} from the user: ${truncate(text, 2000)}. ${
          finished
            ? "The lead reviewer revises the review for it and the peer reviewer checks the revision; your decisions on the comments stay unless the request changes them."
            : "The reviewers take it into account as they finish the review."
        }`,
        data: { changeRequest: requestId },
      });
      this.comm(task, {
        from: "user",
        to: "manager",
        kind: "lifecycle",
        text: `Change request ${requestId} for the review: ${truncate(firstLine(text), 160)} - ${finished ? "the reviewers revise the review for it" : "the reviewers take it into account"}`,
      });
    } else if (target) {
      const applied = applyChangePlan(task, [request], { stages: kinds, changeStage: target, instructions: {}, rationale: "", routing: "user" }, now);
      this.emit(task, {
        type: "info",
        stage: target,
        round: applied.round,
        text: `Change request ${requestId} from the user (${STAGE_TITLES[target]} stage): ${truncate(text, 2000)}`,
        data: { changeRequest: requestId },
      });
      this.comm(task, { from: "user", to: "manager", kind: "lifecycle", stage: target, round: applied.round, text: `Change request ${requestId} for the ${STAGE_TITLES[target]} stage: ${truncate(firstLine(text), 160)}` });
      if (applied.later.length) {
        this.comm(task, {
          from: "manager",
          to: "manager",
          kind: "lifecycle",
          text: `After ${requestId}: ${applied.later.map((kind) => (kind === "testing" ? "re-run the tests" : `update the ${STAGE_TITLES[kind]} stage to match`)).join(", then ")}`,
        });
      }
    } else {
      request.pending = true;
      // The manager's planner re-plans with the manager model (the author model unless one is set).
      task.managerModel ??= this.deps.store.settings.managerModel || task.authorModel;
      this.emit(task, {
        type: "info",
        text: `Change request ${requestId} from the user: ${truncate(text, 2000)}. The manager re-evaluates the task for it before the agents continue.`,
        data: { changeRequest: requestId },
      });
      this.comm(task, { from: "user", to: "manager", kind: "lifecycle", text: `Change request ${requestId}: ${truncate(firstLine(text), 160)} - the manager re-evaluates the task for it` });
    }
    this.publish(task);
    this.pump();
    return task;
  }

  private requeue(task: Task, rounds: number, verb: string): void {
    // Change requests the stopped (or unapproved) attempt was working on are still what the next attempt works on;
    // those of an attempt that finished are done (a finished code review handled its requests, agreed or not).
    const unfinished = task.status !== "completed" || (task.result?.approved === false && !isCodeReview(task));
    const previous = task.attempt;
    task.attempt += 1;
    if (unfinished) {
      for (const request of task.changeRequests ?? []) if (request.attempt === previous) request.attempt = task.attempt;
    }
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
    this.resumeQueue.delete(id);
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

  /**
   * A document of the task's design/document stages as of a round (default: its latest version): the stage's
   * deliverable, or with `docPath` any further document the stage's author wrote.
   */
  async document(
    id: string,
    round?: number,
    docPath?: string,
  ): Promise<{ stage: StageKind; path: string | null; format: DocFormat; round: number | null; rounds: number[]; content: string | null }> {
    const task = this.get(id);
    const docStages = task.stages.filter((candidate) => isDocStage(candidate.kind));
    if (!docStages.length) throw new HttpError(404, "This task has no design or document stage");
    const snapshotIn = (stage: Stage, candidate: Round, file: string | undefined): string | undefined =>
      candidate.author?.documents?.find((document) => document.path === file)?.snapshot ??
      (file === stage.docPath ? candidate.author?.docSnapshot : undefined);
    let stage = docStages[0]!;
    let file = stage.docPath;
    if (docPath) {
      const found = docStages.find(
        (candidate) => candidate.docPath === docPath || candidate.extraDocs?.includes(docPath) || candidate.rounds.some((entry) => snapshotIn(candidate, entry, docPath)),
      );
      if (!found) throw new HttpError(404, `This task wrote no document ${docPath}`);
      stage = found;
      file = docPath;
    }
    const format = file === stage.docPath ? (stage.docFormat ?? (file ? formatOfPath(file) : "markdown")) : formatOfPath(file!);
    const rounds = stage.rounds.filter((candidate) => snapshotIn(stage, candidate, file));
    const target = round ? rounds.find((candidate) => candidate.n === round) : rounds.at(-1);
    const base = { stage: stage.kind, path: file ?? null, format, rounds: rounds.map((candidate) => candidate.n) };
    const snapshot = target ? snapshotIn(stage, target, file) : undefined;
    if (!target || !snapshot) return { ...base, round: null, content: null };
    const content = await this.deps.store.readArtifact(task.id, snapshot);
    return { ...base, round: target.n, content };
  }

  /**
   * Pushes the task's work now (e.g. after a failed automatic push, or with automatic pushes turned off). With `rewind`,
   * the approved work of a task that did not finish may move the remote branch back from later, unapproved work of
   * this task pushed earlier; without it, such a push fails and says so.
   */
  async pushNow(id: string, options: { rewind?: boolean } = {}): Promise<Task> {
    const task = this.get(id);
    if (isCodeReview(task)) throw new HttpError(409, "Code review tasks review an existing change; they have no branch of their own to push");
    if (this.running.has(id) || ACTIVE_STATUSES.includes(task.status)) throw new HttpError(409, "Wait until the task has finished before pushing its branch");
    if (task.push?.status === "pushing") throw new HttpError(409, "The branch is being pushed right now");
    await this.pushTask(task, false, { rewind: options.rewind === true });
    return task;
  }

  /**
   * Opens a pull request for the task branch: pushes the task's work first (its head once completed; otherwise its
   * latest approved work), then creates the pull request directly when a creator (the GitHub CLI) can, otherwise
   * returns the host's prefilled create page.
   */
  async pullRequest(id: string): Promise<PullRequestOutcome> {
    const task = this.get(id);
    if (isCodeReview(task)) throw new HttpError(409, "Code review tasks review an existing change; publish the review's comments instead");
    if (this.running.has(id) || ACTIVE_STATUSES.includes(task.status)) throw new HttpError(409, "Wait until the task has finished before opening a pull request");
    if (task.pullRequest) return { pullRequest: task.pullRequest, message: `Pull request ${prName(task.pullRequest)} already exists` };
    const repo = this.deps.store.getRepo(task.repoId);
    if (!repo || !task.branch || !task.baseSha) throw new HttpError(409, "This task has no branch to open a pull request for");
    const remote = await primaryRemote(repo.path);
    if (!remote) throw new HttpError(409, "No git remote is configured for this repository, so there is nowhere to open a pull request");
    const deliverable = await this.deliverable(task, repo);
    if (!deliverable) throw new HttpError(409, "The task did not finish and none of its work was approved yet: retry it or request changes, then open the pull request");
    // Approved work is checked against the remote itself (it may have been pushed there by hand since); a pull request
    // never rewinds the remote branch - when it holds later work, the push fails and says how to rewind it.
    const delivered = deliverable.approved
      ? (await remoteBranchHead(repo.path, remote.name, task.branch)) === deliverable.sha
      : task.push?.status === "pushed" && task.push.sha === deliverable.sha;
    if (!delivered) {
      const push = await this.pushTask(task, false, { reuseCurrent: !deliverable.approved });
      if (push.status !== "pushed") throw new HttpError(409, `The branch could not be pushed: ${push.reason ?? push.status}`);
    }
    const request = {
      head: task.branch,
      base: pullRequestBase(task, repo),
      title: task.title,
      body: pullRequestBody(task, deliverable.approved),
      // Anything short of an approved, completed task opens as a draft: the user validates it first.
      draft: task.status !== "completed" || !task.result?.approved,
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

  /** What the UI's pull request button can do for this task, and which commit a push or pull request delivers. */
  async pullRequestStatus(id: string): Promise<{
    remote: { name: string; url: string; provider: string; host?: string } | null;
    /** True when the pull request can be created directly (GitHub CLI signed in); otherwise the host's page opens. */
    direct: boolean;
    supported: boolean;
    pullRequest?: PullRequestInfo;
    /**
     * The branch head of a completed task, or the latest approved work of one that did not finish; null when there is
     * none. `remoteAhead` (approved work): the remote branch is beyond it - "later": later, unapproved work of this task
     * pushed earlier (pushing the approved work rewinds it, when asked to); "foreign": commits the local task branch
     * does not have (never replaced).
     */
    deliverable: { sha: string; approved?: ApprovedWork; remoteAhead?: RemoteAhead } | null;
  }> {
    const task = this.get(id);
    const repo = this.deps.store.getRepo(task.repoId);
    const deliverable: { sha: string; approved?: ApprovedWork; remoteAhead?: RemoteAhead } | null =
      repo && task.branch && !ACTIVE_STATUSES.includes(task.status) && !isCodeReview(task) && fs.existsSync(repo.path)
        ? await this.deliverable(task, repo).catch(() => null)
        : null;
    const remote = repo ? await primaryRemote(repo.path) : null;
    if (!remote) return { remote: null, direct: false, supported: false, pullRequest: task.pullRequest, deliverable };
    // Where the remote branch really stands (it may have been pushed by hand), the same check a push makes.
    if (repo && task.branch && deliverable?.approved) {
      const ahead = await remoteAhead(repo.path, remote.name, task.branch, deliverable.sha, 20_000).catch(() => null);
      if (ahead) deliverable.remoteAhead = ahead;
    }
    const direct = Boolean(this.deps.pullRequests && (await this.deps.pullRequests.canCreate(remote)));
    return {
      remote: { name: remote.name, url: remote.url, provider: remote.provider, host: remote.host },
      direct,
      supported: direct || remote.webUrl !== null,
      pullRequest: task.pullRequest,
      deliverable,
    };
  }

  // ---- Code review tasks: curating and publishing the final review ---------------------------------

  /**
   * A review the reviewers finished: the user's to curate and publish - also when a change request to it failed or was
   * cancelled (the review stays as it was), but not while the reviewers revise it.
   */
  private finishedReview(id: string): { task: Task; review: CodeReview; curated: CuratedComment[] } {
    const task = this.get(id);
    if (!task.review) throw new HttpError(404, "This task is not a code review");
    if (!task.review.curated) throw new HttpError(409, "The reviewers have not finished the review yet");
    if (this.running.has(id) || ACTIVE_STATUSES.includes(task.status)) {
      throw new HttpError(409, "The reviewers are revising the review for your change request; edit and publish it once they have finished");
    }
    return { task, review: task.review, curated: task.review.curated };
  }

  private editableReview(id: string): { task: Task; review: CodeReview; curated: CuratedComment[] } {
    if (this.publishing.has(id)) throw new HttpError(409, "The review is being published; edit it once publishing has finished");
    return this.finishedReview(id);
  }

  /** Keeps, drops or edits a comment of the final review before it is published (published comments are updated on the next publish). */
  updateReviewComment(id: string, commentId: string, patch: { decision?: unknown; body?: unknown; severity?: unknown; revert?: unknown }): Task {
    const { task, curated } = this.editableReview(id);
    const comment = curated.find((candidate) => candidate.id === commentId.toUpperCase());
    if (!comment) throw new HttpError(404, `The review has no comment ${commentId}`);
    if (patch.decision !== undefined) {
      if (patch.decision !== "keep" && patch.decision !== "drop") throw new HttpError(400, "'decision' must be keep or drop");
      comment.decision = patch.decision;
    }
    if (patch.revert === true && comment.original) {
      comment.body = comment.original.body;
      comment.severity = comment.original.severity;
      comment.original = undefined;
    }
    if (patch.body !== undefined || patch.severity !== undefined) {
      if (patch.body !== undefined && typeof patch.body !== "string") throw new HttpError(400, "'body' must be a string");
      const body = patch.body === undefined ? comment.body : (patch.body as string).trim();
      if (!body) throw new HttpError(400, "A comment needs text; drop it instead");
      if (body.length > 20_000) throw new HttpError(400, "The comment is too long (max 20,000 characters)");
      const severity = (patch.severity === undefined ? comment.severity : patch.severity) as Severity;
      if (!SEVERITIES.includes(severity)) throw new HttpError(400, `'severity' must be one of: ${SEVERITIES.join(", ")}`);
      if (body !== comment.body || severity !== comment.severity) {
        comment.original ??= { body: comment.body, severity: comment.severity };
        comment.body = body;
        comment.severity = severity;
        if (comment.original.body === body && comment.original.severity === severity) comment.original = undefined;
      }
    }
    this.publish(task);
    return task;
  }

  /** Puts a reviewer comment the final review dropped (or the peer reviewer said was missing) back into the review. */
  addReviewComment(id: string, sourceId: string): Task {
    const { task, review, curated } = this.editableReview(id);
    const source = review.comments.find((candidate) => candidate.id === sourceId.trim().toUpperCase());
    if (!source) throw new HttpError(404, `The reviewers raised no comment ${sourceId}`);
    if (curated.some((comment) => comment.sources.includes(source.id) && comment.decision === "keep")) {
      throw new HttpError(409, `${source.id} is already part of a kept comment`);
    }
    // A new ID: none the review had (including comments a revision removed, still shown in the discussion).
    const used = [...curated.map((comment) => comment.id), ...review.rounds.flatMap((round) => round.entries.flatMap((entry) => entry.final?.comments.map((comment) => comment.id) ?? []))];
    curated.push({ id: `R${nextFinalNumber(used)}`, severity: source.severity, file: source.file, line: source.line, body: source.body, sources: [source.id], decision: "keep", addedByUser: true });
    this.publish(task);
    return task;
  }

  /** Sets the text published with the comments and, before the first publication, the kind of review. */
  updateReviewSummary(id: string, patch: { body?: unknown; event?: unknown }): Task {
    const { task, review } = this.editableReview(id);
    if (patch.body !== undefined) {
      if (typeof patch.body !== "string") throw new HttpError(400, "'body' must be a string");
      if (patch.body.length > 60_000) throw new HttpError(400, "The review text is too long (max 60,000 characters)");
      review.body = patch.body.trim();
    }
    if (patch.event !== undefined) {
      if (!REVIEW_EVENTS.includes(patch.event as ReviewEvent)) throw new HttpError(400, `'event' must be one of: ${REVIEW_EVENTS.join(", ")}`);
      const main = review.publications?.find((publication) => publication.main);
      if (main && main.event !== patch.event) throw new HttpError(409, "The review was already published; its kind cannot change any more");
      review.event = patch.event as ReviewEvent;
    }
    this.publish(task);
    return task;
  }

  /** Whether the review can be published on its pull request right now, and what publishing would change. */
  async reviewPublishStatus(id: string): Promise<{
    pullRequest: ReviewPullRequest | null;
    available: boolean;
    reason: string | null;
    /** Changes the pull request does not show yet (null before the first publication). */
    pending: number | null;
    inline: number;
    inBody: number;
  }> {
    const { task, review, curated } = this.finishedReview(id);
    const pr = review.target.pullRequest ?? null;
    let reason: string | null = null;
    if (!pr) {
      reason =
        review.target.kind === "ref"
          ? "This review is of a branch with no open GitHub pull request, so there is nowhere to publish it; copy it as Markdown instead."
          : "The pull request is unknown.";
    } else if (!this.deps.reviewHost) {
      reason = "Publishing is not available in this hub; copy the review as Markdown instead.";
    } else {
      reason = await this.deps.reviewHost.unavailable(pr);
    }
    const anchors = await this.reviewAnchors(task);
    const kept = curated.filter((comment) => comment.decision === "keep");
    const inline = kept.filter((comment) => (comment.published ? comment.published.inline : Boolean(comment.file && comment.line && anchors.get(comment.file)?.has(comment.line)))).length;
    return { pullRequest: pr, available: reason === null, reason, pending: pendingChanges(review, anchors), inline, inBody: kept.length - inline };
  }

  /** Publishes the curated review on the pull request, or updates what an earlier publish put there. */
  async publishReviewComments(id: string): Promise<{ task: Task; ok: boolean; message: string }> {
    const { task, review } = this.editableReview(id);
    const pr = review.target.pullRequest;
    if (!pr) throw new HttpError(409, "This review has no pull request to publish to; copy it as Markdown instead");
    const host = this.deps.reviewHost;
    if (!host) throw new HttpError(409, "Publishing is not available in this hub; copy the review as Markdown instead");
    const problem = await host.unavailable(pr);
    if (problem) throw new HttpError(409, problem);
    if (this.publishing.has(id)) throw new HttpError(409, "The review is being published already");
    this.publishing.add(id);
    try {
      const anchors = await this.reviewAnchors(task);
      const outcome = await publishReview(review, pr, host, anchors, review.target.headSha);
      this.emit(task, { type: outcome.ok ? "info" : "warning", text: outcome.message, data: { publish: true, url: review.publications?.find((publication) => publication.main)?.url } });
      this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: truncate(outcome.message, 300) });
      this.publish(task);
      return { task, ok: outcome.ok, message: outcome.message };
    } finally {
      this.publishing.delete(id);
    }
  }

  /** The curated review as Markdown, to paste on hosts the hub cannot publish to. */
  reviewAsMarkdown(id: string): { markdown: string } {
    const { task, review } = this.finishedReview(id);
    return { markdown: reviewMarkdown(task.title, review) };
  }

  /** Lines of the reviewed change that pull request comments can be attached to (cached per task and head). */
  private async reviewAnchors(task: Task): Promise<Map<string, Set<number>>> {
    const review = task.review!;
    const key = `${task.id}:${task.baseSha}:${review.target.headSha}`;
    const cached = this.anchorCache.get(key);
    if (cached) return cached;
    const repo = this.deps.store.getRepo(task.repoId);
    if (!repo || !task.baseSha) return new Map();
    const diff = await diffBetween(repo.path, task.baseSha, review.target.headSha, 256 * 1024 * 1024);
    const anchors = commentableLines(diff.text);
    if (this.anchorCache.size > 50) this.anchorCache.clear();
    this.anchorCache.set(key, anchors);
    return anchors;
  }

  /**
   * Pushes the task's work to the repository's remote; never throws (the outcome is recorded on the task). A completed
   * task pushes its branch head; a task that did not finish pushes only its latest approved work (to the same branch).
   * - `sha`: the head the task completed with, for automatic pushes (the task may run again before the push's turn).
   * - `rewind`: the user asked to move the remote branch back to the approved work from later, unapproved work of this
   *   task pushed earlier. Without it such a push fails and says so; automatic pushes never rewind.
   * - `reuseCurrent`: a push that already sent that commit (e.g. an automatic push that finished while this call waited
   *   for the lock) is returned as is.
   */
  private async pushTask(task: Task, auto: boolean, options: { sha?: string; rewind?: boolean; reuseCurrent?: boolean } = {}): Promise<PushInfo> {
    const repo = this.deps.store.getRepo(task.repoId);
    const branch = task.branch;
    const record = (info: PushInfo): PushInfo => {
      task.push = info;
      const where = info.remote ? `${info.remote}/${info.branch}` : info.branch;
      const approved = info.approved ? `the approved work (${STAGE_TITLES[info.approved.stage]}, round ${info.approved.round})` : "";
      if (info.status === "pushed") {
        this.emit(task, {
          type: "info",
          text: `Pushed ${approved ? `${approved} of ` : ""}${info.branch} to ${info.remote} (${info.sha?.slice(0, 10)})${info.note ? `: ${info.note}` : ""}`,
          data: { push: info },
        });
        this.comm(task, { from: "manager", to: "user", kind: "lifecycle", text: `Pushed ${approved || "the task branch"} to ${where} (${info.sha?.slice(0, 10)})` });
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
        const deliverable: { sha: string; approved?: ApprovedWork } | null = options.sha ? { sha: options.sha } : await this.deliverable(task, repo);
        if (!deliverable) {
          return record({ status: "skipped", branch, reason: "The task did not finish and none of its work was approved yet, so there is nothing to push", auto, at: nowIso() });
        }
        const { sha, approved } = deliverable;
        if (options.reuseCurrent && task.push?.status === "pushed" && task.push.sha === sha && task.push.remote === remote.name) return task.push;
        const target = { branch, remote: remote.name, remoteUrl: remote.url, sha, auto, ...(approved ? { approved } : {}) };
        if (sha === task.baseSha) {
          return record({ ...target, status: "skipped", reason: approved ? "The approved work makes no changes, so there is nothing to push" : "The task made no changes, so there is nothing to push", at: nowIso() });
        }
        task.push = { ...target, status: "pushing", at: nowIso() };
        this.publish(task);
        const webUrl = branchWebUrl(remote, branch) ?? undefined;
        try {
          await pushBranch(repo.path, remote.name, branch, { sha });
        } catch (error) {
          // The remote branch is beyond the approved work. Only this task's own later work (pushed earlier, e.g. when an
          // attempt completed unapproved) can be moved back from, and only when the user asks: that work stays on the
          // local task branch, and the task's next push brings it back. Others' commits are never replaced.
          const ahead = approved ? await remoteAhead(repo.path, remote.name, branch, sha) : null;
          if (!ahead) throw error;
          if (ahead.kind === "foreign") {
            throw new Error(
              `${remote.name}/${branch} has commits that are not on the local task branch (up to ${ahead.head.slice(0, 10)}); the hub does not replace them. Push the approved work (${sha.slice(0, 10)}) yourself, or remove those commits from the remote branch first.`,
            );
          }
          if (!options.rewind) {
            throw new Error(
              `${remote.name}/${branch} holds later work of this task that was not approved (up to ${ahead.head.slice(0, 10)}), pushed earlier. Rewind it to the approved work (${sha.slice(0, 10)}) to deliver only that; the later work stays on the local task branch.`,
            );
          }
          // The lease: the remote branch moves back only while it still holds what was just read.
          await pushBranch(repo.path, remote.name, branch, { sha, lease: ahead.head });
          return record({
            ...target,
            status: "pushed",
            webUrl,
            note: `rewound the branch from the later, unapproved work pushed earlier (up to ${ahead.head.slice(0, 10)}); that work stays on the local task branch`,
            at: nowIso(),
          });
        }
        return record({ ...target, status: "pushed", webUrl, at: nowIso() });
      } catch (error) {
        return record({
          status: "failed",
          branch,
          remote: task.push?.remote,
          remoteUrl: task.push?.remoteUrl,
          sha: task.push?.sha,
          ...(task.push?.approved ? { approved: task.push.approved } : {}),
          reason: truncate(errorMessage(error), 1000),
          auto,
          at: nowIso(),
        });
      }
    });
  }

  /**
   * What pushing the task delivers: the branch head once the task completed; otherwise only the latest work a reviewer
   * (or the test executor) approved - code or documents - that holds no unapproved work, so unreviewed work stays local.
   * Null when nothing was approved.
   */
  private async deliverable(task: Task, repo: Repo): Promise<{ sha: string; approved?: ApprovedWork } | null> {
    if (task.status === "completed") return { sha: await resolveCommit(repo.path, `refs/heads/${task.branch}`) };
    if (!task.baseSha || !task.branch) return null;
    const approved = latestApprovedWork(task, await branchCommits(repo.path, task.baseSha, task.branch));
    return approved ? { sha: approved.sha, approved } : null;
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
      this.emit(task, { type: "status", text: `Started (attempt ${task.attempt})${this.deps.hubBuild ? ` on hub ${this.deps.hubBuild}` : ""}` });
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
      // A code review reads the guidance of the reviewed change, as its reviewers' worktrees do.
      task.context = await discoverContext(repo.path, task.review?.target.headSha ?? task.baseSha!);
      this.emit(task, { type: "info", text: `Repository context: ${describeContext(task.context)}`, data: { context: true } });
      this.publish(task);
      const testRunsKey = `${repo.path}#tests`;
      const engine = new WorkflowEngine(task, {
        driver,
        workspace,
        settings: store.settings,
        hooks,
        hubSkills: this.deps.hubSkills,
        docTemplates: this.deps.docTemplates,
        runCommand: this.deps.runCommand,
        testRuns: { busy: () => this.repoLocks.busy(testRunsKey), run: (work) => this.repoLocks.run(testRunsKey, work) },
        codeReviews: {
          resolve: async (target, base) =>
            resolveReviewTarget(repo.path, target, { baseRef: base, defaultBranch: await defaultBranchOf(repo.path, repo.defaultBranch), lookup: this.deps.reviewHost }),
          adopt: (resolved) => this.adoptPlannedReview(task, repo, resolved),
        },
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
      // The head this attempt completed with: the task may run again before the push gets its turn.
      if (task.status === "completed" && store.settings.pushOnComplete && !isCodeReview(task) && !this.shuttingDown) {
        this.afterTask(this.pushTask(task, true, { sha: task.result?.headSha }));
      }
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

  /**
   * Turns an Auto task the manager planned as a code review into that review: the task branch points at the reviewed
   * head (the planner only read the repository, so the branch has nothing of its own), the base becomes the
   * merge-base and the repository context is that of the reviewed change. Returns the reviewers' workspace.
   */
  private async adoptPlannedReview(task: Task, repo: Repo, resolved: ResolvedReviewTarget): Promise<GitTaskWorkspace> {
    const { target, baseSha } = resolved;
    const context = await discoverContext(repo.path, target.headSha);
    await this.repoLocks.run(repo.path, async () => {
      const ref = `refs/heads/${task.branch}`;
      const current = await resolveCommit(repo.path, ref).catch(() => null);
      if (current && current !== task.baseSha && current !== target.headSha) {
        throw new Error(`The task branch ${task.branch} already has commits, so the task cannot become a code review; create a Code review task instead`);
      }
      await git(repo.path, ["update-ref", ref, target.headSha]);
    });
    task.review = { target, rounds: [], comments: [] };
    task.baseSha = baseSha;
    task.baseRef = target.baseRef;
    task.context = context;
    this.emit(task, {
      type: "info",
      text: `Reviewing ${reviewedChange(target)} (${target.headSha.slice(0, 10)}) against ${target.baseRef}: the task branch ${task.branch} now points at the reviewed head`,
    });
    this.emit(task, { type: "info", text: `Repository context of the reviewed change: ${describeContext(context)}`, data: { context: true } });
    this.comm(task, { from: "manager", to: "manager", kind: "lifecycle", text: `Fetched ${reviewedChange(target)} (${target.headSha.slice(0, 10)}) to review against ${target.baseRef}` });
    this.publish(task);
    return this.workspaceFor(task, repo);
  }

  private async prepareWorkspace(task: Task, repo: Repo): Promise<GitTaskWorkspace> {
    await this.repoLocks.run(repo.path, async () => {
      task.baseSha ??= await resolveCommit(repo.path, task.baseRef);
      task.branch ??= await uniqueBranchName(repo.path, await this.taskBranchBase(task, repo));
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
    const target = task.review?.target;
    await this.repoLocks.run(repo.path, () => workspace.ensureTaskBranch(target?.headSha));
    this.emit(task, {
      type: "info",
      text: target
        ? `Reviewing ${target.headSha.slice(0, 10)} (branch ${task.branch}) against ${target.baseRef}; each reviewer has its own read-only worktree under ${task.workspaceRoot}`
        : task.isolation === "worktree"
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

  /** Agents of one task ask one question at a time (the code review reviewers work in parallel). */
  private askUser(task: Task, role: AgentRole, question: UserQuestion, signal: AbortSignal): Promise<string> {
    return this.askLocks.run(task.id, () => this.askUserNow(task, role, question, signal));
  }

  private askUserNow(task: Task, role: AgentRole, question: UserQuestion, signal: AbortSignal): Promise<string> {
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
  if (isCodeReview(task)) {
    const comments = result?.openComments ?? 0;
    const agreement = result?.approved ? "both reviewers agree" : "the reviewers did not fully agree";
    // The change requests this run revised the finished review for.
    const revised = (task.changeRequests ?? []).filter((request) => request.attempt === task.attempt && request.review?.changes);
    if (revised.length) {
      const changes = revised[0]!.review!.changes!;
      const counts = [`${changes.added.length} added`, `${changes.revised.length} changed`, `${changes.removed.length} removed`].join(", ");
      return `Completed: revised the code review for ${revised.map((request) => request.id).join(", ")} (${counts}); ${comments} comment(s) to publish (${agreement})`;
    }
    return `Completed: code review ready with ${comments} comment(s) (${agreement}); review and publish them`;
  }
  const testsLast = (result?.outcomeStage ?? stageKindsOf(task).at(-1)) === "testing";
  if (result?.notRun?.length) {
    return `Completed without approval: the coding stage is not approved (${result.openComments} open comment(s)), so the tests did not run; continue the review loop to finish it`;
  }
  if (result?.testsUnverified) {
    return `Completed: the tests could not verify the change (${result.testsUnverified === "blocked" ? "blocked" : "environment failures"}); validate it yourself and open the pull request`;
  }
  if (result?.approved) return testsLast ? "Completed: all tests pass (verified by the test executor)" : "Completed: approved by the reviewer";
  return testsLast
    ? `Completed with failing tests (${result?.openComments ?? 0} failure(s) remain)`
    : `Completed without approval (${result?.openComments ?? 0} open comment(s))`;
}

function prName(pullRequest: PullRequestInfo): string {
  return pullRequest.number ? `#${pullRequest.number}` : pullRequest.url;
}

/**
 * The latest work a reviewer (or the test executor) approved - a design, a document, code, or code whose tests pass -
 * among the stages the task still has, that holds approved work only: every round's commit below it was approved in its
 * own stage (so a document approved on top of code its reviewer rejected does not count). `order` lists the task
 * branch's commits, its base first (the branch only moves forward); work that is not on it does not count. It is what
 * a task that did not finish delivers.
 */
export function latestApprovedWork(task: Pick<Task, "stages">, order: readonly string[]): ApprovedWork | null {
  const position = new Map(order.map((sha, index) => [sha, index] as const));
  const approvals: Array<ApprovedWork & { index: number; candidate: boolean }> = [];
  const commits: Array<{ stage: StageKind; index: number }> = [];
  for (const stage of task.stages) {
    for (const round of stage.rounds) {
      const commit = round.author?.commit ?? undefined;
      const committed = commit === undefined ? undefined : position.get(commit);
      if (committed !== undefined) commits.push({ stage: stage.kind, index: committed });
      const review = round.review;
      if (!review || review.by === "user" || review.verdict !== "approve") continue;
      const sha = review.reviewedSha ?? commit;
      const index = sha === undefined ? undefined : position.get(sha);
      // A dropped stage's approvals still vouch for its own commits, but it no longer delivers anything itself.
      if (sha !== undefined && index !== undefined) approvals.push({ sha, stage: stage.kind, round: round.n, at: review.at, index, candidate: stage.status !== "skipped" });
    }
  }
  const approvedUpTo = (limit: number) =>
    commits.every((commit) => commit.index > limit || approvals.some((approval) => approval.stage === commit.stage && approval.index >= commit.index && approval.index <= limit));
  let latest: (typeof approvals)[number] | null = null;
  for (const approval of approvals) {
    if (!approval.candidate || !approvedUpTo(approval.index)) continue;
    if (!latest || approval.index > latest.index || (approval.index === latest.index && approval.at > latest.at)) latest = approval;
  }
  return latest && { sha: latest.sha, stage: latest.stage, round: latest.round, at: latest.at };
}

/** The task branch's commits, base first, following first parents (the order the agents' work landed in). */
async function branchCommits(repoPath: string, baseSha: string, branch: string): Promise<string[]> {
  const list = await git(repoPath, ["rev-list", "--first-parent", "--reverse", `${baseSha}..refs/heads/${branch}`], { allowFailure: true });
  if (list.code !== 0) return [];
  return [baseSha, ...list.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)];
}

/** `ancestor` is `commit` or one of its ancestors (false when either is unknown here). */
async function isAncestor(repoPath: string, ancestor: string, commit: string): Promise<boolean> {
  return (await git(repoPath, ["merge-base", "--is-ancestor", ancestor, commit], { allowFailure: true })).code === 0;
}

/** The remote branch is beyond approved work: its head, and whether it is later work of this task or not. */
type RemoteAhead = { head: string; kind: "later" | "foreign" };

/**
 * Where the remote branch stands beyond approved work `sha`: "later" - later work of this task (commits of the local
 * task branch that build on the approved work); "foreign" - commits the local task branch does not have. Null when the
 * remote branch is at or behind the approved work, does not exist, or cannot be reached.
 */
async function remoteAhead(repoPath: string, remote: string, branch: string, sha: string, timeoutMs?: number): Promise<RemoteAhead | null> {
  const head = await remoteBranchHead(repoPath, remote, branch, timeoutMs);
  if (!head || head === sha || (await isAncestor(repoPath, head, sha))) return null;
  const later = (await isAncestor(repoPath, sha, head)) && (await isAncestor(repoPath, head, `refs/heads/${branch}`));
  return { head, kind: later ? "later" : "foreign" };
}

/** The branch a pull request targets: the branch the task started from, or the repository's default branch. */
export function pullRequestBase(task: Pick<Task, "baseRef">, repo: Pick<Repo, "defaultBranch">): string {
  const ref = (task.baseRef ?? "").trim().replace(/^refs\/heads\//, "");
  if (ref && ref !== "HEAD" && !SHA.test(ref)) return ref;
  return repo.defaultBranch && repo.defaultBranch !== "HEAD" ? repo.defaultBranch : "main";
}

/**
 * Pull request description: the outcome, the request, the plan, tests and the agents that worked on it. With
 * `approved`, the task did not finish and the pull request holds only that approved work.
 */
export function pullRequestBody(task: Task, approved?: ApprovedWork): string {
  const result = approved ? undefined : task.result;
  const lines: string[] = [];
  if (result?.summary.trim()) lines.push(result.summary.trim(), "");
  if (approved) {
    const stage = task.stages.find((candidate) => candidate.kind === approved.stage);
    const round = stage?.rounds.find((candidate) => candidate.n === approved.round);
    const summary = round?.author?.summary ?? [...(stage?.rounds ?? [])].reverse().find((candidate) => candidate.n <= approved.round && candidate.author)?.author?.summary;
    if (summary?.trim()) lines.push(summary.trim(), "");
  }
  lines.push("---", "", "**Request**", "", ...truncate(task.description.trim(), 1500).split(/\r?\n/).map((line) => `> ${line}`), "");
  if (task.plan) {
    lines.push(`**Manager's plan:** ${task.plan.stages.map((stage) => STAGE_TITLES[stage]).join(" → ")} — ${task.plan.rationale}`, "");
  }
  if (approved) {
    const status = task.status === "failed" ? `failed${task.error ? `: ${truncate(firstLine(task.error), 300)}` : ""}` : task.status;
    lines.push(
      `**Outcome:** the task did not finish (${status}). This pull request holds only the work approved so far: the ${STAGE_TITLES[approved.stage]} stage, approved in round ${approved.round} (${approved.sha.slice(0, 10)}). Validate it before merging.`,
    );
  }
  if (result) {
    const testsLast = (result.outcomeStage ?? stageKindsOf(task).at(-1)) === "testing";
    lines.push(
      `**Outcome:** ${
        result.notRun?.length
          ? `not approved — the coding stage has ${result.openComments} open comment(s), so the tests did not run`
          : result.testsUnverified
            ? "the tests could not verify the change — validate it before merging"
            : result.approved
              ? testsLast
                ? "all tests pass (verified by the test executor)"
                : "approved by the reviewer"
              : `not approved — ${result.openComments} open ${testsLast ? "failure" : "comment"}(s)`
      }${result.shortStat ? ` · ${result.shortStat}` : ""}`,
    );
    if (result.warning) lines.push(`**⚠ Check before merging:** ${result.warning}`);
    if (result.tests) {
      const counts = result.tests.total !== undefined ? ` (${result.tests.passed ?? "?"}/${result.tests.total} passed)` : "";
      const commands = result.tests.commands.length ? ` · ${result.tests.commands.slice(0, 3).map((command) => `\`${command}\``).join(", ")}` : "";
      lines.push(`**Tests:** ${result.tests.status}${counts}${commands}`);
    }
    if (result.unitTests) {
      const commands = result.unitTests.commands.slice(0, 3).map((command) => `\`${command}\``).join(", ");
      lines.push(
        `**Unit tests:** ${result.unitTests.status}${result.unitTests.verified ? ", re-run by the hub before the review" : ""}${commands ? ` · ${commands}` : ""}`,
      );
    }
    const unrelated = [...(result.unitTests?.unrelatedFailures ?? []), ...(result.tests?.unrelatedFailures ?? [])];
    if (unrelated.length) {
      const names = [...new Set(unrelated.map((failure) => `\`${failure.test}\``))];
      lines.push(`**Failing tests unrelated to this change** (not fixed here): ${names.slice(0, 5).join(", ")}${names.length > 5 ? `, … (${names.length - 5} more)` : ""}`);
    }
  }
  const agents = (task.agents ?? []).filter((agent) => agent.turns > 0);
  if (agents.length) lines.push(`**Agents:** ${agents.map((agent) => `${ROLE_LABELS[agent.role]} (${agent.model})`).join(", ")}`);
  lines.push("", `_Created with Copilot Agent Hub — task ${task.id}._`);
  return lines.join("\n");
}

const STAGE_TITLES: Record<StageKind, string> = { design: "Design", coding: "Coding", testing: "Execute & verify", document: "Document" };
