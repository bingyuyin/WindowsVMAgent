import {
  TurnTimeoutError,
  type AgentDriver,
  type AgentHandle,
  type AgentObserver,
  type PlanSubmissionInput,
  type ReviewSubmissionInput,
  type SubmitChannel,
  type TestRunSubmissionInput,
  type TurnResult,
  type UserQuestion,
  type WorkSubmissionInput,
} from "../agents/driver.ts";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {
  authorPrompt,
  executionPrompt,
  MAX_INLINE_DIFF,
  NUDGE_PLAN,
  NUDGE_REVIEW,
  NUDGE_TEST,
  NUDGE_WORK,
  plannerPrompt,
  recoveryPrompt,
  restartNote,
  reviewPrompt,
  systemPromptFor,
  unitTestFailurePrompt,
  type DesignContext,
} from "../agents/prompts.ts";
import { evaluatePermission } from "../agents/policy.ts";
import { skillsForRole, type HubSkills } from "../context.ts";
import { DOC_EXTENSIONS, documentProblem, formatOfPath, renderDocTemplate, type DocTemplates } from "../docs.ts";
import type { AgentWorkspace, TaskWorkspace } from "../git.ts";
import {
  authorRoleFor,
  isDocStage,
  isReviewerRole,
  resolverRoleFor,
  reviewerRoleFor,
  ROLE_LABELS,
  rolesForStages,
  stageKindsOf,
  type AgentInfo,
  type AgentRole,
  type AgentStatus,
  type AuthorSubmission,
  type NewCommEntry,
  type NewTaskEvent,
  type Phase,
  type ReviewComment,
  type ReviewSubmission,
  type Round,
  type Settings,
  type Stage,
  type StageKind,
  type Task,
  type TestRunInfo,
  type UnitTestCheck,
} from "../types.ts";
import { runShellCommand, type CommandRunner } from "../shell.ts";
import { CancelledError, errorMessage, firstLine, nowIso, settledWithin, slugify, truncate } from "../util.ts";
import {
  fallbackReview,
  fallbackTestRun,
  heuristicPlan,
  mergeWork,
  normalizePlan,
  normalizeReview,
  normalizeTestRun,
  normalizeWork,
  severityForCategory,
} from "./submissions.ts";

/** Side effects the engine needs from its host (persistence, live updates, user prompts). */
export interface EngineHooks {
  readonly signal: AbortSignal;
  emit(event: NewTaskEvent): void;
  update(): void;
  observer(role: AgentRole, stage?: StageKind): AgentObserver;
  askUser(role: AgentRole, question: UserQuestion): Promise<string>;
  saveArtifact(name: string, content: string): Promise<void>;
  readArtifact(name: string): Promise<string | null>;
  trackSession(role: AgentRole, sessionId: string): void;
  /** Mutates the live state of a sub-agent (created on first use) and publishes it. */
  agent(role: AgentRole, mutate: (agent: AgentInfo) => void): void;
  /** Records a message between the manager and a sub-agent (assignments, submissions, verdicts...). */
  comm(entry: NewCommEntry): void;
}

export interface EngineOptions {
  driver: AgentDriver;
  workspace: TaskWorkspace;
  settings: Pick<Settings, "designDocDir" | "documentDir" | "docFormat" | "turnTimeoutMinutes" | "stuckAgentMinutes" | "cleanupWorktrees">;
  hooks: EngineHooks;
  hubSkills?: HubSkills;
  docTemplates?: DocTemplates | null;
  /** Runs the coding agents' unit test commands when the manager verifies them (default: the real shell). */
  runCommand?: CommandRunner;
  /**
   * One unit-test verification at a time on the task's repository, across tasks: test runs of different tasks
   * may still share ports, databases or fixed paths outside their worktrees.
   */
  testRuns?: { busy(): boolean; run<T>(work: () => Promise<T>): Promise<T> };
}

interface ActiveAgent {
  role: AgentRole;
  stageKind: StageKind | undefined;
  workingDirectory: string;
  handle: AgentHandle;
  /** Set while a turn is in flight: interrupts it so the manager can recover the agent. */
  interrupt?: (reason: string) => void;
  /** Rebuilds the current assignment with full context, for a fresh session that replaces a stuck one. */
  restartPrompt?: () => Promise<string>;
}

type AuthorWork = { input: WorkSubmissionInput; fallback: boolean };

/** The manager's run of a round's unit test commands; on failure, the command that failed and how. */
interface UnitTestRun {
  passed: boolean;
  command: string;
  problem: string;
  output: string;
  durationMs: number;
  exitCode: number | null;
  stopped?: UnitTestCheck["stopped"];
}

const MAX_SUBMIT_NUDGES = 2;
/** Recoveries per turn: interrupt and continue, then fresh sessions; after that the task fails (Retry resumes it). */
export const MAX_RECOVERIES = 3;
/** How long a stuck session gets to let go of its turn (abort, disconnect) before the manager moves on. */
const STOP_GRACE_MS = 30_000;
/** Times failing unit tests go back to the coding agent before the round goes to review anyway (flagged). */
export const MAX_TEST_FIX_ATTEMPTS = 3;
const MAX_ROUND_DIFF_BYTES = 60_000;
const CO_AUTHOR = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
const COMMENT_PREFIX: Record<StageKind, string> = { design: "D", document: "W", coding: "C", testing: "T" };

export const STAGE_LABELS: Record<StageKind, string> = { design: "Design", document: "Document", coding: "Coding", testing: "Execute & verify" };

/** A sub-agent stayed stuck, or its session kept failing, through every recovery. */
export class AgentUnrecoverableError extends Error {
  readonly reason: string;
  constructor(role: AgentRole, reason: string) {
    super(
      `${ROLE_LABELS[role]} could not be recovered after ${MAX_RECOVERIES} attempts; last problem: ${reason}. Retry the task to resume from the last completed step.`,
    );
    this.name = "AgentUnrecoverableError";
    this.reason = reason;
  }
}

export function modelFor(task: Pick<Task, "authorModel" | "reviewerModel" | "resolverModel" | "managerModel">, role: AgentRole): string {
  if (role === "planner") return task.managerModel || task.authorModel;
  // The executor verifies the fixer's work, so it gets the reviewer model (a second opinion).
  if (isReviewerRole(role) || role === "executor") return task.reviewerModel;
  if (role === "resolver" || role === "fixer") return task.resolverModel || task.authorModel;
  return task.authorModel;
}

/**
 * Runs a task's stages. Auto tasks start with the manager's planner, which decides the stages (and so
 * the sub-agents). Each stage is a loop between sub-agents that each work in their own place: authors
 * on their own branch, reviewers and the test executor in a worktree pinned to the commit under
 * review/test. After each author round the hub commits and fast-forwards the task branch; open review
 * comments go to the comment resolver (code), test failures to the test fixer, and document comments
 * back to the author, until the reviewer approves or the tests pass.
 */
export class WorkflowEngine {
  private readonly task: Task;
  private readonly options: EngineOptions;
  private readonly agents = new Map<AgentRole, ActiveAgent>();
  private pendingWork: WorkSubmissionInput | null = null;
  private pendingReview: ReviewSubmissionInput | null = null;
  private pendingTest: TestRunSubmissionInput | null = null;
  private pendingPlan: PlanSubmissionInput | null = null;
  private expectedCommentIds: string[] = [];
  /** A resubmission after failing unit tests need not repeat comment responses. */
  private partialResponses = false;
  /** The round under review failed the unit-test gate, so it cannot be approved. */
  private unitTestsFailing = false;
  private currentAuthorWorkspace: AgentWorkspace | null = null;
  /** Template content the current document was seeded with (to detect an unmodified template). */
  private seededDoc: string | null = null;

  constructor(task: Task, options: EngineOptions) {
    this.task = task;
    this.options = options;
  }

  async run(): Promise<void> {
    if (this.task.kind === "auto" && !this.task.plan) await this.plan();
    const kinds = stageKindsOf(this.task);
    for (const kind of kinds) {
      if (!this.task.stages.some((stage) => stage.kind === kind)) {
        this.task.stages.push({ kind, status: "pending", rounds: [], nextCommentNumber: 1 });
      }
    }
    const start = this.resumeIndex(kinds);
    for (let index = start; index < kinds.length; index++) {
      this.throwIfAborted();
      const stage = this.stage(kinds[index]!);
      // Later stages that are already finished have nothing new to do (the first one is being continued).
      if (index > start && (stage.status === "approved" || stage.status === "not-approved")) continue;
      const previous = index > 0 ? this.stage(kinds[index - 1]!) : undefined;
      if (previous?.status === "not-approved") {
        this.options.hooks.emit({
          type: "warning",
          text: `${STAGE_LABELS[previous.kind]} stage was not approved within its round budget; continuing with the latest version.`,
        });
      }
      await this.runStage(stage);
    }
    await this.finalize();
  }

  /** Interrupts in-flight agent turns (used when the task is cancelled or the hub shuts down). */
  async abortAgents(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.handle.abort()));
  }

  /**
   * Called by the manager's monitor when a working agent shows no sign of life: interrupts its turn so
   * `send` can recover it. False when the agent has no turn in flight.
   */
  recover(role: AgentRole, reason: string): boolean {
    const agent = this.agents.get(role);
    if (!agent?.interrupt || this.options.hooks.signal.aborted) return false;
    agent.interrupt(reason);
    agent.interrupt = undefined;
    return true;
  }

  /**
   * The manager plans an Auto task: its planner reads the request and the repository and decides which
   * stages (and so which sub-agents) to create, with an assignment for each.
   */
  private async plan(): Promise<void> {
    const { hooks, workspace } = this.options;
    const task = this.task;
    const role: AgentRole = "planner";
    this.setPhase(undefined, "planning", 0);
    hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", text: "Planning: reading the request and the repository to decide which sub-agents to create" });
    let status: AgentStatus = "done";
    try {
      const ws = await workspace.prepareReviewer(role, workspace.baseSha);
      const agent = await this.agentFor(role, undefined, ws.path);
      hooks.agent(role, (info) => {
        info.status = "working";
        info.workspace = ws.path;
        info.workspaceRemoved = false;
        info.branch = null;
        info.assignment = assignmentFor(role, 0, 0);
      });
      hooks.comm({ from: "manager", to: role, kind: "assign", text: "Plan the task: choose the sub-agent teams to create and write their assignments" });
      this.pendingPlan = null;
      const prompt = plannerPrompt(task, task.context);
      let result: TurnResult = {};
      let lost: AgentUnrecoverableError | null = null;
      try {
        result = await this.send(agent, prompt, async () => prompt);
        for (let nudge = 0; !this.submittedPlan() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
          this.throwIfAborted();
          hooks.emit({ type: "warning", role, text: "Planner ended its turn without calling submit_plan; asking it to submit." });
          hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_plan - submit the plan" });
          result = await this.send(agent, NUDGE_PLAN);
        }
      } catch (error) {
        // The manager can still plan without its planner: fall back to the stages the request names.
        if (!(error instanceof AgentUnrecoverableError)) throw error;
        lost = error;
        status = "failed";
      }
      this.throwIfAborted();
      let plan = this.submittedPlan();
      const fallback = !plan;
      if (!plan) {
        hooks.emit({
          type: "warning",
          role,
          text: lost
            ? `The planner could not be recovered (${lost.reason}); choosing stages from the request.`
            : `Planner never called submit_plan (last message: ${truncate(firstLine(result.lastMessage ?? ""), 200) || "none"}); choosing stages from the request.`,
        });
        plan = heuristicPlan(task.description);
      }
      task.plan = {
        stages: plan.stages,
        rationale: plan.rationale,
        instructions: plan.instructions,
        briefing: plan.briefing,
        fallback: fallback || undefined,
        plannedAt: nowIso(),
      };
      task.stages = plan.stages.map((kind) => ({ kind, status: "pending", rounds: [], nextCommentNumber: 1 }));
      const flow = plan.stages.map((kind) => STAGE_LABELS[kind]).join(" → ");
      hooks.emit({ type: "info", role, text: `Manager's plan: ${flow}. ${plan.rationale}`, data: { plan: task.plan } });
      hooks.comm({ from: role, to: "manager", kind: "plan", text: `Plan: ${flow} - ${truncate(plan.rationale, 240)}` });
      // The resolver and the fixer only start when a review requests changes or a test run fails.
      const team = rolesForStages(plan.stages);
      const onDemand: AgentRole[] = team.filter((candidate) => candidate === "resolver" || candidate === "fixer");
      hooks.comm({
        from: "manager",
        to: "manager",
        kind: "lifecycle",
        text: `Creating sub-agents: ${team.filter((candidate) => !onDemand.includes(candidate)).map((candidate) => ROLE_LABELS[candidate]).join(", ")}${onDemand.length ? `; on demand: ${onDemand.map((candidate) => ROLE_LABELS[candidate]).join(", ")}` : ""}`,
      });
    } catch (error) {
      status = hooks.signal.aborted || error instanceof CancelledError ? "cancelled" : "failed";
      throw error;
    } finally {
      await this.releaseAgent(role, status);
      hooks.update();
    }
  }

  private stage(kind: StageKind): Stage {
    const stage = this.task.stages.find((candidate) => candidate.kind === kind);
    if (!stage) throw new Error(`Stage ${kind} missing`);
    return stage;
  }

  /** First unfinished stage; when all are finished, continue the last one if it was not approved. */
  private resumeIndex(kinds: StageKind[]): number {
    const unfinished = kinds.findIndex((kind) => !["approved", "not-approved"].includes(this.stage(kind).status));
    if (unfinished >= 0) return unfinished;
    const last = kinds.length - 1;
    return this.stage(kinds[last]!).status === "not-approved" ? last : kinds.length;
  }

  private throwIfAborted(): void {
    if (this.options.hooks.signal.aborted) throw new CancelledError();
  }

  private setPhase(stage: StageKind | undefined, phase: Phase, round: number): void {
    const task = this.task;
    task.currentStage = stage;
    task.phase = phase;
    task.currentRound = round;
    task.phaseStartedAt = nowIso();
    this.options.hooks.emit({ type: "phase", stage, round: round || undefined, text: phaseLabel(stage, phase), data: { phase } });
    this.options.hooks.update();
  }

  private async runStage(stage: Stage): Promise<void> {
    const { hooks } = this.options;
    const task = this.task;
    const kind = stage.kind;
    stage.status = "running";
    stage.startedAt ??= nowIso();
    stage.finishedAt = undefined;
    if (isDocStage(kind)) {
      stage.docFormat ??= stage.docPath ? formatOfPath(stage.docPath) : this.options.settings.docFormat;
      stage.docPath ??= this.docPathFor(kind, stage.docFormat);
    }
    task.currentStage = kind;
    const testing = kind === "testing";
    hooks.emit({ type: "info", stage: kind, text: `${STAGE_LABELS[kind]} stage started` });
    hooks.comm({
      from: "manager",
      to: "manager",
      kind: "lifecycle",
      stage: kind,
      text: testing
        ? `${STAGE_LABELS[kind]} stage started: ${ROLE_LABELS.executor} runs and verifies the tests, ${ROLE_LABELS.fixer} fixes failures`
        : `${STAGE_LABELS[kind]} stage started: ${ROLE_LABELS[authorRoleFor(kind)]} writes, ${ROLE_LABELS[reviewerRoleFor(kind)]} reviews${stage.docPath ? ` (${stage.docPath})` : ""}`,
    });
    hooks.update();

    const budget = Math.max(1, task.roundsBudget ?? task.maxRounds);
    const design = kind === "coding" || testing ? await this.designContext() : undefined;
    const resumed = stage.rounds.some((round) => round.author);

    let last = stage.rounds.at(-1);
    if (last && !last.author && !last.review) {
      stage.rounds.pop();
      last = stage.rounds.at(-1);
    }
    // A round whose author work finished but whose review did not (e.g. after a restart) is reviewed first.
    let reviewOnly: Round | null = last?.author && !last.review ? last : null;
    let lastReview = reviewOnly ? undefined : last?.review;
    let open = lastReview?.verdict === "request_changes" ? lastReview.comments.filter((comment) => comment.status === "open") : [];
    // An earlier stage changed for a change request: run the tests again before fixing anything.
    if (testing && stage.rerun && !reviewOnly) {
      lastReview = undefined;
      open = [];
    }

    const used = new Set<AgentRole>();
    let reviews = 0;
    try {
      for (;;) {
        this.throwIfAborted();
        let round: Round;
        if (reviewOnly) {
          round = reviewOnly;
          reviewOnly = null;
        } else if (testing && !lastReview) {
          // A testing stage starts by running the automation on the task branch as it is.
          round = { n: stage.rounds.length + 1, attempt: task.attempt, startedAt: nowIso() };
          stage.rounds.push(round);
        } else {
          const role = open.length ? resolverRoleFor(kind) : authorRoleFor(kind);
          used.add(role);
          round = { n: stage.rounds.length + 1, attempt: task.attempt, startedAt: nowIso() };
          stage.rounds.push(round);
          this.setPhase(kind, open.length ? "revising" : "authoring", round.n);
          round.author = await this.authorTurn(stage, round, role, { design, resumed, lastReview, open });
          hooks.update();
          const responses = round.author.responses;
          if (testing && !round.author.commit && responses.length && responses.every((response) => response.status === "declined")) {
            // Re-running unchanged code cannot change the outcome.
            stage.status = "not-approved";
            const text =
              lastReview?.by === "user"
                ? `The test fixer declined the requested change(s) ${responses.map((response) => response.commentId).join(", ")} without changing any files; stopped without re-running unchanged code.`
                : `The test fixer could not fix the remaining ${responses.length} failure(s) in code; stopped without re-running unchanged code.`;
            hooks.emit({ type: "warning", stage: kind, round: round.n, text });
            hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", stage: kind, round: round.n, text });
            break;
          }
        }

        this.throwIfAborted();
        const reviewerRole = reviewerRoleFor(kind);
        used.add(reviewerRole);
        this.setPhase(kind, "reviewing", round.n);
        const review = await this.reviewTurn(stage, round, reviewerRole, design);
        reviews++;
        round.review = review;
        stage.rerun = undefined;
        const verdictText = review.testRun
          ? describeTestRun(review.testRun, review.comments)
          : review.verdict === "approve"
            ? "Approved"
            : `Changes requested (${review.comments.length} comment(s))`;
        hooks.emit({
          type: "review",
          role: reviewerRole,
          stage: kind,
          round: round.n,
          text: `${verdictText}: ${truncate(review.summary, 600)}`,
          data: { verdict: review.verdict, comments: review.comments.length, fallback: review.fallback ?? false, testRun: review.testRun },
        });
        hooks.comm({
          from: reviewerRole,
          to: "manager",
          kind: "verdict",
          stage: kind,
          round: round.n,
          text: review.testRun
            ? `${verdictText} - ${truncate(firstLine(review.summary), 200)}`
            : `${review.verdict === "approve" ? "Approved" : `Requested changes: ${describeComments(review.comments)}`} - ${truncate(firstLine(review.summary), 200)}`,
        });
        hooks.update();

        if (review.verdict === "approve") {
          stage.status = "approved";
          break;
        }
        lastReview = review;
        open = review.comments.filter((comment) => comment.status === "open");
        if (reviews >= budget) {
          stage.status = "not-approved";
          hooks.emit({
            type: "warning",
            stage: kind,
            text: testing
              ? `Stopped after ${reviews} test run(s); ${open.length} failure(s) remain.`
              : `Stopped after ${reviews} review round(s) without approval; ${open.length} comment(s) remain open.`,
          });
          break;
        }
      }
    } catch (error) {
      stage.status = hooks.signal.aborted || error instanceof CancelledError ? "cancelled" : "failed";
      throw error;
    } finally {
      stage.finishedAt = nowIso();
      const status: AgentStatus = stage.status === "failed" ? "failed" : stage.status === "cancelled" ? "cancelled" : "done";
      for (const role of used) await this.releaseAgent(role, status);
      hooks.update();
    }
    const finalRound = stage.rounds.at(-1)?.n ?? 0;
    const outcome =
      kind === "testing"
        ? stage.status === "approved"
          ? `${STAGE_LABELS[kind]}: all tests pass, verified in round ${finalRound}`
          : `${STAGE_LABELS[kind]} finished with failing tests after round ${finalRound}`
        : stage.status === "approved"
          ? `${STAGE_LABELS[kind]} approved in round ${finalRound}`
          : `${STAGE_LABELS[kind]} finished without approval after round ${finalRound}`;
    hooks.emit({ type: "info", stage: kind, text: outcome });
    hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", stage: kind, round: finalRound, text: outcome });
  }

  private async authorTurn(
    stage: Stage,
    round: Round,
    role: AgentRole,
    context: { design?: DesignContext; resumed: boolean; lastReview?: ReviewSubmission; open: ReviewComment[] },
  ): Promise<AuthorSubmission> {
    const { hooks, workspace } = this.options;
    const kind = stage.kind;
    const ws = await workspace.prepareAuthor(role);
    if (ws.notice) hooks.emit({ type: "warning", role, stage: kind, text: ws.notice });
    this.seededDoc = null;
    if (isDocStage(kind) && stage.docPath) {
      await ws.ensureDir(path.posix.dirname(stage.docPath));
      if (stage.docFormat === "html" && !(await ws.readFile(stage.docPath))?.trim()) {
        const seeded = this.renderTemplate(stage);
        if (seeded) {
          await ws.writeFile(stage.docPath, seeded);
          this.seededDoc = seeded;
          hooks.emit({ type: "info", role, stage: kind, text: `Seeded ${stage.docPath} with the light-themed HTML document template` });
        }
      }
    }
    const startHead = await ws.head();
    const fresh = !this.agents.has(role);
    const agent = await this.agentFor(role, kind, ws.path);
    const fromUser = context.lastReview?.by === "user";
    const assignment = assignmentFor(role, round.n, context.open.length, fromUser);
    hooks.agent(role, (info) => {
      info.status = "working";
      info.workspace = ws.path;
      info.workspaceRemoved = false;
      info.branch = ws.branch;
      info.assignment = assignment;
      if (!info.rounds.includes(round.n)) info.rounds.push(round.n);
    });
    hooks.emit({ type: "info", role, stage: kind, text: `${assignment} on branch ${ws.branch}` });
    hooks.comm({
      from: "manager",
      to: role,
      kind: "assign",
      stage: kind,
      round: round.n,
      text: context.open.length
        ? `${assignment}: ${context.open.map((comment) => comment.id).join(", ")} on ${ws.branch}`
        : `${assignment} on ${ws.branch}${kind === "coding" && context.design ? ` following ${context.design.approved ? "the approved" : "the latest"} design` : ""}`,
    });

    const buildPrompt = async (includeContext: boolean): Promise<string> => {
      let previousWork: { summary: string; stat: string; diff: { text: string; truncated: boolean } } | undefined;
      if (includeContext && (role === "resolver" || role === "fixer") && startHead !== workspace.baseSha) {
        // A fresh resolver/fixer did not see earlier rounds (or an earlier coding stage): give it the change so far.
        const prior =
          [...stage.rounds].reverse().find((candidate) => candidate !== round && candidate.author)?.author ??
          this.task.stages.flatMap((candidate) => candidate.rounds).filter((candidate) => candidate.author).at(-1)?.author;
        previousWork = {
          summary: prior?.summary ?? "",
          stat: await workspace.diffStat(workspace.baseSha, startHead),
          diff: await workspace.diff(workspace.baseSha, startHead, MAX_INLINE_DIFF),
        };
      }
      return authorPrompt({
        task: this.task,
        role,
        stage: kind,
        round: round.n,
        docPath: stage.docPath,
        docFormat: stage.docFormat,
        seeded: this.seededDoc !== null,
        design: context.design,
        context: this.task.context,
        includeContext,
        resumed: context.resumed && includeContext,
        review: context.lastReview,
        openComments: context.open,
        previousWork,
      });
    };
    const prompt = await buildPrompt(fresh);
    this.currentAuthorWorkspace = ws;
    let submission = await this.runAuthorTurn(agent, prompt, () => buildPrompt(true), context.open);
    let unitTests: UnitTestCheck | undefined;
    if (kind === "coding") ({ submission, unitTests } = await this.unitTestGate(agent, stage, round, ws, submission));
    hooks.agent(role, (info) => {
      info.status = "idle";
    });
    return this.recordAuthorRound(stage, round, role, ws, startHead, submission.input, submission.fallback, context.open, fromUser, unitTests);
  }

  private async reviewTurn(stage: Stage, round: Round, role: AgentRole, design: DesignContext | undefined): Promise<ReviewSubmission> {
    const { hooks, workspace } = this.options;
    const reviewedSha = round.author?.commit ?? (await workspace.taskHead());
    const ws = await workspace.prepareReviewer(role, reviewedSha);
    const fresh = !this.agents.has(role);
    const agent = await this.agentFor(role, stage.kind, ws.path);
    const authorRole = round.author?.role ?? authorRoleFor(stage.kind);
    const executor = role === "executor";
    const sha = reviewedSha.slice(0, 10);
    hooks.agent(role, (info) => {
      info.status = "working";
      info.workspace = ws.path;
      info.workspaceRemoved = false;
      info.branch = null;
      info.assignment = executor
        ? round.author
          ? `Verifying the fixes: re-running the tests at ${sha} (round ${round.n})`
          : `Running the test automation at ${sha} (round ${round.n})`
        : `Reviewing round ${round.n} at ${sha}`;
      if (!info.rounds.includes(round.n)) info.rounds.push(round.n);
    });
    hooks.comm({
      from: "manager",
      to: role,
      kind: "relay",
      stage: stage.kind,
      round: round.n,
      text: executor
        ? round.author
          ? `Re-run the tests at ${sha} and verify the ${ROLE_LABELS[authorRole].toLowerCase()}'s fixes${round.author.shortStat ? ` (${round.author.shortStat})` : ""}`
          : `Run the test automation at ${sha} and verify the results`
        : `Review the ${ROLE_LABELS[authorRole].toLowerCase()}'s round ${round.n} at ${sha}${round.author?.shortStat ? ` (${round.author.shortStat})` : ""}`,
    });
    const build = (includeContext: boolean) =>
      executor
        ? this.buildExecutionPrompt(stage, round, includeContext, design, reviewedSha)
        : this.buildReviewPrompt(stage, round, includeContext, design, reviewedSha);
    const prompt = await build(fresh);
    this.unitTestsFailing = round.author?.unitTests?.status === "failed";
    const review = executor
      ? await this.runTestTurn(agent, prompt, () => build(true), stage, reviewedSha)
      : await this.runReviewTurn(agent, prompt, () => build(true), stage, reviewedSha);
    hooks.agent(role, (info) => {
      info.status = "idle";
    });
    return review;
  }

  private async agentFor(role: AgentRole, stageKind: StageKind | undefined, workingDirectory: string): Promise<ActiveAgent> {
    const existing = this.agents.get(role);
    if (existing) return existing;
    const agent: ActiveAgent = { role, stageKind, workingDirectory, handle: await this.startSession(role, stageKind, workingDirectory) };
    this.agents.set(role, agent);
    return agent;
  }

  /** Starts a Copilot session for a sub-agent; `replacing` says why when it replaces a stuck session. */
  private async startSession(role: AgentRole, stageKind: StageKind | undefined, workingDirectory: string, replacing?: string): Promise<AgentHandle> {
    const { driver, workspace, settings, hooks, hubSkills } = this.options;
    const task = this.task;
    const readOnly = isReviewerRole(role) || role === "planner";
    const executeOnly = role === "executor";
    const model = modelFor(task, role);
    const hubNames = (hubSkills?.skills ?? []).map((skill) => skill.name);
    const skills = skillsForRole(role, task.context).filter((name) => hubNames.includes(name));
    const handle = await driver.start({
      taskId: task.id,
      role,
      model,
      title: task.title,
      workingDirectory,
      systemPrompt: systemPromptFor(
        role,
        { worktree: workingDirectory, branch: workspace.branchFor(role), taskBranch: workspace.taskBranch, baseSha: workspace.baseSha },
        skills,
        {
          docFormat:
            stageKind && isDocStage(stageKind) ? (this.task.stages.find((stage) => stage.kind === stageKind)?.docFormat ?? "markdown") : undefined,
        },
      ),
      readOnly,
      executeOnly,
      skillDirectories: [
        ...(task.context?.skillRoots ?? []).map((root) => path.join(workingDirectory, root)),
        ...(hubSkills?.dir ? [hubSkills.dir] : []),
      ],
      disabledSkills: hubNames.filter((name) => !skills.includes(name)),
      submit: this.submitChannelFor(role, stageKind),
      observer: hooks.observer(role, stageKind),
      askUser: (question) => hooks.askUser(role, question),
      turnTimeoutMs: settings.turnTimeoutMinutes * 60_000,
    });
    hooks.trackSession(role, handle.sessionId);
    hooks.agent(role, (info) => {
      info.model = model;
      info.sessionId = handle.sessionId;
      info.skills = skills;
    });
    const label = ROLE_LABELS[role].toLowerCase();
    hooks.emit({
      type: replacing ? "warning" : "info",
      role,
      stage: stageKind,
      text: replacing ? `Restarted the ${label} in a fresh session on ${model} (${replacing})` : `${ROLE_LABELS[role]} agent started on ${model}`,
      data: { sessionId: handle.sessionId },
    });
    const access = readOnly ? " (read-only)" : executeOnly ? " (runs commands, no file edits)" : "";
    hooks.comm({
      from: "manager",
      to: role,
      kind: "spawn",
      stage: stageKind,
      text: `Started a ${replacing ? "fresh " : ""}${label} session on ${model}${access}${skills.length ? `; skills: ${skills.join(", ")}` : ""}${replacing ? "; it replaces the stuck session and gets the full assignment" : ""}`,
    });
    return handle;
  }

  /** The terminal tool through which each kind of agent hands back its structured result. */
  private submitChannelFor(role: AgentRole, stageKind: StageKind | undefined): SubmitChannel {
    if (role === "planner") return { kind: "plan", onSubmit: (input) => void (this.pendingPlan = normalizePlan(input)) };
    if (role === "executor") return { kind: "test", onSubmit: (input) => void (this.pendingTest = normalizeTestRun(input)) };
    if (isReviewerRole(role)) return { kind: "review", onSubmit: (input) => void (this.pendingReview = this.checkVerdict(normalizeReview(input))) };
    if (!stageKind) throw new Error(`${role} needs a stage`);
    return { kind: "work", unitTests: stageKind === "coding", onSubmit: (input) => this.acceptWork(input, stageKind) };
  }

  private checkVerdict(review: ReviewSubmissionInput): ReviewSubmissionInput {
    if (review.verdict === "approve" && this.unitTestsFailing) {
      throw new Error(
        "The unit tests of this round fail, so it cannot be approved. Call submit_review with request_changes and a blocker comment about the failing tests.",
      );
    }
    return review;
  }

  private async releaseAgent(role: AgentRole, status: AgentStatus): Promise<void> {
    const agent = this.agents.get(role);
    if (!agent) return;
    this.agents.delete(role);
    await agent.handle.dispose();
    this.options.hooks.agent(role, (info) => {
      info.status = status;
      info.assignment = undefined;
    });
    this.options.hooks.comm({ from: "manager", to: role, kind: "release", text: `Closed the session (${status})` });
  }

  /**
   * Runs one agent turn under the manager's supervision. A turn the manager's monitor finds stuck, that
   * runs past the turn timeout or whose session fails is recovered: first by interrupting it and asking
   * the agent to carry on without repeating what hung, then by killing the session and starting a fresh
   * one with the full assignment. After MAX_RECOVERIES the turn fails (Retry resumes the task).
   */
  private async send(agent: ActiveAgent, prompt: string, restartPrompt?: () => Promise<string>): Promise<TurnResult> {
    const { hooks } = this.options;
    const role = agent.role;
    if (restartPrompt) agent.restartPrompt = restartPrompt;
    let message = prompt;
    for (let recovery = 0; ; recovery++) {
      this.throwIfAborted();
      hooks.agent(role, (info) => {
        info.turns += 1;
      });
      const handle = agent.handle;
      const interrupted = new Promise<string>((resolve) => {
        agent.interrupt = resolve;
      });
      const turn = handle.send(message);
      const outcome = await Promise.race([
        turn.then(
          (result) => ({ kind: "done" as const, result }),
          (error: unknown) => ({ kind: "failed" as const, error }),
        ),
        interrupted.then((reason) => ({ kind: "stuck" as const, reason })),
      ]);
      agent.interrupt = undefined;
      if (outcome.kind === "done") return outcome.result;
      this.throwIfAborted();
      const timedOut = outcome.kind === "failed" && outcome.error instanceof TurnTimeoutError;
      // A stuck or timed-out turn may still be running in the session: stop it first.
      const stopped = outcome.kind === "stuck" || timedOut ? await settledWithin(Promise.all([handle.abort(), turn]), STOP_GRACE_MS) : false;
      this.throwIfAborted();
      // The agent delivered its result before it got stuck: nothing to recover.
      if (this.hasSubmission(role)) return {};
      const problem =
        outcome.kind === "stuck" ? outcome.reason : timedOut ? errorMessage(outcome.error) : `its session failed: ${truncate(errorMessage(outcome.error), 300)}`;
      const label = ROLE_LABELS[role];
      if (recovery >= MAX_RECOVERIES) {
        hooks.comm({ from: "manager", to: role, kind: "recover", text: `Gave up: ${label} could not be recovered after ${MAX_RECOVERIES} attempts; last problem: ${problem}` });
        throw new AgentUnrecoverableError(role, problem);
      }
      const restart = !stopped || recovery > 0;
      const attempt = `recovery ${recovery + 1} of ${MAX_RECOVERIES}`;
      hooks.agent(role, (info) => {
        info.recoveries = (info.recoveries ?? 0) + 1;
      });
      hooks.emit({
        type: "warning",
        role,
        text: `${label} stopped making progress (${problem}); ${restart ? "killing its session and restarting it with the full assignment" : "interrupted the turn and asked it to continue"} (${attempt}).`,
      });
      hooks.comm({
        from: "manager",
        to: role,
        kind: "recover",
        text: `No progress: ${problem}. ${restart ? "Killing the session and restarting the agent" : "Interrupted the turn; continue without repeating what hung"} (${attempt})`,
      });
      message = restart ? await this.restartAgent(agent, problem) : recoveryPrompt(role, problem);
    }
  }

  /** Kills a stuck agent's session and starts a fresh one; returns the prompt that hands it the assignment again. */
  private async restartAgent(agent: ActiveAgent, problem: string): Promise<string> {
    const old = agent.handle;
    await settledWithin(old.abort(), STOP_GRACE_MS);
    await settledWithin(old.dispose(), STOP_GRACE_MS);
    agent.handle = await this.startSession(agent.role, agent.stageKind, agent.workingDirectory, problem);
    return restartNote(agent.role, problem) + (agent.restartPrompt ? await agent.restartPrompt() : "");
  }

  private hasSubmission(role: AgentRole): boolean {
    if (role === "planner") return this.pendingPlan !== null;
    if (role === "executor") return this.pendingTest !== null;
    return isReviewerRole(role) ? this.pendingReview !== null : this.pendingWork !== null;
  }

  private async acceptWork(input: WorkSubmissionInput, stageKind: StageKind): Promise<void> {
    const normalized = normalizeWork(input, this.expectedCommentIds, { unitTests: stageKind === "coding", partialResponses: this.partialResponses });
    if (isDocStage(stageKind)) {
      const stage = this.stage(stageKind);
      const content = await this.currentAuthorWorkspace?.readFile(stage.docPath!);
      const problem = documentProblem(content, stage.docFormat ?? "markdown", this.seededDoc);
      if (problem) {
        throw new Error(`The document '${stage.docPath}' ${problem}. Fix the file at that exact path, then call submit_work again.`);
      }
    }
    this.pendingWork = normalized;
  }

  private async runAuthorTurn(agent: ActiveAgent, prompt: string, restartPrompt: () => Promise<string>, open: ReviewComment[]): Promise<AuthorWork> {
    this.expectedCommentIds = open.map((comment) => comment.id);
    const { input, lastMessage } = await this.collectWork(agent, prompt, restartPrompt);
    if (input) return { input, fallback: false };
    this.options.hooks.emit({ type: "warning", role: agent.role, text: "Agent never called submit_work; using its last message as the round summary." });
    return { input: { summary: lastMessage?.trim() || "(no summary provided)" }, fallback: true };
  }

  /** Sends a prompt and waits for submit_work, nudging an agent that ends its turn without it. */
  private async collectWork(
    agent: ActiveAgent,
    prompt: string,
    restartPrompt?: () => Promise<string>,
  ): Promise<{ input: WorkSubmissionInput | null; lastMessage?: string }> {
    const role = agent.role;
    this.pendingWork = null;
    let result = await this.send(agent, prompt, restartPrompt);
    for (let nudge = 0; !this.submittedWork() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      this.options.hooks.emit({ type: "warning", role, text: "Agent ended its turn without calling submit_work; asking it to submit." });
      this.options.hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_work - finish the round and submit" });
      result = await this.send(agent, NUDGE_WORK);
    }
    return { input: this.submittedWork(), lastMessage: result.lastMessage };
  }

  /**
   * The unit-test gate between a coding round and its review: the manager re-runs the unit tests the author
   * reported in the author's worktree and hands failures back to the same agent until they pass (at most
   * MAX_TEST_FIX_ATTEMPTS times). The reviewer then gets a round whose unit tests pass, or one flagged as
   * failing that it cannot approve.
   */
  private async unitTestGate(
    agent: ActiveAgent,
    stage: Stage,
    round: Round,
    ws: AgentWorkspace,
    submission: AuthorWork,
  ): Promise<{ submission: AuthorWork; unitTests: UnitTestCheck }> {
    const { hooks } = this.options;
    const role = agent.role;
    const label = ROLE_LABELS[role];
    const roundRestart = agent.restartPrompt;
    let current = submission;
    for (let attempt = 0; ; attempt++) {
      this.throwIfAborted();
      const report = current.input.unit_tests;
      const counts = { total: report?.total, passed: report?.passed, failed: report?.failed, skipped: report?.skipped };
      if (report?.status === "blocked") {
        hooks.emit({ type: "warning", role, text: `${label} reports that the unit tests cannot pass (${truncate(report.reason ?? "", 400)}); the reviewer weighs the reason.` });
        return { submission: current, unitTests: { status: "blocked", commands: report.commands, ...counts, reason: report.reason, fixAttempts: attempt } };
      }
      const commands = report?.commands.length ? report.commands : this.knownUnitTestCommands(stage);
      if (!commands.length) {
        const reason = `the ${label.toLowerCase()} did not report which unit tests it ran`;
        hooks.emit({ type: "warning", role, text: `Unit tests not verified: ${reason}. The reviewer cannot approve the round.` });
        return { submission: current, unitTests: { status: "failed", commands: [], reason, fixAttempts: attempt } };
      }
      this.setPhase(stage.kind, "verifying", round.n);
      const run = await this.runUnitTests(role, ws, commands);
      this.throwIfAborted();
      const unitTests: UnitTestCheck = {
        status: run.passed ? "passed" : "failed",
        commands,
        ...counts,
        verified: run.passed,
        fixAttempts: attempt,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        stopped: run.stopped,
        logExcerpt: run.passed ? undefined : run.output.slice(-6000) || undefined,
      };
      const list = commands.map((command) => `\`${command}\``).join(", ");
      if (run.passed) {
        hooks.emit({ type: "info", text: `Unit tests pass: ${list} (${Math.round(run.durationMs / 1000)} s). Round ${round.n} goes to review.` });
        hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", text: `Unit tests pass for round ${round.n} (${commands.join(", ")}); handing it to the reviewer` });
        return { submission: current, unitTests };
      }
      const failure = `\`${run.command}\` ${run.problem}`;
      if (attempt >= MAX_TEST_FIX_ATTEMPTS) {
        hooks.emit({ type: "warning", role, text: `Unit tests still fail after ${attempt} fix attempt(s) (${failure}); the round goes to review flagged as failing.` });
        hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", text: `Unit tests still fail after ${attempt} fix attempt(s); the reviewer gets round ${round.n} flagged and cannot approve it` });
        return { submission: current, unitTests };
      }
      const next = `fix attempt ${attempt + 1} of ${MAX_TEST_FIX_ATTEMPTS}`;
      hooks.emit({ type: "warning", role, text: `Unit tests fail: ${failure}. Sending the failures back to the ${label.toLowerCase()} (${next}).` });
      hooks.comm({ from: "manager", to: role, kind: "relay", text: `Unit tests fail (${run.command} ${run.problem}) - fix them and submit again (${next})` });
      this.setPhase(stage.kind, role === "resolver" ? "revising" : "authoring", round.n);
      hooks.agent(role, (info) => {
        info.status = "working";
        info.assignment = `Fixing failing unit tests (${next})`;
      });
      const prompt = unitTestFailurePrompt(run, attempt + 1, MAX_TEST_FIX_ATTEMPTS);
      this.partialResponses = true;
      let fixed: { input: WorkSubmissionInput | null };
      try {
        fixed = await this.collectWork(agent, prompt, roundRestart && (async () => `${await roundRestart()}\n\n${prompt}`));
      } finally {
        this.partialResponses = false;
      }
      if (!fixed.input) {
        hooks.emit({ type: "warning", role, text: "Agent did not resubmit after the unit test failures; the round goes to review flagged as failing." });
        return { submission: current, unitTests };
      }
      current = { input: current.fallback ? fixed.input : mergeWork(current.input, fixed.input), fallback: false };
    }
  }

  /** Runs unit test commands in the author's worktree, stopping at the first failure, and removes what the run left behind. */
  private async runUnitTests(role: AgentRole, ws: AgentWorkspace, commands: string[]): Promise<UnitTestRun> {
    const { hooks } = this.options;
    const runs = this.options.testRuns;
    hooks.agent(role, (info) => {
      info.status = "idle";
      info.assignment = `Waiting while the manager runs the unit tests: ${commands.join(", ")}`;
    });
    this.throwIfAborted();
    if (!runs) return this.runUnitTestCommands(ws, commands);
    if (runs.busy()) hooks.emit({ type: "info", text: "Another task is running unit tests on this repository; waiting for it to finish so the runs cannot interfere." });
    const queued = runs.run(() => (hooks.signal.aborted ? Promise.resolve(CANCELLED_RUN) : this.runUnitTestCommands(ws, commands)));
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new CancelledError());
      hooks.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([queued, cancelled]);
    } finally {
      hooks.signal.removeEventListener("abort", onAbort);
    }
  }

  private async runUnitTestCommands(ws: AgentWorkspace, commands: string[]): Promise<UnitTestRun> {
    const { hooks, settings, workspace } = this.options;
    const runCommand = this.options.runCommand ?? runShellCommand;
    // A temp folder per task, emptied before every run, so leftovers of other tasks' runs cannot affect this one.
    const tempDir = path.join(workspace.root, "tmp");
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(tempDir, { recursive: true });
    const env = testRunEnv(ws.path, tempDir);
    const before = await ws.changedPaths();
    let durationMs = 0;
    try {
      for (const command of commands) {
        // The hub runs what the agent reported, so the agent's own command restrictions (no push, no global installs) apply.
        const policy = evaluatePermission({ kind: "shell", fullCommandText: command }, { readOnly: false, workingDirectory: ws.path });
        if (policy.kind === "reject") return { passed: false, command, problem: `was not run: ${policy.feedback}`, output: "", durationMs, exitCode: null };
        hooks.emit({ type: "info", text: `Running the unit tests to verify them before review: ${command}` });
        const result = await runCommand(command, {
          cwd: ws.path,
          timeoutMs: settings.turnTimeoutMinutes * 60_000,
          silenceMs: settings.stuckAgentMinutes * 60_000,
          signal: hooks.signal,
          env,
        });
        durationMs += result.durationMs;
        if (result.stopped || result.exitCode !== 0) {
          const problem =
            result.stopped === "silent"
              ? `printed nothing for ${settings.stuckAgentMinutes} min and was stopped (a test probably hangs)`
              : result.stopped === "timeout"
                ? `ran longer than ${settings.turnTimeoutMinutes} min and was stopped`
                : result.stopped === "cancelled"
                  ? "was cancelled"
                  : `exited with code ${result.exitCode} after ${Math.round(result.durationMs / 1000)} s`;
          return { passed: false, command, problem, output: result.output, durationMs, exitCode: result.exitCode, stopped: result.stopped };
        }
      }
      return { passed: true, command: commands.at(-1)!, problem: "", output: "", durationMs, exitCode: 0 };
    } finally {
      const discarded = await ws.discardChangesSince(before);
      if (discarded.length) hooks.emit({ type: "info", text: `Discarded ${discarded.length} file(s) the test run created or changed: ${truncate(discarded.join(", "), 300)}` });
    }
  }

  /** Unit test commands an earlier round of the stage reported, for an author that does not report its own. */
  private knownUnitTestCommands(stage: Stage): string[] {
    return [...stage.rounds].reverse().find((round) => round.author?.unitTests?.commands.length)?.author?.unitTests?.commands ?? [];
  }

  /** Submissions arrive through tool callbacks while `send` is awaited, so read them via accessors. */
  private submittedWork(): WorkSubmissionInput | null {
    return this.pendingWork;
  }

  private submittedReview(): ReviewSubmissionInput | null {
    return this.pendingReview;
  }

  private submittedTest(): TestRunSubmissionInput | null {
    return this.pendingTest;
  }

  private submittedPlan(): PlanSubmissionInput | null {
    return this.pendingPlan;
  }

  /** The executor runs the test automation; its failures become comment-like items (T1, T2, ...) for the fixer. */
  private async runTestTurn(agent: ActiveAgent, prompt: string, restartPrompt: () => Promise<string>, stage: Stage, testedSha: string): Promise<ReviewSubmission> {
    const { hooks } = this.options;
    const role = agent.role;
    this.pendingTest = null;
    let result = await this.send(agent, prompt, restartPrompt);
    for (let nudge = 0; !this.submittedTest() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      hooks.emit({ type: "warning", role, text: "Test executor ended its turn without calling submit_test_results; asking it to submit." });
      hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_test_results - report the run" });
      result = await this.send(agent, NUDGE_TEST);
    }
    let input = this.submittedTest();
    const fallback = !input;
    if (!input) {
      hooks.emit({ type: "warning", role, text: "Test executor never called submit_test_results; treating the run as blocked." });
      input = fallbackTestRun(result.lastMessage);
    }
    const testRun: TestRunInfo = {
      status: input.status,
      commands: input.commands,
      total: input.total,
      passed: input.passed,
      failed: input.failed,
      skipped: input.skipped,
      logExcerpt: input.log_excerpt,
    };
    return {
      verdict: input.status === "passed" ? "approve" : "request_changes",
      summary: input.summary,
      comments: input.failures.map((failure) => ({
        id: `${COMMENT_PREFIX[stage.kind]}${stage.nextCommentNumber++}`,
        severity: severityForCategory(failure.category),
        file: failure.file,
        line: failure.line,
        body: [`\`\`\`\n${failure.error}\n\`\`\``, failure.suggestion ? `**Suggested fix:** ${failure.suggestion}` : ""].filter(Boolean).join("\n\n"),
        status: "open" as const,
        test: failure.test,
        category: failure.category,
      })),
      reviewedSha: testedSha,
      testRun,
      fallback: fallback || undefined,
      at: nowIso(),
    };
  }

  private async runReviewTurn(agent: ActiveAgent, prompt: string, restartPrompt: () => Promise<string>, stage: Stage, reviewedSha: string): Promise<ReviewSubmission> {
    const role = agent.role;
    this.pendingReview = null;
    let result = await this.send(agent, prompt, restartPrompt);
    for (let nudge = 0; !this.submittedReview() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      this.options.hooks.emit({ type: "warning", role, text: "Reviewer ended its turn without calling submit_review; asking it to submit." });
      this.options.hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_review - submit your verdict" });
      result = await this.send(agent, NUDGE_REVIEW);
    }
    let input = this.submittedReview();
    const fallback = !input;
    if (!input) {
      this.options.hooks.emit({ type: "warning", role, text: "Reviewer never called submit_review; deriving the verdict from its last message." });
      input = fallbackReview(result.lastMessage);
    }
    if (input.verdict === "approve" && this.unitTestsFailing) {
      input = { verdict: "request_changes", summary: input.summary, comments: [{ severity: "blocker", body: "The unit tests of this round fail; make them pass." }] };
    }
    const prefix = COMMENT_PREFIX[stage.kind];
    return {
      verdict: input.verdict,
      summary: input.summary,
      comments: input.comments.map((comment) => ({ id: `${prefix}${stage.nextCommentNumber++}`, ...comment, status: "open" as const })),
      reviewedSha,
      fallback: fallback || undefined,
      at: nowIso(),
    };
  }

  private async recordAuthorRound(
    stage: Stage,
    round: Round,
    role: AgentRole,
    ws: AgentWorkspace,
    startHead: string,
    input: WorkSubmissionInput,
    fallback: boolean,
    open: ReviewComment[],
    fromUser = false,
    unitTests?: UnitTestCheck,
  ): Promise<AuthorSubmission> {
    const { workspace, hooks } = this.options;
    const task = this.task;
    for (const comment of open) {
      const response = input.comment_responses?.find((candidate) => candidate.comment_id === comment.id);
      if (response) {
        comment.status = response.status;
        comment.response = response.note;
      }
    }

    let docSnapshot: string | undefined;
    if (isDocStage(stage.kind) && stage.docPath) {
      const content = await ws.readFile(stage.docPath);
      if (content !== null) {
        docSnapshot = `doc-r${round.n}${DOC_EXTENSIONS[stage.docFormat ?? formatOfPath(stage.docPath)]}`;
        await hooks.saveArtifact(docSnapshot, content);
      } else {
        hooks.emit({ type: "warning", role, text: `Document ${stage.docPath} was not found after round ${round.n}.` });
      }
    }

    const label = fromUser
      ? `requested changes ${open.map((comment) => comment.id).join(", ")}`
      : stage.kind === "coding"
        ? role === "resolver"
          ? "review fixes"
          : "code"
        : stage.kind === "testing"
          ? "test fixes"
          : stage.kind;
    const subject = `[agent-hub] ${task.id} ${label} round ${round.n}: ${truncate(firstLine(input.summary), 72)}`;
    await ws.commitAll(subject, `${task.title}\n\nAuthor agent: ${ROLE_LABELS[role]}\n\n${CO_AUTHOR}`);
    // Also picks up commits an agent made itself despite the instructions.
    const head = await ws.head();
    const commit = head !== startHead ? head : null;
    let shortStat = "";
    if (commit) {
      await workspace.advance(startHead, commit);
      shortStat = await workspace.shortStat(startHead, commit);
      hooks.emit({
        type: "commit",
        role,
        text: `Committed ${commit.slice(0, 10)} on ${ws.branch}${shortStat ? ` (${shortStat})` : ""}; fast-forwarded ${workspace.taskBranch}`,
        data: { sha: commit, branch: ws.branch },
      });
    } else {
      hooks.emit({ type: "warning", role, text: "The author made no file changes in this round." });
    }
    hooks.emit({
      type: "submission",
      role,
      text: truncate(input.summary, 4000),
      data: { responses: input.comment_responses?.length ?? 0, fallback },
    });
    const addressed = input.comment_responses?.filter((response) => response.status === "addressed").length ?? 0;
    const declined = (input.comment_responses?.length ?? 0) - addressed;
    hooks.comm({
      from: role,
      to: "manager",
      kind: "submit",
      stage: stage.kind,
      round: round.n,
      text: [
        `Submitted round ${round.n}`,
        commit ? `commit ${commit.slice(0, 10)}${shortStat ? ` (${shortStat})` : ""}` : "no file changes",
        open.length ? `${addressed} addressed, ${declined} declined` : "",
        unitTests ? `unit tests ${unitTests.status}` : "",
        fallback ? "no submit_work call (summary derived)" : "",
      ]
        .filter(Boolean)
        .join("; ") + ` - ${truncate(firstLine(input.summary), 160)}`,
    });
    return {
      role,
      branch: ws.branch ?? undefined,
      summary: input.summary,
      validation: input.validation,
      responses: (input.comment_responses ?? []).map((response) => ({
        commentId: response.comment_id,
        status: response.status,
        note: response.note,
      })),
      fallback: fallback || undefined,
      commit,
      prevCommit: startHead,
      shortStat,
      docSnapshot,
      unitTests,
      at: nowIso(),
    };
  }

  private async buildExecutionPrompt(
    stage: Stage,
    round: Round,
    includeContext: boolean,
    design: DesignContext | undefined,
    headSha: string,
  ): Promise<string> {
    const { workspace } = this.options;
    const fix = round.author;
    const fixDiff = fix?.commit ? await workspace.diff(fix.prevCommit ?? workspace.baseSha, headSha, MAX_ROUND_DIFF_BYTES) : undefined;
    return executionPrompt({
      task: this.task,
      round: round.n,
      includeContext,
      design,
      context: this.task.context,
      baseSha: workspace.baseSha,
      headSha,
      totalStat: await workspace.diffStat(workspace.baseSha, headSha),
      fix,
      fixDiff,
      previousRun: stage.rounds.find((candidate) => candidate.n === round.n - 1)?.review,
    });
  }

  private async buildReviewPrompt(
    stage: Stage,
    round: Round,
    includeContext: boolean,
    design: DesignContext | undefined,
    headSha: string,
  ): Promise<string> {
    const { workspace, hooks } = this.options;
    const submission = round.author!;
    const prevSha = submission.prevCommit ?? workspace.baseSha;
    const totalStat = await workspace.diffStat(workspace.baseSha, headSha);
    let docContent: string | undefined;
    let roundDiff: { text: string; truncated: boolean } | undefined;
    if (isDocStage(stage.kind)) {
      docContent =
        (stage.docPath ? await workspace.readAt(headSha, stage.docPath) : null) ??
        (submission.docSnapshot ? await hooks.readArtifact(submission.docSnapshot) : null) ??
        undefined;
      if (round.n > 1 && stage.docPath) roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES, [stage.docPath]);
    } else {
      roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES);
    }
    const previousReview = stage.rounds.find((candidate) => candidate.n === round.n - 1)?.review;
    const previousComments = previousReview?.comments ?? [];
    return reviewPrompt({
      task: this.task,
      role: reviewerRoleFor(stage.kind),
      stage: stage.kind,
      round: round.n,
      includeContext,
      design,
      context: this.task.context,
      docPath: stage.docPath,
      docFormat: stage.docFormat,
      docContent,
      submission,
      authorLabel: ROLE_LABELS[submission.role ?? authorRoleFor(stage.kind)],
      baseSha: workspace.baseSha,
      prevSha,
      headSha,
      totalStat,
      roundDiff,
      previousComments,
      userRequests: previousReview?.by === "user",
    });
  }

  private docPathFor(kind: StageKind, format: "html" | "markdown"): string {
    const { settings } = this.options;
    const fallback = kind === "design" ? "docs/designs" : "docs";
    const configured = kind === "design" ? settings.designDocDir : settings.documentDir;
    const dir = (configured ?? fallback).replaceAll("\\", "/").replace(/\/+$/, "") || fallback;
    return `${dir}/${this.task.id.toLowerCase()}-${slugify(this.task.title, 48)}${DOC_EXTENSIONS[format]}`;
  }

  private renderTemplate(stage: Stage): string | null {
    const templates = this.options.docTemplates;
    if (!templates) return null;
    return renderDocTemplate(templates, stage.kind, {
      title: this.task.title,
      taskId: this.task.id,
      repo: this.task.repoName,
      date: new Date().toISOString().slice(0, 10),
      author: authorRoleFor(stage.kind),
      reviewer: reviewerRoleFor(stage.kind),
    });
  }

  private async designContext(): Promise<DesignContext | undefined> {
    const designStage = this.task.stages.find((stage) => stage.kind === "design");
    if (!designStage?.docPath) return undefined;
    let content = await this.options.workspace.readAt(await this.options.workspace.taskHead(), designStage.docPath);
    if (!content) {
      const snapshot = [...designStage.rounds].reverse().find((round) => round.author?.docSnapshot)?.author?.docSnapshot;
      content = snapshot ? await this.options.hooks.readArtifact(snapshot) : null;
    }
    if (!content) return undefined;
    const approved = designStage.status === "approved";
    const lastReview = [...designStage.rounds].reverse().find((round) => round.review)?.review;
    return {
      path: designStage.docPath,
      format: designStage.docFormat ?? formatOfPath(designStage.docPath),
      content,
      approved,
      openComments: approved ? [] : (lastReview?.comments.filter((comment) => comment.status === "open") ?? []),
    };
  }

  private async finalize(): Promise<void> {
    const { workspace, hooks, settings } = this.options;
    const task = this.task;
    const kinds = stageKindsOf(task);
    const lastStage = this.stage(kinds[kinds.length - 1]!);
    this.setPhase(lastStage.kind, "finalizing", task.currentRound);
    const head = await workspace.taskHead();
    const lastReview = [...lastStage.rounds].reverse().find((round) => round.review)?.review;
    const docStage = task.stages.find((stage) => isDocStage(stage.kind));
    const testStage = task.stages.find((stage) => stage.kind === "testing");
    const codingStage = task.stages.find((stage) => stage.kind === "coding");
    const stages = kinds.map((kind) => this.stage(kind));
    const summary =
      stages.length > 1
        ? stages
            .map((stage) => [stage, stageSummary(stage)] as const)
            .filter(([, text]) => text)
            .map(([stage, text]) => `**${STAGE_LABELS[stage.kind]}:** ${text}`)
            .join("\n\n")
        : stageSummary(lastStage);
    task.result = {
      approved: lastStage.status === "approved",
      summary,
      headSha: head,
      diffStat: await workspace.diffStat(workspace.baseSha, head),
      shortStat: await workspace.shortStat(workspace.baseSha, head),
      commits: await workspace.commitCount(workspace.baseSha, head),
      designDocPath: task.stages.find((stage) => stage.kind === "design")?.docPath,
      docPath: docStage?.docPath,
      docFormat: docStage?.docFormat,
      tests: testStage ? [...testStage.rounds].reverse().find((round) => round.review?.testRun)?.review?.testRun : undefined,
      unitTests: codingStage ? [...codingStage.rounds].reverse().find((round) => round.author?.unitTests)?.author?.unitTests : undefined,
      // Failures of the last run stay unresolved until a run passes, whatever the fixer answered.
      openComments:
        lastStage.kind === "testing"
          ? lastReview?.verdict === "approve"
            ? 0
            : (lastReview?.comments.length ?? 0)
          : (lastReview?.comments.filter((comment) => comment.status === "open").length ?? 0),
    };
    if (settings.cleanupWorktrees) {
      await workspace.removeWorktrees();
      for (const info of task.agents ?? []) {
        hooks.agent(info.role, (agent) => {
          agent.workspaceRemoved = true;
        });
      }
      hooks.emit({ type: "info", text: `Removed the agents' worktrees; the task branch ${workspace.taskBranch} and agent branches are kept.` });
    }
    task.phase = "done";
    hooks.emit({
      type: "info",
      text: task.result.approved
        ? lastStage.kind === "testing"
          ? "Workflow complete: all tests pass, verified by the test executor."
          : "Workflow complete: final version approved by the reviewer."
        : "Workflow complete without final approval.",
    });
    hooks.update();
  }
}

/** A test run that never started because its task was cancelled while it waited for another task's run. */
const CANCELLED_RUN: UnitTestRun = { passed: false, command: "", problem: "was cancelled", output: "", durationMs: 0, exitCode: null, stopped: "cancelled" };

/**
 * Environment of the manager's unit test runs: a per-task temp folder, no MSBuild nodes outliving the run, and the
 * worktree's own Python virtual environment and node_modules/.bin first on PATH, as if the agent had activated them.
 */
export function testRunEnv(worktree: string, tempDir: string): Record<string, string> {
  const env: Record<string, string> = { TMP: tempDir, TEMP: tempDir, TMPDIR: tempDir, MSBUILDDISABLENODEREUSE: "1" };
  const bins: string[] = [];
  const venv = [".venv", "venv"].map((name) => path.join(worktree, name)).find((dir) => fs.existsSync(path.join(dir, "pyvenv.cfg")));
  if (venv) {
    env.VIRTUAL_ENV = venv;
    bins.push(path.join(venv, process.platform === "win32" ? "Scripts" : "bin"));
  }
  const nodeBin = path.join(worktree, "node_modules", ".bin");
  if (fs.existsSync(nodeBin)) bins.push(nodeBin);
  if (bins.length) env.PATH = [...bins, process.env.PATH ?? ""].join(path.delimiter);
  return env;
}

export function assignmentFor(role: AgentRole, round: number, openComments: number, fromUser = false): string {
  const comments = `${openComments} review comment${openComments === 1 ? "" : "s"}`;
  if (fromUser) {
    switch (role) {
      case "designer":
        return `Revising the design for your change request (round ${round})`;
      case "writer":
        return `Revising the document for your change request (round ${round})`;
      case "coder":
      case "resolver":
      case "fixer":
        return `Making the changes you requested (round ${round})`;
    }
  }
  switch (role) {
    case "planner":
      return "Planning: deciding which sub-agents to create and what each should do";
    case "coder":
      return `Implementing the request (round ${round})`;
    case "resolver":
      return `Resolving ${comments} (round ${round})`;
    case "fixer":
      return `Fixing ${openComments} test failure${openComments === 1 ? "" : "s"} (round ${round})`;
    case "designer":
      return openComments ? `Revising the design for ${comments} (round ${round})` : `Writing the design (round ${round})`;
    case "writer":
      return openComments ? `Revising the document for ${comments} (round ${round})` : `Writing the document (round ${round})`;
    default:
      return `Reviewing round ${round}`;
  }
}

export function phaseLabel(stage: StageKind | undefined, phase: Phase): string {
  if (phase === "planning") return "Planning";
  if (phase === "verifying") return "Verifying unit tests";
  if (stage === "testing") {
    if (phase === "reviewing") return "Running tests";
    if (phase === "authoring" || phase === "revising") return "Fixing test failures";
  }
  const noun = stage === "design" ? "design" : stage === "document" ? "document" : "code";
  if (phase === "authoring") return stage === "design" ? "Designing" : stage === "document" ? "Writing" : "Coding";
  if (phase === "reviewing") return `Reviewing ${noun}`;
  if (phase === "revising") return stage === "coding" || !stage ? "Resolving review comments" : `Revising ${noun}`;
  if (phase === "preparing") return "Preparing workspace";
  if (phase === "finalizing") return "Finalizing";
  if (phase === "done") return "Done";
  return "Queued";
}

/** What a stage produced: the last author's summary; for testing, the executor's verdict plus the fixes. */
function stageSummary(stage: Stage): string {
  const lastAuthor = [...stage.rounds].reverse().find((round) => round.author)?.author;
  if (stage.kind !== "testing") return lastAuthor?.summary ?? "";
  const lastRun = [...stage.rounds].reverse().find((round) => round.review)?.review;
  return [lastRun?.summary ?? "", lastAuthor ? `Fixes: ${lastAuthor.summary}` : ""].filter(Boolean).join("\n\n");
}

/** "Passed: 12 tests" / "Failed: 2 of 12 (1 product-bug, 1 test-bug)" / "Blocked: ...". */
export function describeTestRun(run: TestRunInfo, failures: readonly ReviewComment[]): string {
  if (run.status === "passed") return `Passed${run.total !== undefined ? `: ${run.total} test${run.total === 1 ? "" : "s"}` : ""}${run.skipped ? `, ${run.skipped} skipped` : ""}`;
  const counts = new Map<string, number>();
  for (const failure of failures) counts.set(failure.category ?? "unknown", (counts.get(failure.category ?? "unknown") ?? 0) + 1);
  const breakdown = [...counts].map(([category, count]) => `${count} ${category}`).join(", ");
  if (run.status === "blocked") return `Blocked: ${truncate(failures[0]?.test ?? "the automation could not run", 120)}`;
  const failed = run.failed ?? failures.length;
  return `Failed: ${failed}${run.total !== undefined ? ` of ${run.total}` : ""} (${breakdown})`;
}

function describeComments(comments: readonly ReviewComment[]): string {
  if (!comments.length) return "no specific comments";
  const counts = new Map<string, number>();
  for (const comment of comments) counts.set(comment.severity, (counts.get(comment.severity) ?? 0) + 1);
  return `${comments.length} comment${comments.length === 1 ? "" : "s"} (${[...counts].map(([severity, count]) => `${count} ${severity}`).join(", ")})`;
}
