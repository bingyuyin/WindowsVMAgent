import type { Activity, Phase, StageKind, StageStatus, Task, TaskKind, TaskStatus, Usage, Verdict } from "../types.ts";

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
  currentStage?: StageKind;
  currentRound: number;
  maxRounds: number;
  roundsBudget?: number;
  activity?: Activity;
  authorModel: string;
  reviewerModel: string;
  approved: boolean | null;
  needsInput: boolean;
  error?: string;
  stages: Array<{
    kind: StageKind;
    status: StageStatus;
    rounds: Array<{ n: number; verdict: Verdict | null; comments: number; authored: boolean }>;
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
    currentStage: task.currentStage,
    currentRound: task.currentRound,
    maxRounds: task.maxRounds,
    roundsBudget: task.roundsBudget,
    activity: task.activity,
    authorModel: task.authorModel,
    reviewerModel: task.reviewerModel,
    approved: task.result ? task.result.approved : null,
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
