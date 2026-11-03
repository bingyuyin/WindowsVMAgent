export type TaskKind = "coding" | "design" | "design-coding";
export type TaskStatus = "queued" | "running" | "needs-input" | "completed" | "failed" | "cancelled" | "interrupted";
export type StageKind = "design" | "coding";
export type AgentRole = "designer" | "design-reviewer" | "coder" | "resolver" | "code-reviewer";
export type Phase = "queued" | "preparing" | "authoring" | "reviewing" | "revising" | "finalizing" | "done";
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Verdict = "approve" | "request_changes";
export type CommentStatus = "open" | "addressed" | "declined";
export type StageStatus = "pending" | "running" | "approved" | "not-approved" | "failed" | "cancelled";
export type AgentStatus = "idle" | "working" | "done" | "failed" | "cancelled";
/**
 * Workspace isolation inside a task. "branch": author agents share one author worktree but each
 * works on its own branch (dependencies/build output are reused); reviewers use a separate
 * read-only worktree. "worktree": every sub-agent gets its own worktree and branch.
 */
export type IsolationMode = "branch" | "worktree";

export const TASK_KINDS: readonly TaskKind[] = ["coding", "design", "design-coding"];
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor", "nit"];
export const ISOLATION_MODES: readonly IsolationMode[] = ["branch", "worktree"];

export interface Settings {
  authorModel: string | null;
  reviewerModel: string | null;
  /** Model for the comment-resolver agent; null means "same as the author model". */
  resolverModel: string | null;
  maxRounds: number;
  maxConcurrency: number;
  designDocDir: string;
  turnTimeoutMinutes: number;
  inputTimeoutMinutes: number;
  isolation: IsolationMode;
  /** Remove agent worktrees when a task completes (branches are always kept). */
  cleanupWorktrees: boolean;
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
  /** Which author agent produced this round (designer, coder or resolver). */
  role?: AgentRole;
  /** The author agent's own branch the round was committed on. */
  branch?: string;
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
  /** Commit the reviewer's worktree was pinned to. */
  reviewedSha?: string;
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

/** Live state of one sub-agent working on a task (shown in the UI's Agents panel). */
export interface AgentInfo {
  role: AgentRole;
  model: string;
  status: AgentStatus;
  /** Worktree the agent works in. */
  workspace?: string;
  workspaceRemoved?: boolean;
  /** The agent's own branch; null for reviewers, which use a detached worktree at the reviewed commit. */
  branch?: string | null;
  sessionId?: string;
  turns: number;
  rounds: number[];
  /** What the agent is assigned to right now, e.g. "Addressing 2 review comments (round 2)". */
  assignment?: string;
  lastActivity?: string;
  lastMessage?: string;
  updatedAt?: string;
  usage: Usage;
}

export interface ContextSkill {
  name: string;
  description: string;
  /** Repository-relative path for repo skills; skill folder name for hub skills. */
  path: string;
  source: "repo" | "hub";
}

/** Guidance the hub found in the repository at the task's base commit. */
export interface RepoContext {
  instructions: string[];
  guides: string[];
  designDocs: string[];
  skills: ContextSkill[];
  /** Repository-relative skill folders (parents of <name>/SKILL.md) passed to agents. */
  skillRoots: string[];
  validation: string[];
  stack: string[];
  discoveredAt: string;
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
  /** Final task branch; the hub fast-forwards it to each author round's commit. */
  branch?: string;
  /** Legacy single-worktree path (tasks created before per-agent workspaces). */
  worktreePath?: string;
  /** Folder holding this task's agent worktrees. */
  workspaceRoot?: string;
  isolation?: IsolationMode;
  /** 2 = per-agent branches/worktrees. */
  layout?: number;
  authorModel: string;
  reviewerModel: string;
  resolverModel?: string;
  maxRounds: number;
  status: TaskStatus;
  phase: Phase;
  phaseStartedAt?: string;
  currentStage?: StageKind;
  currentRound: number;
  activity?: Activity;
  stages: Stage[];
  agents?: AgentInfo[];
  context?: RepoContext;
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

/** Agent that addresses review comments: a dedicated resolver for code, the designer for designs. */
export function resolverRoleFor(stage: StageKind): AgentRole {
  return stage === "design" ? "designer" : "resolver";
}

export function reviewerRoleFor(stage: StageKind): AgentRole {
  return stage === "design" ? "design-reviewer" : "code-reviewer";
}

export function isReviewerRole(role: AgentRole): boolean {
  return role === "design-reviewer" || role === "code-reviewer";
}

/** Sub-agents a task of the given kind uses, in workflow order. */
export function rolesFor(kind: TaskKind): AgentRole[] {
  const roles: AgentRole[] = [];
  for (const stage of stagesFor(kind)) {
    for (const role of [authorRoleFor(stage), reviewerRoleFor(stage), resolverRoleFor(stage)]) {
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  designer: "Designer",
  "design-reviewer": "Design reviewer",
  coder: "Coder",
  resolver: "Comment resolver",
  "code-reviewer": "Code reviewer",
};

export const ACTIVE_STATUSES: readonly TaskStatus[] = ["queued", "running", "needs-input"];
