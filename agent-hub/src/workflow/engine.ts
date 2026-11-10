import {
  TurnTimeoutError,
  type AgentDriver,
  type AgentHandle,
  type AgentObserver,
  type CodeReviewTool,
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
  changePlannerPrompt,
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
import { findingsPrompt, finalPrompt, MAX_REVIEW_DIFF, nudgeFor, positionsPrompt, signoffPrompt, type ReviewTurnBase } from "../agents/reviewPrompts.ts";
import type { ResolvedReviewTarget } from "../review/target.ts";
import { evaluatePermission } from "../agents/policy.ts";
import { skillsForRole, type HubSkills } from "../context.ts";
import { DOC_EXTENSIONS, documentProblem, formatOfPath, isDocumentPath, placeholderProblem, renderDocTemplate, type DocTemplates } from "../docs.ts";
import type { AgentWorkspace, TaskWorkspace } from "../git.ts";
import {
  curate,
  defaultReviewBody,
  fallbackFinal,
  fallbackFindings,
  fallbackSignoff,
  nextCommentNumber,
  normalizeFinal,
  normalizeFindings,
  normalizePositions,
  normalizeSignoff,
  toFinalReview,
  type FinalInput,
  type FindingsInput,
  type PositionsInput,
  type SignoffInput,
} from "../review/discussion.ts";
import {
  authorRoleFor,
  CODE_REVIEW_ROLES,
  isCodeReview,
  isCodeReviewRole,
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
  type CodeReview,
  type DocumentSnapshot,
  type NewCommEntry,
  type NewTaskEvent,
  type Phase,
  type ReviewComment,
  type ReviewerComment,
  type ReviewerEntry,
  type ReviewPhase,
  type PlannedReview,
  type ReviewTarget,
  type ReviewRound,
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
  applyChangePlan,
  defaultChangeStage,
  describeChange,
  foldIntoPlan,
  normalizeChangePlan,
  pendingChangeRequests,
  STAGE_TITLES,
  type ChangeDecision,
} from "./changes.ts";
import {
  fallbackReview,
  fallbackTestRun,
  heuristicPlan,
  mergeWork,
  normalizePlan,
  normalizeReview,
  normalizeTestRun,
  normalizeWork,
  reviewRequestIn,
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
  /**
   * Code reviews the manager plans for Auto tasks: `resolve` finds the change to review (fetching a pull request);
   * `adopt` points the task at it (its branch, base and repository context) and returns the reviewers' workspace.
   */
  codeReviews?: {
    resolve(target: string, base?: string): Promise<ResolvedReviewTarget>;
    adopt(resolved: ResolvedReviewTarget): Promise<TaskWorkspace>;
  };
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
  /** Code review reviewers: the submit tool the current turn asks for (named in recovery prompts). */
  tool?: CodeReviewTool;
}

/** What a code review reviewer's current turn must submit, and how the submission is validated. */
interface ReviewStep {
  tool: CodeReviewTool;
  normalize: (input: unknown) => unknown;
}

const REVIEW_TOOLS: Record<ReviewPhase, CodeReviewTool> = {
  findings: "submit_findings",
  positions: "submit_positions",
  final: "submit_final_review",
  signoff: "submit_signoff",
};
const REVIEW_PHASES: Record<ReviewPhase, Phase> = { findings: "reviewing", positions: "discussing", final: "consolidating", signoff: "consolidating" };
const COMMENT_PREFIXES: Partial<Record<AgentRole, string>> = { "lead-reviewer": "L", "peer-reviewer": "P" };

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
  /** Commands that failed once and passed when run again. */
  flaky?: string[];
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

export function modelFor(task: Pick<Task, "authorModel" | "reviewerModel" | "resolverModel" | "managerModel" | "peerReviewerModel">, role: AgentRole): string {
  if (role === "planner") return task.managerModel || task.authorModel;
  if (role === "peer-reviewer") return task.peerReviewerModel || task.authorModel;
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
  /** Code review reviewers work in parallel: what each one's current turn must submit, and what it submitted. */
  private readonly reviewSteps = new Map<AgentRole, ReviewStep>();
  private readonly reviewSubmissions = new Map<AgentRole, unknown>();
  /** The change a planned code review reviews, found when the planner submitted its plan. */
  private plannedReview: ResolvedReviewTarget | null = null;
  /** The request reads as a review of a named change, but also asks for more: the planner must confirm a non-review plan. */
  private reviewRequest: { target: string; base?: string } | null = null;
  private reviewRequestChallenged = false;
  /** While the manager re-plans the task for change requests: its validated decision once the planner submits. */
  private replanning = false;
  private pendingChange: ChangeDecision | null = null;

  constructor(task: Task, options: EngineOptions) {
    this.task = task;
    this.options = options;
  }

  async run(): Promise<void> {
    if (this.task.kind === "auto" && !this.task.plan) await this.plan();
    else if (pendingChangeRequests(this.task).length) await this.replan();
    // A Code review task, or an Auto task the manager planned as a code review: the two reviewers, no stages.
    if (isCodeReview(this.task)) {
      await this.runCodeReview();
      return;
    }
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
   * stages (and so which sub-agents) to create, with an assignment for each. A request that names a pull
   * request or branch to review, and asks for nothing else, goes straight to the two code reviewers.
   */
  private async plan(): Promise<void> {
    const { hooks, workspace } = this.options;
    const task = this.task;
    const role: AgentRole = "planner";
    const reviewRequest = this.options.codeReviews ? reviewRequestIn(task.description) : null;
    // With change requests waiting, the planner reads them all before anything is decided.
    if (reviewRequest?.direct && !pendingChangeRequests(task).length) {
      await this.assignReview(reviewRequest);
      return;
    }
    this.reviewRequest = reviewRequest;
    this.reviewRequestChallenged = false;
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
      this.plannedReview = null;
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
      let resolved: ResolvedReviewTarget | null = plan ? this.plannedReview : null;
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
      if (plan.review) {
        // A code review: the hub fetches the change, and the task becomes that review (the two reviewers, no stages).
        if (!resolved) {
          try {
            resolved = await this.resolvePlannedReview(plan.review);
          } catch (error) {
            throw new Error(`The request asks to review ${plan.review.target}, but the hub cannot find it: ${errorMessage(error)}`);
          }
        }
        this.options.workspace = await this.options.codeReviews!.adopt(resolved);
      }
      task.plan = {
        stages: plan.stages,
        rationale: plan.rationale,
        instructions: plan.instructions,
        briefing: plan.briefing,
        ...(plan.review ? { review: plan.review } : {}),
        fallback: fallback || undefined,
        plannedAt: nowIso(),
      };
      task.stages = plan.stages.map((kind) => ({ kind, status: "pending", rounds: [], nextCommentNumber: 1 }));
      this.announcePlan(role);
      const early = pendingChangeRequests(task);
      if (early.length) foldIntoPlan(task, early, nowIso());
    } catch (error) {
      status = hooks.signal.aborted || error instanceof CancelledError ? "cancelled" : "failed";
      throw error;
    } finally {
      await this.releaseAgent(role, status);
      hooks.update();
    }
  }

  /**
   * The request names a pull request or branch to review and asks for nothing else: no planning is needed. The
   * manager fetches the change and assigns the lead and the peer reviewer; the task becomes that code review.
   */
  private async assignReview(request: { target: string; base?: string }): Promise<void> {
    const { hooks } = this.options;
    const task = this.task;
    this.setPhase(undefined, "planning", 0);
    hooks.comm({
      from: "manager",
      to: "manager",
      kind: "lifecycle",
      text: `The request asks to review ${request.target}: fetching it and assigning the code review team (no planning needed)`,
    });
    const review: PlannedReview = { target: request.target, ...(request.base ? { base: request.base } : {}) };
    let resolved: ResolvedReviewTarget;
    try {
      resolved = await this.resolvePlannedReview(review);
    } catch (error) {
      throw new Error(`The request asks to review ${request.target}, but the hub cannot find it: ${errorMessage(error)}`);
    }
    this.throwIfAborted();
    this.options.workspace = await this.options.codeReviews!.adopt(resolved);
    task.plan = {
      stages: [],
      rationale: `The request asks to review ${reviewedChange(resolved.target)}, so the manager assigned the code review team directly: a lead and a peer reviewer review the change independently, discuss each other's findings and agree on the final review for you to curate and publish.`,
      instructions: {},
      review,
      direct: true,
      plannedAt: nowIso(),
    };
    task.stages = [];
    this.announcePlan("manager");
    const early = pendingChangeRequests(task);
    if (early.length) foldIntoPlan(task, early, nowIso());
    hooks.update();
  }

  /** Reports the plan: the timeline, the manager's log and the sub-agents it creates. */
  private announcePlan(from: AgentRole | "manager"): void {
    const { hooks } = this.options;
    const task = this.task;
    const plan = task.plan!;
    const flow = task.review ? `Code review of ${reviewedChange(task.review.target)}` : plan.stages.map((kind) => STAGE_LABELS[kind]).join(" → ");
    hooks.emit({ type: "info", ...(from === "manager" ? {} : { role: from }), text: `Manager's plan: ${flow}. ${plan.rationale}`, data: { plan } });
    hooks.comm({ from, to: "manager", kind: "plan", text: `Plan: ${flow} - ${truncate(plan.rationale, 240)}` });
    // The resolver and the fixer only start when a review requests changes or a test run fails.
    const team = task.review ? [...CODE_REVIEW_ROLES] : rolesForStages(plan.stages);
    const onDemand: AgentRole[] = team.filter((candidate) => candidate === "resolver" || candidate === "fixer");
    hooks.comm({
      from: "manager",
      to: "manager",
      kind: "lifecycle",
      text: `Creating sub-agents: ${team.filter((candidate) => !onDemand.includes(candidate)).map((candidate) => ROLE_LABELS[candidate]).join(", ")}${onDemand.length ? `; on demand: ${onDemand.map((candidate) => ROLE_LABELS[candidate]).join(", ")}` : ""}`,
    });
  }

  private stage(kind: StageKind): Stage {
    const stage = this.task.stages.find((candidate) => candidate.kind === kind);
    if (!stage) throw new Error(`Stage ${kind} missing`);
    return stage;
  }

  /**
   * The manager re-evaluates the task for the user's change requests: its planner reads where the task stands and the
   * requests, then decides which teams handle them - the stage that revises its work, new stages (e.g. coding for a
   * finished design), unfinished stages the requests make unnecessary - and the task type follows its stages. When it
   * cannot (the planner fails or never submits), the requests go to the latest stage that has work.
   */
  private async replan(): Promise<void> {
    const { hooks, workspace } = this.options;
    const task = this.task;
    const requests = pendingChangeRequests(task);
    const ids = requests.map((request) => request.id).join(", ");
    const role: AgentRole = "planner";
    this.setPhase(undefined, "planning", 0);
    hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", text: `Re-evaluating the task for change request ${ids}: which teams handle it` });
    let status: AgentStatus = "done";
    let problem = "";
    this.pendingChange = null;
    try {
      const head = await workspace.taskHead();
      const ws = await workspace.prepareReviewer(role, head);
      const agent = await this.agentFor(role, undefined, ws.path);
      hooks.agent(role, (info) => {
        info.status = "working";
        info.workspace = ws.path;
        info.workspaceRemoved = false;
        info.branch = null;
        info.assignment = `Re-evaluating the task for change request ${ids}`;
      });
      hooks.comm({ from: "manager", to: role, kind: "assign", text: `Re-plan the task for change request ${ids}: decide which teams handle it and write their assignments` });
      const prompt = changePlannerPrompt(task, requests, task.context, {
        head,
        commits: await workspace.commitCount(workspace.baseSha, head),
        shortStat: await workspace.shortStat(workspace.baseSha, head),
      });
      this.replanning = true;
      let result: TurnResult = {};
      try {
        result = await this.send(agent, prompt, async () => prompt);
        for (let nudge = 0; !this.submittedChange() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
          this.throwIfAborted();
          hooks.emit({ type: "warning", role, text: "Planner ended its turn without calling submit_plan; asking it to submit." });
          hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_plan - submit the plan" });
          result = await this.send(agent, NUDGE_PLAN);
        }
      } catch (error) {
        // The manager can still route the requests without its planner: to the latest stage.
        if (!(error instanceof AgentUnrecoverableError)) throw error;
        problem = `the planner could not be recovered: ${error.reason}`;
        status = "failed";
      }
      this.throwIfAborted();
      if (!this.submittedChange() && !problem) problem = `the planner never called submit_plan; last message: ${truncate(firstLine(result.lastMessage ?? ""), 200) || "none"}`;
    } catch (error) {
      status = hooks.signal.aborted || error instanceof CancelledError ? "cancelled" : "failed";
      throw error;
    } finally {
      this.replanning = false;
      await this.releaseAgent(role, status);
    }

    let decision = this.submittedChange();
    if (!decision) {
      const target = defaultChangeStage(task);
      decision = {
        stages: stageKindsOf(task),
        ...(target ? { changeStage: target } : {}),
        instructions: {},
        rationale: `The manager could not re-plan the task (${problem}), so the change goes to the ${target ? `${STAGE_TITLES[target]} stage` : "remaining stages"}.`,
        routing: "manager",
        fallback: true,
      };
      hooks.emit({ type: "warning", text: decision.rationale });
    }
    const applied = applyChangePlan(task, requests, decision, nowIso());
    const flow = describeChange(applied);
    hooks.emit({
      type: "info",
      ...(decision.fallback ? {} : { role }),
      text: `Manager's re-plan for ${ids}: ${flow}. ${decision.fallback ? "" : decision.rationale}`.trim(),
      data: { changePlan: requests[0]?.plan },
    });
    hooks.comm({ from: decision.fallback ? "manager" : role, to: "manager", kind: "plan", text: `Re-plan for ${ids}: ${flow} - ${truncate(decision.rationale, 240)}` });
    if (applied.added.length) {
      const team = rolesForStages(applied.added);
      const onDemand: AgentRole[] = team.filter((candidate) => candidate === "resolver" || candidate === "fixer");
      hooks.comm({
        from: "manager",
        to: "manager",
        kind: "lifecycle",
        text: `Creating sub-agents: ${team.filter((candidate) => !onDemand.includes(candidate)).map((candidate) => ROLE_LABELS[candidate]).join(", ")}${onDemand.length ? `; on demand: ${onDemand.map((candidate) => ROLE_LABELS[candidate]).join(", ")}` : ""}`,
      });
    }
    hooks.update();
  }

  // ---- Code review tasks -------------------------------------------------------------------------

  /**
   * Two reviewers, usually on different models, review someone else's change: each reviews it on its own (in
   * parallel), then each responds to the other's comments and revises its own (in parallel), then the lead
   * reviewer writes the final review and the peer reviewer signs off on it or objects - the lead revises until
   * the peer agrees or the round budget runs out. Every step is recorded, so a retry resumes where it stopped.
   */
  private async runCodeReview(): Promise<void> {
    const { hooks, workspace } = this.options;
    const task = this.task;
    const review = task.review;
    if (!review) throw new Error("This code review task has no change to review; create it again.");
    const head = review.target.headSha;
    const base = workspace.baseSha;
    review.files ??= await workspace.numstat(base, head);
    review.shortStat ??= await workspace.shortStat(base, head);
    review.commits ??= await workspace.commitCount(base, head);
    const change = { stat: await workspace.diffStat(base, head), diff: await workspace.diff(base, head, MAX_REVIEW_DIFF) };
    const what = reviewedChange(review.target);
    hooks.comm({
      from: "manager",
      to: "manager",
      kind: "lifecycle",
      text: `Code review of ${what} (${review.shortStat || "no changes"}): ${ROLE_LABELS["lead-reviewer"]} on ${modelFor(task, "lead-reviewer")} and ${ROLE_LABELS["peer-reviewer"]} on ${modelFor(task, "peer-reviewer")} review it independently, discuss each other's findings, then agree on the final review`,
    });
    hooks.update();

    const budget = Math.max(1, task.roundsBudget ?? task.maxRounds);
    let status: AgentStatus = "done";
    try {
      for (const phase of ["findings", "positions"] as const) {
        const round = review.rounds.find((candidate) => candidate.phase === phase) ?? this.openReviewRound(review, phase);
        const missing = CODE_REVIEW_ROLES.filter((role) => !round.entries.some((entry) => entry.role === role));
        if (!missing.length) continue;
        this.setPhase(undefined, REVIEW_PHASES[phase], round.n);
        // Both reviewers work at the same time; a reviewer that finished keeps its entry when the other fails.
        const results = await Promise.allSettled(missing.map((role) => this.codeReviewTurn(role, round, change)));
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      }
      let finals = review.rounds.filter((round) => round.phase === "final" && round.attempt === task.attempt && round.entries.length).length;
      for (;;) {
        this.throwIfAborted();
        const last = review.rounds.at(-1)!;
        if (last.phase === "final" && last.entries.length) {
          const round = this.openReviewRound(review, "signoff");
          this.setPhase(undefined, REVIEW_PHASES.signoff, round.n);
          await this.codeReviewTurn("peer-reviewer", round, change);
          continue;
        }
        if (last.phase === "signoff" && last.entries.length) {
          const signoff = last.entries[0]!.signoff!;
          if (signoff.agreed || !signoff.objections.length) break;
          if (finals >= budget) {
            const text = `The peer reviewer still objects after ${finals} final review round(s); its objections are shown with the comments for you to decide.`;
            hooks.emit({ type: "warning", round: last.n, text });
            hooks.comm({ from: "manager", to: "manager", kind: "lifecycle", round: last.n, text });
            break;
          }
        }
        const unfinishedSignoff = last.phase === "signoff" && !last.entries.length;
        const round = unfinishedSignoff ? last : this.openReviewRound(review, "final");
        const role: AgentRole = unfinishedSignoff ? "peer-reviewer" : "lead-reviewer";
        this.setPhase(undefined, REVIEW_PHASES[round.phase], round.n);
        await this.codeReviewTurn(role, round, change);
        if (!unfinishedSignoff) finals++;
      }
    } catch (error) {
      status = hooks.signal.aborted || error instanceof CancelledError ? "cancelled" : "failed";
      throw error;
    } finally {
      for (const role of CODE_REVIEW_ROLES) await this.releaseAgent(role, status);
      hooks.update();
    }
    await this.finalizeCodeReview();
  }

  /** The round a step runs in: the last round when it is that step and unfinished, otherwise a new one. */
  private openReviewRound(review: CodeReview, phase: ReviewPhase): ReviewRound {
    const last = review.rounds.at(-1);
    if (last?.phase === phase && !last.entries.length) return last;
    const round: ReviewRound = { n: review.rounds.length + 1, phase, attempt: this.task.attempt, startedAt: nowIso(), entries: [] };
    review.rounds.push(round);
    return round;
  }

  /** One reviewer's turn in a discussion round: prompt, wait for its submit tool (nudging it), record the result. */
  private async codeReviewTurn(role: AgentRole, round: ReviewRound, change: ReviewTurnBase["change"]): Promise<void> {
    const { hooks, workspace } = this.options;
    const task = this.task;
    const review = task.review!;
    const phase = round.phase;
    const tool = REVIEW_TOOLS[phase];
    const prefix = COMMENT_PREFIXES[role]!;
    const otherRole: AgentRole = role === "lead-reviewer" ? "peer-reviewer" : "lead-reviewer";
    const otherPrefix = COMMENT_PREFIXES[otherRole]!;
    const ws = await workspace.prepareReviewer(role, review.target.headSha);
    const fresh = !this.agents.has(role);
    const agent = await this.agentFor(role, undefined, ws.path);
    agent.tool = tool;
    // What the reviewer is shown, fixed for the turn: the other reviewer may change its comments meanwhile.
    const own = review.comments.filter((comment) => comment.id.startsWith(prefix) && !comment.withdrawn);
    const theirs = review.comments.filter((comment) => comment.id.startsWith(otherPrefix) && !comment.withdrawn);
    const previousFinal = [...review.rounds].reverse().find((candidate) => candidate.n < round.n && candidate.phase === "final" && candidate.entries.length)?.entries[0]?.final;
    const lastSignoff = [...review.rounds].reverse().find((candidate) => candidate.n < round.n && candidate.phase === "signoff" && candidate.entries.length)?.entries[0]?.signoff;
    const objecting = phase === "final" && previousFinal && lastSignoff && !lastSignoff.agreed ? lastSignoff : undefined;

    const assignment =
      phase === "findings"
        ? `Reviewing the change independently (round ${round.n})`
        : phase === "positions"
          ? `Discussing the ${ROLE_LABELS[otherRole].toLowerCase()}'s ${theirs.length} comment(s) (round ${round.n})`
          : phase === "final"
            ? objecting
              ? `Revising the final review for ${objecting.objections.length} objection(s) (round ${round.n})`
              : `Writing the final review (round ${round.n})`
            : `Checking the final review (round ${round.n})`;
    hooks.agent(role, (info) => {
      info.status = "working";
      info.workspace = ws.path;
      info.workspaceRemoved = false;
      info.branch = null;
      info.assignment = assignment;
      if (!info.rounds.includes(round.n)) info.rounds.push(round.n);
    });
    hooks.comm({
      from: "manager",
      to: role,
      kind: phase === "findings" ? "assign" : "relay",
      round: round.n,
      text:
        phase === "findings"
          ? `Review ${reviewedChange(review.target)} at ${review.target.headSha.slice(0, 10)} independently`
          : phase === "positions"
            ? `Respond to the ${ROLE_LABELS[otherRole].toLowerCase()}'s comments${theirs.length ? ` ${theirs.map((comment) => comment.id).join(", ")}` : " (none)"} and re-check your own`
            : phase === "final"
              ? objecting
                ? `The ${ROLE_LABELS[otherRole].toLowerCase()} objects (${objecting.objections.length}); revise the final review`
                : `Write the final review from ${review.comments.length} comment(s) and the discussion`
              : `Sign off on the final review (${previousFinal?.comments.length ?? 0} comment(s)) or object`,
    });

    const known = review.comments.map((comment) => comment.id);
    const normalize: (input: unknown) => unknown =
      phase === "findings"
        ? normalizeFindings
        : phase === "positions"
          ? (input) => normalizePositions(input, theirs.map((comment) => comment.id), own.map((comment) => comment.id))
          : phase === "final"
            ? (input) => normalizeFinal(input, review.comments.filter((comment) => !comment.withdrawn).map((comment) => comment.id), known)
            : (input) => normalizeSignoff(input, [...(previousFinal?.comments.map((comment) => comment.id) ?? []), ...known]);
    const base = (includeContext: boolean): ReviewTurnBase => ({
      task,
      role,
      context: task.context,
      includeContext,
      round: round.n,
      change,
      otherModel: modelFor(task, otherRole),
    });
    const build = async (includeContext: boolean): Promise<string> => {
      switch (phase) {
        case "findings":
          return findingsPrompt(base(includeContext));
        case "positions": {
          const theirEntry = review.rounds.find((candidate) => candidate.phase === "findings")?.entries.find((entry) => entry.role === otherRole);
          return positionsPrompt({ ...base(includeContext), own, theirs, theirEntry });
        }
        case "final":
          return finalPrompt({ ...base(includeContext), review, previous: objecting ? previousFinal : undefined, signoff: objecting });
        case "signoff":
          return signoffPrompt({ ...base(includeContext), review, final: previousFinal! });
      }
    };

    this.reviewSubmissions.delete(role);
    this.reviewSteps.set(role, { tool, normalize });
    let result: TurnResult;
    try {
      result = await this.send(agent, await build(fresh), () => build(true));
      for (let nudge = 0; !this.reviewSubmissions.has(role) && nudge < MAX_SUBMIT_NUDGES; nudge++) {
        this.throwIfAborted();
        hooks.emit({ type: "warning", role, round: round.n, text: `${ROLE_LABELS[role]} ended its turn without calling ${tool}; asking it to submit.` });
        hooks.comm({ from: "manager", to: role, kind: "nudge", round: round.n, text: `Your turn ended without ${tool} - submit it` });
        result = await this.send(agent, nudgeFor(tool));
      }
    } finally {
      this.reviewSteps.delete(role);
    }
    const submitted = this.reviewSubmissions.get(role);
    this.reviewSubmissions.delete(role);
    const fallback = submitted === undefined;
    if (fallback) hooks.emit({ type: "warning", role, round: round.n, text: `${ROLE_LABELS[role]} never called ${tool}; the hub derived its result.` });
    const at = nowIso();
    const label = ROLE_LABELS[role];
    let entry: ReviewerEntry;
    let summary: string;
    switch (phase) {
      case "findings": {
        const input = (submitted as FindingsInput | undefined) ?? fallbackFindings(result.lastMessage);
        const ids = this.addReviewerComments(review, prefix, input.comments, round.n);
        entry = { role, summary: input.assessment, changeSummary: input.changeSummary, verdict: input.verdict, comments: ids, at };
        summary = `${label}'s independent review: ${ids.length} comment(s), verdict ${input.verdict.replace("_", " ")}`;
        break;
      }
      case "positions": {
        const input = (submitted as PositionsInput | undefined) ?? { summary: "The reviewer did not respond to the other review.", responses: [], updates: [], newComments: [] };
        for (const update of input.updates) {
          const comment = review.comments.find((candidate) => candidate.id === update.commentId);
          if (!comment) continue;
          if (update.action === "withdraw") {
            comment.withdrawn = { note: update.note, round: round.n };
          } else {
            comment.revised = { note: update.note, round: round.n, previous: { body: comment.body, severity: comment.severity, line: comment.line } };
            if (update.body) comment.body = update.body;
            if (update.severity) comment.severity = update.severity;
            if (update.line) comment.line = update.line;
          }
        }
        const ids = this.addReviewerComments(review, prefix, input.newComments, round.n);
        entry = {
          role,
          summary: input.summary,
          positions: input.responses,
          updates: input.updates.map(({ commentId, action, note }) => ({ commentId, action, note })),
          comments: ids,
          at,
        };
        const count = (position: string) => input.responses.filter((response) => response.position === position).length;
        const withdrawn = input.updates.filter((update) => update.action === "withdraw").length;
        const revised = input.updates.length - withdrawn;
        summary = `${label} on the ${ROLE_LABELS[otherRole].toLowerCase()}'s comments: ${count("agree")} agree, ${count("disagree")} disagree, ${count("refine")} refine${withdrawn ? `; withdrew ${withdrawn}` : ""}${revised ? `; revised ${revised}` : ""}${ids.length ? `; ${ids.length} new` : ""}`;
        break;
      }
      case "final": {
        const leadSummary = review.rounds.find((candidate) => candidate.phase === "findings")?.entries.find((candidate) => candidate.role === "lead-reviewer")?.changeSummary;
        const input = (submitted as FinalInput | undefined) ?? fallbackFinal(review, leadSummary);
        const final = toFinalReview(input, fallback);
        review.final = final;
        entry = { role, summary: final.assessment, final, at };
        summary = `Final review: ${final.comments.length} comment(s)${describeSeverities(final.comments)}, ${final.dropped.length} dropped, verdict ${final.verdict.replace("_", " ")}`;
        break;
      }
      case "signoff": {
        const signoff = (submitted as SignoffInput | undefined) ? { ...(submitted as SignoffInput) } : fallbackSignoff();
        review.signoff = signoff;
        entry = { role, summary: signoff.summary, signoff, at };
        summary = signoff.agreed
          ? `${label} signed off on the final review`
          : signoff.fallback
            ? `${label} did not sign off`
            : `${label} objects to the final review (${signoff.objections.length}): ${truncate(signoff.objections.map((objection) => `${objection.commentId ? `${objection.commentId}: ` : ""}${objection.issue}`).join("; "), 300)}`;
        break;
      }
    }
    if (fallback) entry.fallback = true;
    round.entries.push(entry);
    hooks.agent(role, (info) => {
      info.status = "idle";
      info.assignment = undefined;
    });
    hooks.emit({ type: "review", role, round: round.n, text: `${summary} - ${truncate(firstLine(entry.summary), 300)}`, data: { phase, fallback } });
    hooks.comm({ from: role, to: "manager", kind: phase === "signoff" || phase === "final" ? "verdict" : "submit", round: round.n, text: summary });
    hooks.update();
  }

  private addReviewerComments(review: CodeReview, prefix: string, comments: readonly Omit<ReviewerComment, "id" | "round">[], round: number): string[] {
    let next = nextCommentNumber(review.comments, prefix);
    return comments.map((comment) => {
      const id = `${prefix}${next++}`;
      review.comments.push({ id, severity: comment.severity, file: comment.file, line: comment.line, body: comment.body, round });
      return id;
    });
  }

  /** Turns the agreed final review into the user's working copy and the task's result. */
  private async finalizeCodeReview(): Promise<void> {
    const { workspace, hooks, settings } = this.options;
    const task = this.task;
    const review = task.review!;
    this.setPhase(undefined, "finalizing", task.currentRound);
    const finalIndex = review.rounds.findLastIndex((round) => round.phase === "final" && round.entries.length);
    const final = review.rounds[finalIndex]?.entries[0]?.final;
    if (!final) throw new Error("The reviewers produced no final review.");
    const signoff = review.rounds.slice(finalIndex + 1).findLast((round) => round.phase === "signoff" && round.entries.length)?.entries[0]?.signoff;
    review.final = final;
    review.signoff = signoff;
    review.curated = curate(final, signoff);
    review.body = defaultReviewBody(final);
    review.event ??= "COMMENT";
    const head = review.target.headSha;
    task.result = {
      approved: signoff?.agreed === true,
      summary: final.changeSummary || final.assessment,
      headSha: head,
      diffStat: await workspace.diffStat(workspace.baseSha, head),
      shortStat: review.shortStat,
      commits: review.commits,
      openComments: review.curated.length,
    };
    if (settings.cleanupWorktrees) {
      await workspace.removeWorktrees();
      for (const info of task.agents ?? []) {
        hooks.agent(info.role, (agent) => {
          agent.workspaceRemoved = true;
        });
      }
    }
    task.phase = "done";
    const objections = signoff && !signoff.agreed ? signoff.objections.length : 0;
    hooks.emit({
      type: "info",
      text: `Code review complete: ${final.comments.length} comment(s)${describeSeverities(final.comments)}; ${
        signoff?.agreed ? "both reviewers agree on the final review" : objections ? `the peer reviewer still objects to ${objections} item(s)` : "the peer reviewer did not sign off"
      }. Review the comments, then publish them.`,
    });
    hooks.update();
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
    if (lastReview?.by === "user") {
      // The user's request came after review comments nobody resolved yet (the task stopped): they are resolved too.
      const reviewed = [...stage.rounds].reverse().find((round) => round !== last && round.review && round.review.by !== "user");
      const unresolved = reviewed?.review?.verdict === "request_changes" ? reviewed.review.comments.filter((comment) => comment.status === "open") : [];
      open = [...unresolved, ...open];
    }
    // An earlier stage changed for a change request: run the tests again before fixing anything (a request round
    // waiting in this stage is handled first: its fixer's round is re-run and verified anyway).
    if (testing && stage.rerun && !reviewOnly && lastReview?.by !== "user") {
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
    if (role === "planner") return { kind: "plan", onSubmit: (input) => this.acceptPlan(input) };
    if (role === "executor") return { kind: "test", onSubmit: (input) => void (this.pendingTest = normalizeTestRun(input)) };
    if (isCodeReviewRole(role)) {
      return {
        kind: "code-review",
        tools: role === "lead-reviewer" ? ["submit_findings", "submit_positions", "submit_final_review"] : ["submit_findings", "submit_positions", "submit_signoff"],
        onSubmit: (tool, input) => {
          const step = this.reviewSteps.get(role);
          if (!step) throw new Error("No submission is expected from you right now.");
          if (step.tool !== tool) throw new Error(`This turn asks for \`${step.tool}\`, not \`${tool}\`. Call \`${step.tool}\`.`);
          this.reviewSubmissions.set(role, step.normalize(input));
        },
      };
    }
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

  /**
   * Validates the planner's plan. A planned code review must name a change the hub can find, so the hub fetches it
   * now: a wrong pull request or branch goes back to the planner to fix.
   */
  private async acceptPlan(input: PlanSubmissionInput): Promise<void> {
    if (this.replanning) {
      this.pendingChange = normalizeChangePlan(input, this.task);
      return;
    }
    const plan = normalizePlan(input);
    // A request that reads as a review goes to the review team unless the planner, told so, confirms otherwise.
    const request = this.reviewRequest;
    if (request && !plan.review && !this.reviewRequestChallenged) {
      this.reviewRequestChallenged = true;
      throw new Error(
        `The request reads as a request to review ${request.target}, an existing change. A code review goes to the review team: call submit_plan with stages ["review"], review_target "${request.target}" and the reviewers' focus in instructions.review - the reviewers read the change and comment on it; they do not change code or run tests. If the request really asks for changes rather than a review, call submit_plan again with your plan unchanged.`,
      );
    }
    let resolved: ResolvedReviewTarget | null = null;
    if (plan.review) {
      try {
        resolved = await this.resolvePlannedReview(plan.review);
      } catch (error) {
        throw new Error(
          `The hub cannot review '${plan.review.target}': ${errorMessage(error)}. Check \`review_target\` (and \`review_base\`) against the request and the repository (git branch -a, git remote -v), then call submit_plan again.`,
        );
      }
    }
    this.plannedReview = resolved;
    this.pendingPlan = plan;
  }

  private resolvePlannedReview(review: PlannedReview): Promise<ResolvedReviewTarget> {
    if (!this.options.codeReviews) return Promise.reject(new Error("this hub cannot run code reviews"));
    return this.options.codeReviews.resolve(review.target, review.base);
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
      message = restart ? await this.restartAgent(agent, problem) : recoveryPrompt(role, problem, agent.tool);
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
    if (isCodeReviewRole(role)) return this.reviewSubmissions.has(role);
    return isReviewerRole(role) ? this.pendingReview !== null : this.pendingWork !== null;
  }

  private async acceptWork(input: WorkSubmissionInput, stageKind: StageKind): Promise<void> {
    const normalized = normalizeWork(input, this.expectedCommentIds, { unitTests: stageKind === "coding", partialResponses: this.partialResponses });
    if (isDocStage(stageKind)) {
      const stage = this.stage(stageKind);
      const ws = this.currentAuthorWorkspace;
      const content = await ws?.readFile(stage.docPath!);
      const problem = documentProblem(content, stage.docFormat ?? "markdown", this.seededDoc);
      if (problem) {
        throw new Error(`The document '${stage.docPath}' ${problem}. Fix the file at that exact path, then call submit_work again.`);
      }
      // Further HTML documents written this round must not keep template placeholders.
      for (const file of ws ? await ws.changedPaths() : []) {
        if (file === stage.docPath || formatOfPath(file) !== "html" || !isDocumentPath(file)) continue;
        const extra = await ws!.readFile(file);
        if (extra === null) continue;
        const extraProblem = placeholderProblem(extra);
        if (extraProblem) throw new Error(`The document '${file}' ${extraProblem}. Fix it (or remove the file if it is not needed), then call submit_work again.`);
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
      const unrelated = report?.unrelated_failures?.length ? { unrelatedFailures: report.unrelated_failures } : {};
      if (report?.status === "blocked") {
        hooks.emit({ type: "warning", role, text: `${label} reports that the unit tests cannot pass (${truncate(report.reason ?? "", 400)}); the reviewer weighs the reason.` });
        return { submission: current, unitTests: { status: "blocked", commands: report.commands, ...counts, ...unrelated, reason: report.reason, fixAttempts: attempt } };
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
        ...unrelated,
        verified: run.passed,
        fixAttempts: attempt,
        ...(run.flaky?.length ? { flaky: run.flaky } : {}),
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        stopped: run.stopped,
        logExcerpt: run.passed ? undefined : run.output.slice(-6000) || undefined,
      };
      const list = commands.map((command) => `\`${command}\``).join(", ");
      if (run.passed) {
        const left = report?.unrelated_failures?.length ? `; ${plural(report.unrelated_failures.length, "failing test")} unrelated to the change left for their owners` : "";
        hooks.emit({ type: "info", text: `Unit tests pass: ${list} (${Math.round(run.durationMs / 1000)} s)${left}. Round ${round.n} goes to review.` });
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
    const freshTempDir = async () => {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      await fsp.mkdir(tempDir, { recursive: true });
    };
    await freshTempDir();
    const env = testRunEnv(ws.path, tempDir);
    const before = await ws.changedPaths();
    const discarded = new Set<string>();
    const flaky: string[] = [];
    let durationMs = 0;
    const run = async (command: string) => {
      const result = await runCommand(command, {
        cwd: ws.path,
        timeoutMs: settings.turnTimeoutMinutes * 60_000,
        silenceMs: settings.stuckAgentMinutes * 60_000,
        signal: hooks.signal,
        env,
      });
      durationMs += result.durationMs;
      return result;
    };
    try {
      for (const command of commands) {
        // The hub runs what the agent reported, so the agent's own command restrictions (no push, no global installs) apply.
        const policy = evaluatePermission({ kind: "shell", fullCommandText: command }, { readOnly: false, workingDirectory: ws.path });
        if (policy.kind === "reject") return { passed: false, command, problem: `was not run: ${policy.feedback}`, output: "", durationMs, exitCode: null, flaky };
        hooks.emit({ type: "info", text: `Running the unit tests to verify them before review: ${command}` });
        let result = await run(command);
        let again = false;
        if (!result.stopped && result.exitCode !== 0) {
          // Flaky tests must not send the agent into fix cycles: run the command once more from a clean state first.
          hooks.emit({ type: "info", text: `\`${command}\` exited with code ${result.exitCode}; running it again to rule out a flaky test.` });
          for (const file of await ws.discardChangesSince(before)) discarded.add(file);
          await freshTempDir();
          const retry = await run(command);
          if (!retry.stopped && retry.exitCode === 0) {
            flaky.push(command);
            hooks.emit({ type: "warning", text: `\`${command}\` passed when run again: a flaky test, so it is not sent back to the agent. The reviewer is told.` });
            continue;
          }
          result = retry;
          again = true;
        }
        if (result.stopped || result.exitCode !== 0) {
          const problem =
            result.stopped === "silent"
              ? `printed nothing for ${settings.stuckAgentMinutes} min and was stopped (a test probably hangs)`
              : result.stopped === "timeout"
                ? `ran longer than ${settings.turnTimeoutMinutes} min and was stopped`
                : result.stopped === "cancelled"
                  ? "was cancelled"
                  : `exited with code ${result.exitCode} after ${Math.round(result.durationMs / 1000)} s${again ? ", twice in a row" : ""}`;
          return { passed: false, command, problem, output: result.output, durationMs, exitCode: result.exitCode, stopped: result.stopped, flaky };
        }
      }
      return { passed: true, command: commands.at(-1)!, problem: "", output: "", durationMs, exitCode: 0, flaky };
    } finally {
      for (const file of await ws.discardChangesSince(before)) discarded.add(file);
      if (discarded.size) hooks.emit({ type: "info", text: `Discarded ${discarded.size} file(s) the test run created or changed: ${truncate([...discarded].join(", "), 300)}` });
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

  private submittedChange(): ChangeDecision | null {
    return this.pendingChange;
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
      ...(input.unrelated_failures?.length ? { unrelatedFailures: input.unrelated_failures } : {}),
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
    const documents = isDocStage(stage.kind) ? await this.snapshotDocuments(stage, round, docSnapshot, startHead, commit) : undefined;
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
      ...(documents?.length ? { documents } : {}),
      unitTests,
      at: nowIso(),
    };
  }

  /**
   * The documents a document-stage round wrote: the deliverable plus any further documents the author created or
   * changed next to it (a request can call for several). Each is saved as it stands after the round.
   */
  private async snapshotDocuments(stage: Stage, round: Round, docSnapshot: string | undefined, startHead: string, commit: string | null): Promise<DocumentSnapshot[]> {
    const { workspace, hooks } = this.options;
    const documents: DocumentSnapshot[] = docSnapshot && stage.docPath ? [{ path: stage.docPath, snapshot: docSnapshot }] : [];
    if (!commit) return documents;
    const extra = (await workspace.changedPaths(startHead, commit)).filter((file) => isDocumentPath(file) && file !== stage.docPath).slice(0, 30);
    for (const [index, file] of extra.entries()) {
      const content = await workspace.readAt(commit, file);
      if (content === null) continue;
      const snapshot = `doc-r${round.n}-${index + 1}${DOC_EXTENSIONS[formatOfPath(file)]}`;
      await hooks.saveArtifact(snapshot, content);
      documents.push({ path: file, snapshot });
    }
    if (extra.length) {
      stage.extraDocs = [...new Set([...(stage.extraDocs ?? []), ...extra])];
      hooks.emit({ type: "info", stage: stage.kind, round: round.n, text: `Round ${round.n} also wrote ${extra.length} further document(s): ${extra.join(", ")}` });
    }
    return documents;
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
    const previousRun = stage.rounds.find((candidate) => candidate.n === round.n - 1)?.review;
    // After a user's request round, the fixer's changes are checked since the last test run, including any work the
    // task stopped before it was verified.
    const verified = previousRun?.by === "user" ? this.lastReviewBefore(stage, round.n - 1) : undefined;
    const fixBase = verified?.review?.reviewedSha ?? fix?.prevCommit ?? workspace.baseSha;
    const fixDiff = fix?.commit ? await workspace.diff(fixBase, headSha, MAX_ROUND_DIFF_BYTES) : undefined;
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
      previousRun,
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
    const previousReview = stage.rounds.find((candidate) => candidate.n === round.n - 1)?.review;
    const previousComments = previousReview?.comments ?? [];
    // After a user's request round, the reviewer sees everything since its own last review - including work the task
    // stopped before it was reviewed - and its own comments from that review with the author's responses.
    const sinceReview = previousReview?.by === "user" ? this.lastReviewBefore(stage, round.n - 1) : undefined;
    const reviewerComments = sinceReview?.review?.verdict === "request_changes" ? sinceReview.review.comments : [];
    const prevSha =
      previousReview?.by === "user"
        ? (sinceReview?.review?.reviewedSha ?? sinceReview?.author?.commit ?? stage.rounds.find((candidate) => candidate.author?.prevCommit)?.author?.prevCommit ?? workspace.baseSha)
        : (submission.prevCommit ?? workspace.baseSha);
    const totalStat = await workspace.diffStat(workspace.baseSha, headSha);
    let docContent: string | undefined;
    let roundDiff: { text: string; truncated: boolean } | undefined;
    let extraDocs: Array<{ path: string; content: string | null }> | undefined;
    if (isDocStage(stage.kind)) {
      docContent =
        (stage.docPath ? await workspace.readAt(headSha, stage.docPath) : null) ??
        (submission.docSnapshot ? await hooks.readArtifact(submission.docSnapshot) : null) ??
        undefined;
      if (round.n > 1 && stage.docPath) roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES, [stage.docPath]);
      if (stage.extraDocs?.length) {
        extraDocs = [];
        for (const file of stage.extraDocs) extraDocs.push({ path: file, content: await workspace.readAt(headSha, file) });
      }
    } else {
      roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES);
    }
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
      extraDocs,
      submission,
      authorLabel: ROLE_LABELS[submission.role ?? authorRoleFor(stage.kind)],
      baseSha: workspace.baseSha,
      prevSha,
      headSha,
      totalStat,
      roundDiff,
      previousComments,
      userRequests: previousReview?.by === "user",
      reviewerComments,
    });
  }

  /** The latest round before round `n` that a reviewer (or the test executor) checked: what its next check starts from. */
  private lastReviewBefore(stage: Stage, n: number): Round | undefined {
    return [...stage.rounds].reverse().find((candidate) => candidate.n < n && candidate.review && candidate.review.by !== "user");
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
    // A design the manager dropped (for a change request) is not what the code follows.
    const designStage = this.task.stages.find((stage) => stage.kind === "design" && stage.status !== "skipped");
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
    const stages = kinds.map((kind) => this.stage(kind));
    // Stages the manager dropped for a change request no longer count (their history stays on the task).
    const docStage = stages.find((stage) => isDocStage(stage.kind));
    const testStage = stages.find((stage) => stage.kind === "testing");
    const codingStage = stages.find((stage) => stage.kind === "coding");
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
      designDocPath: stages.find((stage) => stage.kind === "design")?.docPath,
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
  if (phase === "discussing") return "Discussing the findings";
  if (phase === "consolidating") return "Agreeing on the final review";
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
  const left = run.unrelatedFailures?.length ? `; ${plural(run.unrelatedFailures.length, "unrelated failure")} left for their owners` : "";
  if (run.status === "passed") return `Passed${run.total !== undefined ? `: ${run.total} test${run.total === 1 ? "" : "s"}` : ""}${run.skipped ? `, ${run.skipped} skipped` : ""}${left}`;
  const counts = new Map<string, number>();
  for (const failure of failures) counts.set(failure.category ?? "unknown", (counts.get(failure.category ?? "unknown") ?? 0) + 1);
  const breakdown = [...counts].map(([category, count]) => `${count} ${category}`).join(", ");
  if (run.status === "blocked") return `Blocked: ${truncate(failures[0]?.test ?? "the automation could not run", 120)}`;
  const failed = run.failed ?? failures.length;
  return `Failed: ${failed}${run.total !== undefined ? ` of ${run.total}` : ""} (${breakdown})${left}`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function describeComments(comments: readonly ReviewComment[]): string {
  if (!comments.length) return "no specific comments";
  const counts = new Map<string, number>();
  for (const comment of comments) counts.set(comment.severity, (counts.get(comment.severity) ?? 0) + 1);
  return `${comments.length} comment${comments.length === 1 ? "" : "s"} (${[...counts].map(([severity, count]) => `${count} ${severity}`).join(", ")})`;
}

/** "pull request #12", "merge request !5", or the reviewed branch. */
export function reviewedChange(target: ReviewTarget): string {
  const pr = target.pullRequest;
  if (!pr) return target.headRef;
  return pr.provider === "gitlab" ? `merge request !${pr.number}` : `pull request #${pr.number}`;
}

/** " (1 blocker, 2 minor)" in severity order, or "" for no comments. */
function describeSeverities(comments: ReadonlyArray<{ severity: string }>): string {
  const order = ["blocker", "major", "minor", "nit"];
  const parts = order.map((severity) => [severity, comments.filter((comment) => comment.severity === severity).length] as const).filter(([, count]) => count);
  return parts.length ? ` (${parts.map(([severity, count]) => `${count} ${severity}`).join(", ")})` : "";
}
