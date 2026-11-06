import type {
  Activity,
  AgentInfo,
  Phase,
  PullRequestInfo,
  PushInfo,
  StageKind,
  StageStatus,
  Task,
  TaskKind,
  TaskStatus,
  TestRunInfo,
  TestStatus,
  Usage,
  Verdict,
} from "../types.ts";

export interface TaskSummary {
  id: string;
  title: string;
  kind: TaskKind;
  repoId: string;
  repoName: string;
  baseRef: string;
  branch?: string;
  status: TaskStatus;
  phase: Phase;
  phaseStartedAt?: string;
  currentStage?: StageKind;
  currentRound: number;
  maxRounds: number;
  roundsBudget?: number;
  activity?: Activity;
  authorModel: string;
  reviewerModel: string;
  resolverModel?: string;
  managerModel?: string;
  agents: Array<
    Pick<AgentInfo, "role" | "status" | "model" | "assignment" | "lastActivity" | "branch" | "updatedAt" | "turns" | "rounds" | "usage">
  >;
  approved: boolean | null;
  shortStat?: string;
  openComments?: number;
  docPath?: string;
  /** Auto tasks: the stages the manager planned (agents are created per stage), or the change it planned to review. */
  plan?: { stages: StageKind[]; rationale: string; fallback?: boolean; review?: { target: string } };
  tests?: Pick<TestRunInfo, "status" | "total" | "passed" | "failed" | "skipped">;
  push?: Pick<PushInfo, "status" | "remote" | "branch" | "webUrl" | "reason">;
  pullRequest?: Pick<PullRequestInfo, "url" | "number" | "draft">;
  /** Code review tasks: what is reviewed and where the review stands. */
  review?: {
    target: string;
    pullRequest?: { number: number; url?: string };
    comments: number;
    kept: number;
    agreed: boolean | null;
    published: boolean;
  };
  peerReviewerModel?: string;
  needsInput: boolean;
  error?: string;
  stages: Array<{
    kind: StageKind;
    status: StageStatus;
    rounds: Array<{ n: number; verdict: Verdict | null; comments: number; authored: boolean; testStatus?: TestStatus; byUser?: boolean }>;
  }>;
  usage: Usage;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export function summarizeTask(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    repoId: task.repoId,
    repoName: task.repoName,
    baseRef: task.baseRef,
    branch: task.branch,
    status: task.status,
    phase: task.phase,
    phaseStartedAt: task.phaseStartedAt,
    currentStage: task.currentStage,
    currentRound: task.currentRound,
    maxRounds: task.maxRounds,
    roundsBudget: task.roundsBudget,
    activity: task.activity,
    authorModel: task.authorModel,
    reviewerModel: task.reviewerModel,
    resolverModel: task.resolverModel,
    managerModel: task.managerModel,
    agents: (task.agents ?? []).map(({ role, status, model, assignment, lastActivity, branch, updatedAt, turns, rounds, usage }) => ({
      role,
      status,
      model,
      assignment,
      lastActivity,
      branch,
      updatedAt,
      turns,
      rounds,
      usage,
    })),
    approved: task.result ? task.result.approved : null,
    shortStat: task.result?.shortStat,
    openComments: task.result?.openComments,
    docPath: task.result?.docPath ?? task.stages.find((stage) => stage.docPath)?.docPath,
    plan: task.plan
      ? {
          stages: task.plan.stages,
          rationale: task.plan.rationale,
          fallback: task.plan.fallback,
          ...(task.plan.review ? { review: { target: task.plan.review.target } } : {}),
        }
      : undefined,
    tests: task.result?.tests
      ? {
          status: task.result.tests.status,
          total: task.result.tests.total,
          passed: task.result.tests.passed,
          failed: task.result.tests.failed,
          skipped: task.result.tests.skipped,
        }
      : undefined,
    push: task.push
      ? { status: task.push.status, remote: task.push.remote, branch: task.push.branch, webUrl: task.push.webUrl, reason: task.push.reason }
      : undefined,
    pullRequest: task.pullRequest ? { url: task.pullRequest.url, number: task.pullRequest.number, draft: task.pullRequest.draft } : undefined,
    review: task.review
      ? {
          target: task.review.target.pullRequest ? `#${task.review.target.pullRequest.number}` : task.review.target.headRef,
          pullRequest: task.review.target.pullRequest ? { number: task.review.target.pullRequest.number, url: task.review.target.pullRequest.url } : undefined,
          comments: task.review.curated?.length ?? task.review.final?.comments.length ?? 0,
          kept: task.review.curated?.filter((comment) => comment.decision === "keep").length ?? 0,
          agreed: task.review.signoff ? task.review.signoff.agreed : null,
          published: Boolean(task.review.publications?.some((publication) => publication.main)),
        }
      : undefined,
    peerReviewerModel: task.peerReviewerModel,
    needsInput: Boolean(task.pendingInput),
    error: task.error,
    stages: task.stages.map((stage) => ({
      kind: stage.kind,
      status: stage.status,
      rounds: stage.rounds.map((round) => ({
        n: round.n,
        verdict: round.review?.verdict ?? null,
        comments: round.review?.comments.length ?? 0,
        authored: Boolean(round.author),
        testStatus: round.review?.testRun?.status,
        byUser: round.review?.by === "user" || undefined,
      })),
    })),
    usage: task.usage,
    attempt: task.attempt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}
