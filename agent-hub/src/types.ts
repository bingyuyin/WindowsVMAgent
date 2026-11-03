export type TaskKind = "coding" | "design" | "design-coding";
export type TaskStatus = "queued" | "running" | "needs-input" | "completed" | "failed" | "cancelled" | "interrupted";
export type StageKind = "design" | "coding";
export type AgentRole = "designer" | "design-reviewer" | "coder" | "code-reviewer";
export type Phase = "queued" | "preparing" | "authoring" | "reviewing" | "revising" | "finalizing" | "done";
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Verdict = "approve" | "request_changes";
export type CommentStatus = "open" | "addressed" | "declined";
export type StageStatus = "pending" | "running" | "approved" | "not-approved" | "failed" | "cancelled";

export const TASK_KINDS: readonly TaskKind[] = ["coding", "design", "design-coding"];
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor", "nit"];

export interface Settings {
  authorModel: string | null;
  reviewerModel: string | null;
  maxRounds: number;
  maxConcurrency: number;
  designDocDir: string;
  turnTimeoutMinutes: number;
  inputTimeoutMinutes: number;
}

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  remoteUrl: string | null;
  addedAt: string;
}

export interface ReviewComment {
  id: string;
  severity: Severity;
  file?: string;
  line?: number;
  body: string;
  status: CommentStatus;
  response?: string;
}

export interface CommentResponse {
  commentId: string;
  status: "addressed" | "declined";
  note: string;
}

export interface AuthorSubmission {
  summary: string;
  validation?: string;
  responses: CommentResponse[];
  /** True when the agent never called submit_work and the hub derived the submission. */
  fallback?: boolean;
  commit?: string | null;
  prevCommit?: string;
  shortStat?: string;
  /** Artifact file name holding the design document snapshot for this round. */
  docSnapshot?: string;
  at: string;
}

export interface ReviewSubmission {
  verdict: Verdict;
  summary: string;
  comments: ReviewComment[];
  fallback?: boolean;
  at: string;
}

export interface Round {
  n: number;
  attempt: number;
  startedAt: string;
  author?: AuthorSubmission;
  review?: ReviewSubmission;
}

export interface Stage {
  kind: StageKind;
  status: StageStatus;
  rounds: Round[];
  docPath?: string;
  nextCommentNumber: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface PendingInput {
  id: string;
  role: AgentRole;
  question: string;
  choices: string[];
  allowFreeform: boolean;
  askedAt: string;
}

export interface Activity {
  role: AgentRole;
  text: string;
  at: string;
}

export interface TaskResult {
  approved: boolean;
  summary: string;
  headSha?: string;
  diffStat?: string;
  shortStat?: string;
  commits?: number;
  designDocPath?: string;
  openComments: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Sum of model billing multipliers reported by the runtime (premium requests). */
  premiumRequests: number;
  modelCalls: number;
}

export interface SessionRef {
  role: AgentRole;
  sessionId: string;
  attempt: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  kind: TaskKind;
  repoId: string;
  repoName: string;
  baseRef: string;
  baseSha?: string;
  branch?: string;
  worktreePath?: string;
  authorModel: string;
  reviewerModel: string;
  maxRounds: number;
  status: TaskStatus;
  phase: Phase;
  currentStage?: StageKind;
  currentRound: number;
  activity?: Activity;
  stages: Stage[];
  pendingInput?: PendingInput;
  sessions: SessionRef[];
  error?: string;
  result?: TaskResult;
  usage: Usage;
  attempt: number;
  /** Review rounds allowed for the current attempt (set on continue/retry). */
  roundsBudget?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastSeq: number;
}

export type TaskEventType =
  | "status"
  | "phase"
  | "info"
  | "warning"
  | "error"
  | "agent.message"
  | "tool.start"
  | "tool.done"
  | "submission"
  | "review"
  | "commit"
  | "input.request"
  | "input.answer";

export interface TaskEvent {
  seq: number;
  ts: string;
  type: TaskEventType;
  role?: AgentRole;
  stage?: StageKind;
  round?: number;
  text: string;
  data?: Record<string, unknown>;
}

export type NewTaskEvent = Omit<TaskEvent, "seq" | "ts">;

export function stagesFor(kind: TaskKind): StageKind[] {
  switch (kind) {
    case "coding":
      return ["coding"];
    case "design":
      return ["design"];
    case "design-coding":
      return ["design", "coding"];
  }
}

export function authorRoleFor(stage: StageKind): AgentRole {
  return stage === "design" ? "designer" : "coder";
}

export function reviewerRoleFor(stage: StageKind): AgentRole {
  return stage === "design" ? "design-reviewer" : "code-reviewer";
}

export function isReviewerRole(role: AgentRole): boolean {
  return role === "design-reviewer" || role === "code-reviewer";
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  designer: "Designer",
  "design-reviewer": "Design reviewer",
  coder: "Coder",
  "code-reviewer": "Code reviewer",
};

export const ACTIVE_STATUSES: readonly TaskStatus[] = ["queued", "running", "needs-input"];
