import type {
  AgentDriver,
  AgentHandle,
  AgentObserver,
  PlanSubmissionInput,
  ReviewSubmissionInput,
  SubmitChannel,
  TestRunSubmissionInput,
  TurnResult,
  UserQuestion,
  WorkSubmissionInput,
} from "../agents/driver.ts";
import path from "node:path";
import {
  authorPrompt,
  executionPrompt,
  MAX_INLINE_DIFF,
  NUDGE_PLAN,
  NUDGE_REVIEW,
  NUDGE_TEST,
  NUDGE_WORK,
  plannerPrompt,
  reviewPrompt,
  systemPromptFor,
  type DesignContext,
} from "../agents/prompts.ts";
import { ROLE_SKILLS, type HubSkills } from "../context.ts";
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
} from "../types.ts";
import { CancelledError, firstLine, nowIso, slugify, truncate } from "../util.ts";
import {
  fallbackReview,
  fallbackTestRun,
  heuristicPlan,
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
  settings: Pick<Settings, "designDocDir" | "documentDir" | "docFormat" | "turnTimeoutMinutes" | "cleanupWorktrees">;
  hooks: EngineHooks;
  hubSkills?: HubSkills;
  docTemplates?: DocTemplates | null;
}

interface ActiveAgent {
  role: AgentRole;
  handle: AgentHandle;
}

const MAX_SUBMIT_NUDGES = 2;
const MAX_ROUND_DIFF_BYTES = 60_000;
const CO_AUTHOR = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";
const COMMENT_PREFIX: Record<StageKind, string> = { design: "D", document: "W", coding: "C", testing: "T" };

export const STAGE_LABELS: Record<StageKind, string> = { design: "Design", document: "Document", coding: "Coding", testing: "Execute & verify" };

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
      let result = await this.send(agent, plannerPrompt(task, task.context));
      for (let nudge = 0; !this.submittedPlan() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
        this.throwIfAborted();
        hooks.emit({ type: "warning", role, text: "Planner ended its turn without calling submit_plan; asking it to submit." });
        hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_plan - submit the plan" });
        result = await this.send(agent, NUDGE_PLAN);
      }
      this.throwIfAborted();
      let plan = this.submittedPlan();
      const fallback = !plan;
      if (!plan) {
        hooks.emit({ type: "warning", role, text: `Planner never called submit_plan (last message: ${truncate(firstLine(result.lastMessage ?? ""), 200) || "none"}); choosing stages from the request.` });
        plan = heuristicPlan(task.description);
      }
      task.plan = { stages: plan.stages, rationale: plan.rationale, instructions: plan.instructions, fallback: fallback || undefined, plannedAt: nowIso() };
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

    let previousWork: { summary: string; stat: string; diff: { text: string; truncated: boolean } } | undefined;
    if (fresh && (role === "resolver" || role === "fixer") && startHead !== workspace.baseSha) {
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
    const prompt = authorPrompt({
      task: this.task,
      role,
      stage: kind,
      round: round.n,
      docPath: stage.docPath,
      docFormat: stage.docFormat,
      seeded: this.seededDoc !== null,
      design: context.design,
      context: this.task.context,
      includeContext: fresh,
      resumed: context.resumed && fresh,
      review: context.lastReview,
      openComments: context.open,
      previousWork,
    });
    this.currentAuthorWorkspace = ws;
    const submission = await this.runAuthorTurn(agent, prompt, context.open);
    hooks.agent(role, (info) => {
      info.status = "idle";
    });
    return this.recordAuthorRound(stage, round, role, ws, startHead, submission.input, submission.fallback, context.open, fromUser);
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
    const review = executor
      ? await this.runTestTurn(agent, await this.buildExecutionPrompt(stage, round, fresh, design, reviewedSha), stage, reviewedSha)
      : await this.runReviewTurn(agent, await this.buildReviewPrompt(stage, round, fresh, design, reviewedSha), stage, reviewedSha);
    hooks.agent(role, (info) => {
      info.status = "idle";
    });
    return review;
  }

  private async agentFor(role: AgentRole, stageKind: StageKind | undefined, workingDirectory: string): Promise<ActiveAgent> {
    const existing = this.agents.get(role);
    if (existing) return existing;
    const { driver, workspace, settings, hooks, hubSkills } = this.options;
    const task = this.task;
    const readOnly = isReviewerRole(role) || role === "planner";
    const executeOnly = role === "executor";
    const model = modelFor(task, role);
    const hubNames = (hubSkills?.skills ?? []).map((skill) => skill.name);
    const roleSkills = hubNames.filter((name) => ROLE_SKILLS[role].includes(name));
    const handle = await driver.start({
      taskId: task.id,
      role,
      model,
      title: task.title,
      workingDirectory,
      systemPrompt: systemPromptFor(
        role,
        { worktree: workingDirectory, branch: workspace.branchFor(role), taskBranch: workspace.taskBranch, baseSha: workspace.baseSha },
        roleSkills,
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
      disabledSkills: hubNames.filter((name) => !roleSkills.includes(name)),
      submit: this.submitChannelFor(role, stageKind),
      observer: hooks.observer(role, stageKind),
      askUser: (question) => hooks.askUser(role, question),
      turnTimeoutMs: settings.turnTimeoutMinutes * 60_000,
    });
    const agent: ActiveAgent = { role, handle };
    this.agents.set(role, agent);
    hooks.trackSession(role, handle.sessionId);
    hooks.agent(role, (info) => {
      info.model = model;
      info.sessionId = handle.sessionId;
    });
    hooks.emit({ type: "info", role, stage: stageKind, text: `${ROLE_LABELS[role]} agent started on ${model}`, data: { sessionId: handle.sessionId } });
    const access = readOnly ? " (read-only)" : executeOnly ? " (runs commands, no file edits)" : "";
    hooks.comm({
      from: "manager",
      to: role,
      kind: "spawn",
      stage: stageKind,
      text: `Started a ${ROLE_LABELS[role].toLowerCase()} session on ${model}${access}${roleSkills.length ? `; skills: ${roleSkills.join(", ")}` : ""}`,
    });
    return agent;
  }

  /** The terminal tool through which each kind of agent hands back its structured result. */
  private submitChannelFor(role: AgentRole, stageKind: StageKind | undefined): SubmitChannel {
    if (role === "planner") return { kind: "plan", onSubmit: (input) => void (this.pendingPlan = normalizePlan(input)) };
    if (role === "executor") return { kind: "test", onSubmit: (input) => void (this.pendingTest = normalizeTestRun(input)) };
    if (isReviewerRole(role)) return { kind: "review", onSubmit: (input) => void (this.pendingReview = normalizeReview(input)) };
    if (!stageKind) throw new Error(`${role} needs a stage`);
    return { kind: "work", onSubmit: (input) => this.acceptWork(input, stageKind) };
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

  private send(agent: ActiveAgent, prompt: string): Promise<TurnResult> {
    this.options.hooks.agent(agent.role, (info) => {
      info.turns += 1;
    });
    return agent.handle.send(prompt);
  }

  private async acceptWork(input: WorkSubmissionInput, stageKind: StageKind): Promise<void> {
    const normalized = normalizeWork(input, this.expectedCommentIds);
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

  private async runAuthorTurn(agent: ActiveAgent, prompt: string, open: ReviewComment[]): Promise<{ input: WorkSubmissionInput; fallback: boolean }> {
    const role = agent.role;
    this.pendingWork = null;
    this.expectedCommentIds = open.map((comment) => comment.id);
    let result = await this.send(agent, prompt);
    for (let nudge = 0; !this.submittedWork() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      this.options.hooks.emit({ type: "warning", role, text: "Agent ended its turn without calling submit_work; asking it to submit." });
      this.options.hooks.comm({ from: "manager", to: role, kind: "nudge", text: "Your turn ended without submit_work - finish the round and submit" });
      result = await this.send(agent, NUDGE_WORK);
    }
    const submitted = this.submittedWork();
    if (submitted) return { input: submitted, fallback: false };
    this.options.hooks.emit({ type: "warning", role, text: "Agent never called submit_work; using its last message as the round summary." });
    return { input: { summary: result.lastMessage?.trim() || "(no summary provided)" }, fallback: true };
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
  private async runTestTurn(agent: ActiveAgent, prompt: string, stage: Stage, testedSha: string): Promise<ReviewSubmission> {
    const { hooks } = this.options;
    const role = agent.role;
    this.pendingTest = null;
    let result = await this.send(agent, prompt);
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

  private async runReviewTurn(agent: ActiveAgent, prompt: string, stage: Stage, reviewedSha: string): Promise<ReviewSubmission> {
    const role = agent.role;
    this.pendingReview = null;
    let result = await this.send(agent, prompt);
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
