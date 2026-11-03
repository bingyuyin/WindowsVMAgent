import type {
  AgentDriver,
  AgentHandle,
  AgentObserver,
  ReviewSubmissionInput,
  TurnResult,
  UserQuestion,
  WorkSubmissionInput,
} from "../agents/driver.ts";
import path from "node:path";
import {
  authorPrompt,
  MAX_INLINE_DIFF,
  NUDGE_REVIEW,
  NUDGE_WORK,
  reviewPrompt,
  systemPromptFor,
  type DesignContext,
} from "../agents/prompts.ts";
import { ROLE_SKILLS, type HubSkills } from "../context.ts";
import type { AgentWorkspace, TaskWorkspace } from "../git.ts";
import {
  authorRoleFor,
  isReviewerRole,
  resolverRoleFor,
  reviewerRoleFor,
  ROLE_LABELS,
  stagesFor,
  type AgentInfo,
  type AgentRole,
  type AgentStatus,
  type AuthorSubmission,
  type NewTaskEvent,
  type Phase,
  type ReviewComment,
  type ReviewSubmission,
  type Round,
  type Settings,
  type Stage,
  type StageKind,
  type Task,
} from "../types.ts";
import { CancelledError, firstLine, nowIso, slugify, truncate } from "../util.ts";
import { fallbackReview, normalizeReview, normalizeWork } from "./submissions.ts";

/** Side effects the engine needs from its host (persistence, live updates, user prompts). */
export interface EngineHooks {
  readonly signal: AbortSignal;
  emit(event: NewTaskEvent): void;
  update(): void;
  observer(role: AgentRole, stage: StageKind): AgentObserver;
  askUser(role: AgentRole, question: UserQuestion): Promise<string>;
  saveArtifact(name: string, content: string): Promise<void>;
  readArtifact(name: string): Promise<string | null>;
  trackSession(role: AgentRole, sessionId: string): void;
  /** Mutates the live state of a sub-agent (created on first use) and publishes it. */
  agent(role: AgentRole, mutate: (agent: AgentInfo) => void): void;
}

export interface EngineOptions {
  driver: AgentDriver;
  workspace: TaskWorkspace;
  settings: Pick<Settings, "designDocDir" | "turnTimeoutMinutes" | "cleanupWorktrees">;
  hooks: EngineHooks;
  hubSkills?: HubSkills;
}

interface ActiveAgent {
  role: AgentRole;
  handle: AgentHandle;
}

const MAX_SUBMIT_NUDGES = 2;
const MAX_ROUND_DIFF_BYTES = 60_000;
const CO_AUTHOR = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";

export const STAGE_LABELS: Record<StageKind, string> = { design: "Design", coding: "Coding" };

export function modelFor(task: Pick<Task, "authorModel" | "reviewerModel" | "resolverModel">, role: AgentRole): string {
  if (isReviewerRole(role)) return task.reviewerModel;
  if (role === "resolver") return task.resolverModel || task.authorModel;
  return task.authorModel;
}

/**
 * Runs a task's stages. Each stage is an author <-> reviewer loop between sub-agents that each work
 * in their own place: authors on their own branch, reviewers in a worktree pinned to the commit under
 * review. After each author round the hub commits and fast-forwards the task branch; open review
 * comments go to the comment resolver (code) or back to the designer (design) until approval.
 */
export class WorkflowEngine {
  private readonly task: Task;
  private readonly options: EngineOptions;
  private readonly agents = new Map<AgentRole, ActiveAgent>();
  private pendingWork: WorkSubmissionInput | null = null;
  private pendingReview: ReviewSubmissionInput | null = null;
  private expectedCommentIds: string[] = [];
  private currentAuthorWorkspace: AgentWorkspace | null = null;

  constructor(task: Task, options: EngineOptions) {
    this.task = task;
    this.options = options;
  }

  async run(): Promise<void> {
    const kinds = stagesFor(this.task.kind);
    for (const kind of kinds) {
      if (!this.task.stages.some((stage) => stage.kind === kind)) {
        this.task.stages.push({ kind, status: "pending", rounds: [], nextCommentNumber: 1 });
      }
    }
    for (let index = this.resumeIndex(kinds); index < kinds.length; index++) {
      this.throwIfAborted();
      const previous = index > 0 ? this.stage(kinds[index - 1]!) : undefined;
      if (previous?.status === "not-approved") {
        this.options.hooks.emit({
          type: "warning",
          text: `${STAGE_LABELS[previous.kind]} stage was not approved within its round budget; continuing with the latest version.`,
        });
      }
      await this.runStage(this.stage(kinds[index]!));
    }
    await this.finalize();
  }

  /** Interrupts in-flight agent turns (used when the task is cancelled or the hub shuts down). */
  async abortAgents(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => agent.handle.abort()));
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

  private setPhase(stage: StageKind, phase: Phase, round: number): void {
    const task = this.task;
    task.currentStage = stage;
    task.phase = phase;
    task.currentRound = round;
    task.phaseStartedAt = nowIso();
    this.options.hooks.emit({ type: "phase", stage, round, text: phaseLabel(stage, phase), data: { phase } });
    this.options.hooks.update();
  }

  private async runStage(stage: Stage): Promise<void> {
    const { hooks } = this.options;
    const task = this.task;
    const kind = stage.kind;
    stage.status = "running";
    stage.startedAt ??= nowIso();
    stage.finishedAt = undefined;
    if (kind === "design") stage.docPath ??= this.designDocPath();
    task.currentStage = kind;
    hooks.emit({ type: "info", stage: kind, text: `${STAGE_LABELS[kind]} stage started` });
    hooks.update();

    const budget = Math.max(1, task.roundsBudget ?? task.maxRounds);
    const design = kind === "coding" ? await this.designContext() : undefined;
    const resumed = stage.rounds.some((round) => round.author);

    let last = stage.rounds.at(-1);
    if (last && !last.author) {
      stage.rounds.pop();
      last = stage.rounds.at(-1);
    }
    // A round whose author work finished but whose review did not (e.g. after a restart) is reviewed first.
    let reviewOnly: Round | null = last?.author && !last.review ? last : null;
    let lastReview = reviewOnly ? undefined : last?.review;
    let open = lastReview?.verdict === "request_changes" ? lastReview.comments.filter((comment) => comment.status === "open") : [];

    const used = new Set<AgentRole>();
    let reviews = 0;
    try {
      for (;;) {
        this.throwIfAborted();
        let round: Round;
        if (reviewOnly) {
          round = reviewOnly;
          reviewOnly = null;
        } else {
          const role = open.length ? resolverRoleFor(kind) : authorRoleFor(kind);
          used.add(role);
          round = { n: stage.rounds.length + 1, attempt: task.attempt, startedAt: nowIso() };
          stage.rounds.push(round);
          this.setPhase(kind, open.length ? "revising" : "authoring", round.n);
          round.author = await this.authorTurn(stage, round, role, { design, resumed, lastReview, open });
          hooks.update();
        }

        this.throwIfAborted();
        const reviewerRole = reviewerRoleFor(kind);
        used.add(reviewerRole);
        this.setPhase(kind, "reviewing", round.n);
        const review = await this.reviewTurn(stage, round, reviewerRole, design);
        reviews++;
        round.review = review;
        const verdictText = review.verdict === "approve" ? "Approved" : `Changes requested (${review.comments.length} comment(s))`;
        hooks.emit({
          type: "review",
          role: reviewerRole,
          stage: kind,
          round: round.n,
          text: `${verdictText}: ${truncate(review.summary, 600)}`,
          data: { verdict: review.verdict, comments: review.comments.length, fallback: review.fallback ?? false },
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
            text: `Stopped after ${reviews} review round(s) without approval; ${open.length} comment(s) remain open.`,
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
    hooks.emit({
      type: "info",
      stage: kind,
      text:
        stage.status === "approved"
          ? `${STAGE_LABELS[kind]} approved in round ${finalRound}`
          : `${STAGE_LABELS[kind]} finished without approval after round ${finalRound}`,
    });
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
    if (kind === "design" && stage.docPath) await ws.ensureDir(path.posix.dirname(stage.docPath));
    const startHead = await ws.head();
    const fresh = !this.agents.has(role);
    const agent = await this.agentFor(role, kind, ws.path);
    const assignment = assignmentFor(role, round.n, context.open.length);
    hooks.agent(role, (info) => {
      info.status = "working";
      info.workspace = ws.path;
      info.workspaceRemoved = false;
      info.branch = ws.branch;
      info.assignment = assignment;
      if (!info.rounds.includes(round.n)) info.rounds.push(round.n);
    });
    hooks.emit({ type: "info", role, stage: kind, text: `${assignment} on branch ${ws.branch}` });

    let previousWork: { summary: string; stat: string; diff: { text: string; truncated: boolean } } | undefined;
    if (fresh && role === "resolver") {
      const prior = [...stage.rounds].reverse().find((candidate) => candidate !== round && candidate.author)?.author;
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
    return this.recordAuthorRound(stage, round, role, ws, startHead, submission.input, submission.fallback, context.open);
  }

  private async reviewTurn(stage: Stage, round: Round, role: AgentRole, design: DesignContext | undefined): Promise<ReviewSubmission> {
    const { hooks, workspace } = this.options;
    const reviewedSha = round.author?.commit ?? (await workspace.taskHead());
    const ws = await workspace.prepareReviewer(role, reviewedSha);
    const fresh = !this.agents.has(role);
    const agent = await this.agentFor(role, stage.kind, ws.path);
    hooks.agent(role, (info) => {
      info.status = "working";
      info.workspace = ws.path;
      info.workspaceRemoved = false;
      info.branch = null;
      info.assignment = `Reviewing round ${round.n} at ${reviewedSha.slice(0, 10)}`;
      if (!info.rounds.includes(round.n)) info.rounds.push(round.n);
    });
    const prompt = await this.buildReviewPrompt(stage, round, fresh, design, reviewedSha);
    const review = await this.runReviewTurn(agent, prompt, stage, reviewedSha);
    hooks.agent(role, (info) => {
      info.status = "idle";
    });
    return review;
  }

  private async agentFor(role: AgentRole, stageKind: StageKind, workingDirectory: string): Promise<ActiveAgent> {
    const existing = this.agents.get(role);
    if (existing) return existing;
    const { driver, workspace, settings, hooks, hubSkills } = this.options;
    const task = this.task;
    const reviewer = isReviewerRole(role);
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
      ),
      readOnly: reviewer,
      skillDirectories: [
        ...(task.context?.skillRoots ?? []).map((root) => path.join(workingDirectory, root)),
        ...(hubSkills?.dir ? [hubSkills.dir] : []),
      ],
      disabledSkills: hubNames.filter((name) => !roleSkills.includes(name)),
      submit: reviewer
        ? { kind: "review", onSubmit: (input) => void (this.pendingReview = normalizeReview(input)) }
        : { kind: "work", onSubmit: (input) => this.acceptWork(input, stageKind) },
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
    return agent;
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
  }

  private send(agent: ActiveAgent, prompt: string): Promise<TurnResult> {
    this.options.hooks.agent(agent.role, (info) => {
      info.turns += 1;
    });
    return agent.handle.send(prompt);
  }

  private async acceptWork(input: WorkSubmissionInput, stageKind: StageKind): Promise<void> {
    const normalized = normalizeWork(input, this.expectedCommentIds);
    if (stageKind === "design") {
      const docPath = this.stage("design").docPath!;
      const content = await this.currentAuthorWorkspace?.readFile(docPath);
      if (!content?.trim()) {
        throw new Error(`The design document was not found at '${docPath}'. Write the document to that exact path, then call submit_work again.`);
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

  private async runReviewTurn(agent: ActiveAgent, prompt: string, stage: Stage, reviewedSha: string): Promise<ReviewSubmission> {
    const role = agent.role;
    this.pendingReview = null;
    let result = await this.send(agent, prompt);
    for (let nudge = 0; !this.submittedReview() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      this.options.hooks.emit({ type: "warning", role, text: "Reviewer ended its turn without calling submit_review; asking it to submit." });
      result = await this.send(agent, NUDGE_REVIEW);
    }
    let input = this.submittedReview();
    const fallback = !input;
    if (!input) {
      this.options.hooks.emit({ type: "warning", role, text: "Reviewer never called submit_review; deriving the verdict from its last message." });
      input = fallbackReview(result.lastMessage);
    }
    const prefix = stage.kind === "design" ? "D" : "C";
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
    if (stage.kind === "design" && stage.docPath) {
      const content = await ws.readFile(stage.docPath);
      if (content !== null) {
        docSnapshot = `design-r${round.n}.md`;
        await hooks.saveArtifact(docSnapshot, content);
      } else {
        hooks.emit({ type: "warning", role, text: `Design document ${stage.docPath} was not found after round ${round.n}.` });
      }
    }

    const label = stage.kind === "design" ? "design" : role === "resolver" ? "review fixes" : "code";
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
    if (stage.kind === "design") {
      docContent =
        (stage.docPath ? await workspace.readAt(headSha, stage.docPath) : null) ??
        (submission.docSnapshot ? await hooks.readArtifact(submission.docSnapshot) : null) ??
        undefined;
      if (round.n > 1 && stage.docPath) roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES, [stage.docPath]);
    } else {
      roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES);
    }
    const previousComments = stage.rounds.find((candidate) => candidate.n === round.n - 1)?.review?.comments ?? [];
    return reviewPrompt({
      task: this.task,
      role: reviewerRoleFor(stage.kind),
      stage: stage.kind,
      round: round.n,
      includeContext,
      design,
      context: this.task.context,
      docPath: stage.docPath,
      docContent,
      submission,
      authorLabel: ROLE_LABELS[submission.role ?? authorRoleFor(stage.kind)],
      baseSha: workspace.baseSha,
      prevSha,
      headSha,
      totalStat,
      roundDiff,
      previousComments,
    });
  }

  private designDocPath(): string {
    const dir = this.options.settings.designDocDir.replaceAll("\\", "/").replace(/\/+$/, "") || "docs/designs";
    return `${dir}/${this.task.id.toLowerCase()}-${slugify(this.task.title, 48)}.md`;
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
      content,
      approved,
      openComments: approved ? [] : (lastReview?.comments.filter((comment) => comment.status === "open") ?? []),
    };
  }

  private async finalize(): Promise<void> {
    const { workspace, hooks, settings } = this.options;
    const task = this.task;
    const kinds = stagesFor(task.kind);
    const lastStage = this.stage(kinds[kinds.length - 1]!);
    this.setPhase(lastStage.kind, "finalizing", task.currentRound);
    const head = await workspace.taskHead();
    const lastAuthor = [...lastStage.rounds].reverse().find((round) => round.author)?.author;
    const lastReview = [...lastStage.rounds].reverse().find((round) => round.review)?.review;
    task.result = {
      approved: lastStage.status === "approved",
      summary: lastAuthor?.summary ?? "",
      headSha: head,
      diffStat: await workspace.diffStat(workspace.baseSha, head),
      shortStat: await workspace.shortStat(workspace.baseSha, head),
      commits: await workspace.commitCount(workspace.baseSha, head),
      designDocPath: task.stages.find((stage) => stage.kind === "design")?.docPath,
      openComments: lastReview?.comments.filter((comment) => comment.status === "open").length ?? 0,
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
      text: task.result.approved ? "Workflow complete: final version approved by the reviewer." : "Workflow complete without final approval.",
    });
    hooks.update();
  }
}

export function assignmentFor(role: AgentRole, round: number, openComments: number): string {
  switch (role) {
    case "coder":
      return `Implementing the request (round ${round})`;
    case "resolver":
      return `Resolving ${openComments} review comment${openComments === 1 ? "" : "s"} (round ${round})`;
    case "designer":
      return openComments
        ? `Revising the design for ${openComments} review comment${openComments === 1 ? "" : "s"} (round ${round})`
        : `Writing the design (round ${round})`;
    default:
      return `Reviewing round ${round}`;
  }
}

export function phaseLabel(stage: StageKind | undefined, phase: Phase): string {
  if (phase === "authoring") return stage === "design" ? "Designing" : "Coding";
  if (phase === "reviewing") return stage === "design" ? "Reviewing design" : "Reviewing code";
  if (phase === "revising") return stage === "design" ? "Revising design" : "Resolving review comments";
  if (phase === "preparing") return "Preparing workspace";
  if (phase === "finalizing") return "Finalizing";
  if (phase === "done") return "Done";
  return "Queued";
}
