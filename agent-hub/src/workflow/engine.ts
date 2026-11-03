import type {
  AgentDriver,
  AgentHandle,
  AgentObserver,
  ReviewSubmissionInput,
  UserQuestion,
  WorkSubmissionInput,
} from "../agents/driver.ts";
import { authorPrompt, NUDGE_REVIEW, NUDGE_WORK, reviewPrompt, systemPromptFor, type DesignContext } from "../agents/prompts.ts";
import type { Workspace } from "../git.ts";
import {
  authorRoleFor,
  isReviewerRole,
  reviewerRoleFor,
  ROLE_LABELS,
  stagesFor,
  type AgentRole,
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
}

export interface EngineOptions {
  driver: AgentDriver;
  workspace: Workspace;
  settings: Pick<Settings, "designDocDir" | "turnTimeoutMinutes">;
  hooks: EngineHooks;
}

const MAX_SUBMIT_NUDGES = 2;
const MAX_ROUND_DIFF_BYTES = 60_000;
const CO_AUTHOR = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>";

export const STAGE_LABELS: Record<StageKind, string> = { design: "Design", coding: "Coding" };

/**
 * Runs a task's stages. Each stage is an author <-> reviewer loop: the author works and calls
 * submit_work, the hub commits, the reviewer reviews and calls submit_review, and open comments
 * flow back to the author until the reviewer approves or the round budget is exhausted.
 */
export class WorkflowEngine {
  private readonly task: Task;
  private readonly options: EngineOptions;
  private readonly active = new Set<AgentHandle>();
  private pendingWork: WorkSubmissionInput | null = null;
  private pendingReview: ReviewSubmissionInput | null = null;
  private expectedCommentIds: string[] = [];

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
    await Promise.all([...this.active].map((handle) => handle.abort()));
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
    if (kind === "design") {
      stage.docPath ??= this.designDocPath();
      // Saves the designer a failed write: file-creation tools do not create parent folders.
      await this.options.workspace.ensureDir(stage.docPath.split("/").slice(0, -1).join("/") || ".");
    }
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

    let author: AgentHandle | null = null;
    let reviewer: AgentHandle | null = null;
    let authorTurns = 0;
    let reviewerTurns = 0;
    let reviews = 0;
    try {
      for (;;) {
        this.throwIfAborted();
        let round: Round;
        if (reviewOnly) {
          round = reviewOnly;
          reviewOnly = null;
        } else {
          round = { n: stage.rounds.length + 1, attempt: task.attempt, startedAt: nowIso() };
          stage.rounds.push(round);
          this.setPhase(kind, open.length ? "revising" : "authoring", round.n);
          author ??= await this.startAgent(authorRoleFor(kind), kind);
          const prompt = authorPrompt({
            task,
            stage: kind,
            round: round.n,
            docPath: stage.docPath,
            design,
            includeContext: authorTurns === 0,
            resumed: resumed && authorTurns === 0,
            review: lastReview,
            openComments: open,
          });
          const submission = await this.runAuthorTurn(author, prompt, open, authorRoleFor(kind));
          authorTurns++;
          round.author = await this.recordAuthorRound(stage, round, submission.input, submission.fallback, open);
          hooks.update();
        }

        this.throwIfAborted();
        this.setPhase(kind, "reviewing", round.n);
        reviewer ??= await this.startAgent(reviewerRoleFor(kind), kind);
        const prompt = await this.buildReviewPrompt(stage, round, reviewerTurns === 0, design);
        const review = await this.runReviewTurn(reviewer, prompt, stage);
        reviewerTurns++;
        reviews++;
        round.review = review;
        const verdictText = review.verdict === "approve" ? "Approved" : `Changes requested (${review.comments.length} comment(s))`;
        hooks.emit({
          type: "review",
          role: reviewerRoleFor(kind),
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
      for (const handle of [author, reviewer]) if (handle) await this.release(handle);
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

  private async startAgent(role: AgentRole, stageKind: StageKind): Promise<AgentHandle> {
    const { driver, workspace, settings, hooks } = this.options;
    const task = this.task;
    const reviewer = isReviewerRole(role);
    const model = reviewer ? task.reviewerModel : task.authorModel;
    const handle = await driver.start({
      taskId: task.id,
      role,
      model,
      title: task.title,
      workingDirectory: workspace.path,
      systemPrompt: systemPromptFor(role, { worktree: workspace.path, branch: task.branch ?? "(task branch)", baseSha: workspace.baseSha }),
      readOnly: reviewer,
      submit: reviewer
        ? { kind: "review", onSubmit: (input) => void (this.pendingReview = normalizeReview(input)) }
        : { kind: "work", onSubmit: (input) => this.acceptWork(input, stageKind) },
      observer: hooks.observer(role, stageKind),
      askUser: (question) => hooks.askUser(role, question),
      turnTimeoutMs: settings.turnTimeoutMinutes * 60_000,
    });
    this.active.add(handle);
    hooks.trackSession(role, handle.sessionId);
    hooks.emit({ type: "info", role, stage: stageKind, text: `${ROLE_LABELS[role]} agent started on ${model}`, data: { sessionId: handle.sessionId } });
    return handle;
  }

  private async acceptWork(input: WorkSubmissionInput, stageKind: StageKind): Promise<void> {
    const normalized = normalizeWork(input, this.expectedCommentIds);
    if (stageKind === "design") {
      const docPath = this.stage("design").docPath!;
      const content = await this.options.workspace.readFile(docPath);
      if (!content?.trim()) {
        throw new Error(`The design document was not found at '${docPath}'. Write the document to that exact path, then call submit_work again.`);
      }
    }
    this.pendingWork = normalized;
  }

  private async release(handle: AgentHandle): Promise<void> {
    this.active.delete(handle);
    await handle.dispose();
  }

  private async runAuthorTurn(
    handle: AgentHandle,
    prompt: string,
    open: ReviewComment[],
    role: AgentRole,
  ): Promise<{ input: WorkSubmissionInput; fallback: boolean }> {
    this.pendingWork = null;
    this.expectedCommentIds = open.map((comment) => comment.id);
    let result = await handle.send(prompt);
    for (let nudge = 0; !this.submittedWork() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      this.options.hooks.emit({ type: "warning", role, text: "Agent ended its turn without calling submit_work; asking it to submit." });
      result = await handle.send(NUDGE_WORK);
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

  private async runReviewTurn(handle: AgentHandle, prompt: string, stage: Stage): Promise<ReviewSubmission> {
    const role = reviewerRoleFor(stage.kind);
    this.pendingReview = null;
    let result = await handle.send(prompt);
    for (let nudge = 0; !this.submittedReview() && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      this.throwIfAborted();
      this.options.hooks.emit({ type: "warning", role, text: "Reviewer ended its turn without calling submit_review; asking it to submit." });
      result = await handle.send(NUDGE_REVIEW);
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
      fallback: fallback || undefined,
      at: nowIso(),
    };
  }

  private async recordAuthorRound(
    stage: Stage,
    round: Round,
    input: WorkSubmissionInput,
    fallback: boolean,
    open: ReviewComment[],
  ): Promise<AuthorSubmission> {
    const { workspace, hooks } = this.options;
    const task = this.task;
    const role = authorRoleFor(stage.kind);
    for (const comment of open) {
      const response = input.comment_responses?.find((candidate) => candidate.comment_id === comment.id);
      if (response) {
        comment.status = response.status;
        comment.response = response.note;
      }
    }

    let docSnapshot: string | undefined;
    if (stage.kind === "design" && stage.docPath) {
      const content = await workspace.readFile(stage.docPath);
      if (content !== null) {
        docSnapshot = `design-r${round.n}.md`;
        await hooks.saveArtifact(docSnapshot, content);
      } else {
        hooks.emit({ type: "warning", role, text: `Design document ${stage.docPath} was not found after round ${round.n}.` });
      }
    }

    const prevCommit = await workspace.head();
    const subject = `[agent-hub] ${task.id} ${stage.kind === "design" ? "design" : "code"} round ${round.n}: ${truncate(firstLine(input.summary), 72)}`;
    const commit = await workspace.commitAll(subject, `${task.title}\n\n${CO_AUTHOR}`);
    const shortStat = commit ? await workspace.shortStat(prevCommit, commit) : "";
    if (commit) {
      hooks.emit({ type: "commit", role, text: `Committed ${commit.slice(0, 10)}${shortStat ? ` (${shortStat})` : ""}`, data: { sha: commit } });
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
      summary: input.summary,
      validation: input.validation,
      responses: (input.comment_responses ?? []).map((response) => ({
        commentId: response.comment_id,
        status: response.status,
        note: response.note,
      })),
      fallback: fallback || undefined,
      commit,
      prevCommit,
      shortStat,
      docSnapshot,
      at: nowIso(),
    };
  }

  private async buildReviewPrompt(stage: Stage, round: Round, includeContext: boolean, design: DesignContext | undefined): Promise<string> {
    const { workspace, hooks } = this.options;
    const submission = round.author!;
    const headSha = submission.commit ?? (await workspace.head());
    const prevSha = submission.prevCommit ?? workspace.baseSha;
    const totalStat = await workspace.diffStat(workspace.baseSha, headSha);
    let docContent: string | undefined;
    let roundDiff: { text: string; truncated: boolean } | undefined;
    if (stage.kind === "design") {
      docContent =
        (stage.docPath ? await workspace.readFile(stage.docPath) : null) ??
        (submission.docSnapshot ? await hooks.readArtifact(submission.docSnapshot) : null) ??
        undefined;
      if (round.n > 1 && stage.docPath) roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES, [stage.docPath]);
    } else {
      roundDiff = await workspace.diff(prevSha, headSha, MAX_ROUND_DIFF_BYTES);
    }
    const previousComments = stage.rounds.find((candidate) => candidate.n === round.n - 1)?.review?.comments ?? [];
    return reviewPrompt({
      task: this.task,
      stage: stage.kind,
      round: round.n,
      includeContext,
      design,
      docPath: stage.docPath,
      docContent,
      submission,
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
    let content = await this.options.workspace.readFile(designStage.docPath);
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
    const { workspace, hooks } = this.options;
    const task = this.task;
    const kinds = stagesFor(task.kind);
    const lastStage = this.stage(kinds[kinds.length - 1]!);
    this.setPhase(lastStage.kind, "finalizing", task.currentRound);
    const head = await workspace.head();
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
    task.phase = "done";
    hooks.emit({
      type: "info",
      text: task.result.approved ? "Workflow complete: final version approved by the reviewer." : "Workflow complete without final approval.",
    });
    hooks.update();
  }
}

export function phaseLabel(stage: StageKind | undefined, phase: Phase): string {
  if (phase === "authoring") return stage === "design" ? "Designing" : "Coding";
  if (phase === "reviewing") return stage === "design" ? "Reviewing design" : "Reviewing code";
  if (phase === "revising") return stage === "design" ? "Revising design" : "Addressing review comments";
  if (phase === "preparing") return "Preparing workspace";
  if (phase === "finalizing") return "Finalizing";
  if (phase === "done") return "Done";
  return "Queued";
}
