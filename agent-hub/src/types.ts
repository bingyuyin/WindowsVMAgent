/**
 * "auto": the manager agent reads the request and plans which stages (and sub-agents) to run.
 * "review": two reviewers review someone else's change (a pull request or a branch), discuss their findings
 * and agree on a final review that the user curates and publishes; no code is changed.
 */
export type TaskKind = "auto" | "coding" | "design" | "document" | "testing" | "design-coding" | "review";
export type TaskStatus = "queued" | "running" | "needs-input" | "completed" | "failed" | "cancelled" | "interrupted";
/** "testing": a test executor runs the test automation and verifies the results; a test fixer fixes failures. */
export type StageKind = "design" | "document" | "coding" | "testing";
export type AgentRole =
  | "planner"
  | "designer"
  | "design-reviewer"
  | "writer"
  | "doc-reviewer"
  | "coder"
  | "resolver"
  | "code-reviewer"
  | "executor"
  | "fixer"
  | "lead-reviewer"
  | "peer-reviewer";
export type Phase =
  | "queued"
  | "preparing"
  | "planning"
  | "authoring"
  | "verifying"
  | "reviewing"
  | "revising"
  | "discussing"
  | "consolidating"
  | "finalizing"
  | "done";
export type Severity = "blocker" | "major" | "minor" | "nit";
export type Verdict = "approve" | "request_changes";
export type CommentStatus = "open" | "addressed" | "declined";
export type StageStatus = "pending" | "running" | "approved" | "not-approved" | "failed" | "cancelled";
export type AgentStatus = "idle" | "working" | "done" | "failed" | "cancelled";
/** Outcome of one test-automation run reported by the test executor. */
export type TestStatus = "passed" | "failed" | "blocked";
/** Why a test failed, as triaged by the test executor. "integrity": a fix made a test pass without fixing the cause. */
export type FailureCategory = "product-bug" | "test-bug" | "environment" | "flaky" | "integrity" | "unknown";
/** File format of design/document deliverables. HTML documents are light-themed and can embed Mermaid diagrams. */
export type DocFormat = "html" | "markdown";
/**
 * Workspace isolation inside a task. "branch": author agents share one author worktree but each
 * works on its own branch (dependencies/build output are reused); reviewers use a separate
 * read-only worktree. "worktree": every sub-agent gets its own worktree and branch.
 */
export type IsolationMode = "branch" | "worktree";

export const TASK_KINDS: readonly TaskKind[] = ["auto", "coding", "design", "document", "testing", "design-coding", "review"];
/** Most tasks the hub runs at the same time; further tasks wait in the queue until a slot frees up. */
export const MAX_PARALLEL_TASKS = 10;
/** Order in which planned stages run: design first, documentation last (it documents the final state). */
export const STAGE_ORDER: readonly StageKind[] = ["design", "coding", "testing", "document"];
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor", "nit"];
export const ISOLATION_MODES: readonly IsolationMode[] = ["branch", "worktree"];
export const DOC_FORMATS: readonly DocFormat[] = ["html", "markdown"];
export const FAILURE_CATEGORIES: readonly FailureCategory[] = ["product-bug", "test-bug", "environment", "flaky", "integrity", "unknown"];

export interface Settings {
  authorModel: string | null;
  reviewerModel: string | null;
  /** Model for the comment-resolver agent; null means "same as the author model". */
  resolverModel: string | null;
  /** Model the manager uses to plan Auto tasks; null means "same as the author model". */
  managerModel: string | null;
  /** Code review tasks: model of the peer reviewer, who reviews alongside the lead reviewer (reviewer model); null means "same as the author model". */
  peerReviewerModel: string | null;
  maxRounds: number;
  maxConcurrency: number;
  designDocDir: string;
  /** Folder for Document tasks' deliverables, relative to the repository root. */
  documentDir: string;
  docFormat: DocFormat;
  turnTimeoutMinutes: number;
  /** Minutes without any sign of activity after which the manager recovers a working agent (interrupt, then restart). */
  stuckAgentMinutes: number;
  inputTimeoutMinutes: number;
  isolation: IsolationMode;
  /** Remove agent worktrees when a task completes (branches are always kept). */
  cleanupWorktrees: boolean;
  /** Re-queue tasks that were running when the hub stopped, once it is signed in again. */
  resumeInterruptedTasks: boolean;
  /** Push each task's branch to the repository's remote when the task completes. */
  pushOnComplete: boolean;
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
  /** Test failures only: the failing test and the executor's triage. */
  test?: string;
  category?: FailureCategory;
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
  /** Document stages: every document the round wrote or changed (the deliverable and any further documents), with its snapshot. */
  documents?: DocumentSnapshot[];
  /** Coding rounds: the author's unit tests, re-run by the manager before the review. */
  unitTests?: UnitTestCheck;
  at: string;
}

export interface ReviewSubmission {
  verdict: Verdict;
  summary: string;
  comments: ReviewComment[];
  /** Commit the reviewer's worktree was pinned to. */
  reviewedSha?: string;
  /** Testing stage only: the executor's run (commands, counts); failures are the comments. */
  testRun?: TestRunInfo;
  fallback?: boolean;
  /** "user": changes the user requested after the task finished (a round of its own, without an author turn). */
  by?: "user";
  at: string;
}

/** One run of the test automation, as executed and verified by the test executor. */
export interface TestRunInfo {
  status: TestStatus;
  /** Exact commands the executor ran. */
  commands: string[];
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  /** Relevant output (failure messages, summary lines). */
  logExcerpt?: string;
  /** Failing tests the requested change has nothing to do with: reported, and left for their owners to fix. */
  unrelatedFailures?: UnrelatedFailure[];
}

export interface UnrelatedFailure {
  test: string;
  /** Why it is unrelated, e.g. it fails without the change too, or it is flaky in code the change does not touch. */
  reason: string;
}

/**
 * Unit tests of a coding round: the author's report, checked by the manager re-running the commands in the
 * author's worktree before the review. passed: the manager's run passed; failed: it still failed after the
 * fix attempts; blocked: the author says the tests cannot run or pass for a reason outside the change.
 */
export interface UnitTestCheck extends TestRunInfo {
  /** Why the tests could not pass (blocked) or could not be checked. */
  reason?: string;
  /** True when the manager's own run of the commands passed. */
  verified?: boolean;
  /** How often failing tests went back to the author before the review. */
  fixAttempts: number;
  /** Commands that failed once and passed when the manager ran them again (flaky tests, not sent back to the author). */
  flaky?: string[];
  /** The manager's last run: exit code (null when it had to stop the command), duration and why it stopped. */
  exitCode?: number | null;
  durationMs?: number;
  stopped?: "timeout" | "silent" | "cancelled";
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
  docFormat?: DocFormat;
  /** Document stages: further documents the author wrote next to the deliverable (repository-relative paths). */
  extraDocs?: string[];
  nextCommentNumber: number;
  /** Testing stage: run the automation again before fixing (an earlier stage changed for a change request). */
  rerun?: boolean;
  startedAt?: string;
  finishedAt?: string;
}

/** A document a document-stage round wrote or changed, and the artifact holding its content as of that round. */
export interface DocumentSnapshot {
  path: string;
  snapshot: string;
}

// ---- Code review tasks ---------------------------------------------------------------------------

export type RemoteProvider = "github" | "azure-devops" | "gitlab" | "bitbucket" | "other";

/** The pull request a code review task reviews (or the open pull request of the reviewed branch). */
export interface ReviewPullRequest {
  provider: RemoteProvider;
  number: number;
  url?: string;
  title?: string;
  body?: string;
  author?: string;
  headBranch?: string;
  baseBranch?: string;
  draft?: boolean;
  state?: string;
  /** GitHub host and owner/repo, used to publish the review. */
  host?: string;
  slug?: string;
  /** Head commit of the pull request when it was looked up. */
  headSha?: string;
}

/** What a code review task reviews: merge-base(base, head)..head, the same change a pull request shows. */
export interface ReviewTarget {
  /** "pr": a pull/merge request fetched from the remote; "ref": a branch, tag or commit of the repository. */
  kind: "pr" | "ref";
  /** What the user entered: a pull request number or URL, or a branch, tag or commit. */
  input: string;
  /** Where the head came from, e.g. "refs/pull/12/head" or "feature/login". */
  headRef: string;
  headSha: string;
  /** Branch the change targets. */
  baseRef: string;
  /** Tip of the base branch when the review started (the review covers task.baseSha = merge-base..headSha). */
  baseTipSha: string;
  /** Remote the pull request was fetched from. */
  remote?: string;
  pullRequest?: ReviewPullRequest;
}

export type ReviewPhase = "findings" | "positions" | "final" | "signoff";
export type Position = "agree" | "disagree" | "refine";

/** A finding one of the two reviewers raised: L1, L2... (lead reviewer) or P1, P2... (peer reviewer). */
export interface ReviewerComment {
  id: string;
  severity: Severity;
  file?: string;
  line?: number;
  body: string;
  /** Discussion round it was raised in. */
  round: number;
  /** Its reviewer withdrew it during the discussion. */
  withdrawn?: { note: string; round: number };
  /** Its reviewer revised it during the discussion; `previous` is the text before. */
  revised?: { note: string; round: number; previous: { body: string; severity: Severity; line?: number } };
}

/** One reviewer's stance on a comment of the other reviewer. */
export interface PositionEntry {
  commentId: string;
  position: Position;
  note: string;
  suggestedBody?: string;
  suggestedSeverity?: Severity;
}

/** A comment of the final review: one or more reviewer comments merged into the text the change's author sees. */
export interface FinalComment {
  /** R1, R2... */
  id: string;
  severity: Severity;
  file?: string;
  line?: number;
  body: string;
  /** Reviewer comment IDs it came from (e.g. L2 and P1 when both found it). */
  sources: string[];
}

/** The review the lead reviewer consolidates from both reviewers' findings and their discussion. */
export interface FinalReview {
  changeSummary: string;
  assessment: string;
  verdict: Verdict;
  comments: FinalComment[];
  /** Reviewer comments left out of the final review, and why. */
  dropped: Array<{ commentId: string; reason: string }>;
  /** After the peer reviewer objected: the lead's answer to each objection. */
  objectionResponses?: Array<{ objection: string; response: string }>;
  fallback?: boolean;
}

export interface SignOff {
  agreed: boolean;
  summary: string;
  /** What the peer reviewer objects to: a final comment (R2), a dropped reviewer comment (P3), or the review as a whole. */
  objections: Array<{ commentId?: string; issue: string }>;
  fallback?: boolean;
}

/** One reviewer's turn in a discussion round. */
export interface ReviewerEntry {
  role: AgentRole;
  summary: string;
  at: string;
  /** The reviewer never called its submit tool; the hub derived the entry. */
  fallback?: boolean;
  /** findings: what the change does, and the reviewer's verdict. */
  changeSummary?: string;
  verdict?: Verdict;
  /** findings and positions: IDs of the comments the reviewer raised in this turn. */
  comments?: string[];
  /** positions: stances on the other reviewer's comments, and changes to its own. */
  positions?: PositionEntry[];
  updates?: Array<{ commentId: string; action: "withdraw" | "revise"; note: string }>;
  final?: FinalReview;
  signoff?: SignOff;
}

/** A discussion round: both reviewers (findings, positions), the lead (final) or the peer (signoff). */
export interface ReviewRound {
  n: number;
  phase: ReviewPhase;
  attempt: number;
  startedAt: string;
  entries: ReviewerEntry[];
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** How a comment was last published on the pull request. */
export interface PublishedComment {
  /** Inline comment on the pull request; absent when the comment went into the review's text (no diff line to attach it to). */
  remoteId?: number;
  url?: string;
  inline: boolean;
  /** The text as published (to detect later edits). */
  body: string;
  at: string;
}

/** A comment of the final review as the user curates it: keep, drop or edit it before publishing. */
export interface CuratedComment {
  id: string;
  severity: Severity;
  file?: string;
  line?: number;
  body: string;
  sources: string[];
  decision: "keep" | "drop";
  /** The reviewers' version, kept when the user edits the comment. */
  original?: { body: string; severity: Severity };
  /** The peer reviewer's objection to this comment when they did not agree. */
  objection?: string;
  /** Added by the user from a comment the reviewers dropped or disputed. */
  addedByUser?: boolean;
  published?: PublishedComment;
}

/** A review posted on the pull request. The first one holds the review text; later ones add comments created after it. */
export interface ReviewPublication {
  number: number;
  reviewId: number;
  url?: string;
  event: ReviewEvent;
  main: boolean;
  /** The review's text as last published. */
  body: string;
  at: string;
  updatedAt?: string;
}

export interface CodeReview {
  target: ReviewTarget;
  /** Files of the change: git diff --numstat base..head (null counts for binary files). */
  files?: Array<{ path: string; additions: number | null; deletions: number | null }>;
  shortStat?: string;
  commits?: number;
  rounds: ReviewRound[];
  /** Every comment either reviewer raised, as it stands after the discussion. */
  comments: ReviewerComment[];
  /** The latest final review by the lead reviewer. */
  final?: FinalReview;
  /** The peer reviewer's latest sign-off on it. */
  signoff?: SignOff;
  /** The user's working copy of the final review's comments. */
  curated?: CuratedComment[];
  /** Text published with the comments (starts as the change summary and assessment; the user may edit it). */
  body?: string;
  event?: ReviewEvent;
  publications?: ReviewPublication[];
  lastPublish?: { at: string; ok: boolean; message: string };
}
export interface ChangeRequest {
  /** Comment ID the agents respond to and reviewers verify, e.g. "U1". */
  id: string;
  text: string;
  /** Stage whose agents make the change; later stages then bring their work in line with it. */
  stage: StageKind;
  /** Round of that stage that holds the request. */
  round: number;
  /** Task attempt that works on the request. */
  attempt: number;
  /** Review rounds (or test runs) allowed per stage. */
  rounds: number;
  requestedAt: string;
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
  /** Deliverable document of the task's document stage (design doc or documentation). */
  docPath?: string;
  docFormat?: DocFormat;
  /** Latest test run of the testing stage. */
  tests?: TestRunInfo;
  /** Unit tests of the last coding round. */
  unitTests?: UnitTestCheck;
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
  /** Last sign of life (any session event, a new turn, an answer); the manager's monitor measures silence from it. */
  updatedAt?: string;
  /** Hub best-practice skills the agent was asked to load: its role's plus those for the repository's technologies. */
  skills?: string[];
  /** How often the manager had to recover this agent (interrupted or restarted a stuck or failed turn). */
  recoveries?: number;
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
  /** Hub best-practice skills for the detected technologies (given to agents that design, write, review or test code). */
  techSkills?: string[];
  discoveredAt: string;
}

/** The manager's plan for an Auto task: which stages (and so which sub-agents) to run, and their assignments. */
export interface TaskPlan {
  stages: StageKind[];
  rationale: string;
  /** The manager's assignment for each stage's agents (scope, acceptance criteria, commands to run). */
  instructions: Partial<Record<StageKind, string>>;
  /** What the manager learned about the repository while planning; every sub-agent starts with it. */
  briefing?: string;
  /** The request is to review an existing change: the manager assigned the two code reviewers instead of stages. */
  review?: PlannedReview;
  /** True when the planner never submitted a plan and the hub derived one from the request. */
  fallback?: boolean;
  plannedAt: string;
}

/** A code review the manager planned for an Auto task. */
export interface PlannedReview {
  /** The pull request (number or URL) or the branch to review, as the manager named it. */
  target: string;
  /** Branch the change is compared with, when the manager named one (pull requests use their own target branch). */
  base?: string;
  /** The manager's assignment for the reviewers: what to focus on. */
  instructions: string;
}

/** Last attempt to push the task branch to the repository's remote. */
export interface PushInfo {
  status: "pushing" | "pushed" | "failed" | "skipped";
  branch: string;
  /** Remote name and URL (credentials stripped). */
  remote?: string;
  remoteUrl?: string;
  /** Web page of the pushed branch, when the host is known. */
  webUrl?: string;
  /** Commit that was pushed. */
  sha?: string;
  /** Why the push failed or was skipped. */
  reason?: string;
  /** True for the automatic push when the task completed. */
  auto: boolean;
  at: string;
}

/** A pull request opened for the task branch. */
export interface PullRequestInfo {
  url: string;
  number?: number;
  draft?: boolean;
  base: string;
  createdAt: string;
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
  /** Model of the manager's planner (Auto tasks). */
  managerModel?: string;
  /** Code review tasks: model of the peer reviewer (the lead reviewer uses reviewerModel). */
  peerReviewerModel?: string;
  maxRounds: number;
  status: TaskStatus;
  phase: Phase;
  phaseStartedAt?: string;
  currentStage?: StageKind;
  currentRound: number;
  activity?: Activity;
  /** Auto tasks: the manager's plan (set once the planner has run). */
  plan?: TaskPlan;
  /** Code review tasks: the change under review, the reviewers' discussion, the final review and its publication. */
  review?: CodeReview;
  stages: Stage[];
  agents?: AgentInfo[];
  context?: RepoContext;
  pendingInput?: PendingInput;
  sessions: SessionRef[];
  error?: string;
  result?: TaskResult;
  /** Pushing the task branch to the remote (after completion, or on request). */
  push?: PushInfo;
  pullRequest?: PullRequestInfo;
  /** Changes the user requested after the task finished, oldest first. */
  changeRequests?: ChangeRequest[];
  usage: Usage;
  attempt: number;
  /** Review rounds allowed for the current attempt (set on continue/retry). */
  roundsBudget?: number;
  /** Consecutive automatic resumes after hub restarts (reset when the task finishes). */
  autoResumes?: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  /** When the latest attempt started (retries and change requests start new attempts). */
  attemptStartedAt?: string;
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

/** Kind of message in the manager's communication log with its sub-agents and the user. */
export type CommKind =
  | "lifecycle"
  | "plan"
  | "spawn"
  | "assign"
  | "submit"
  | "relay"
  | "verdict"
  | "nudge"
  | "monitor"
  | "recover"
  | "question"
  | "answer"
  | "release";

/** A participant in manager communication: the manager itself, the user, or a sub-agent role. */
export type CommParty = AgentRole | "manager" | "user";

export interface CommEntry {
  seq: number;
  ts: string;
  taskId: string;
  taskTitle: string;
  from: CommParty;
  to: CommParty;
  kind: CommKind;
  text: string;
  stage?: StageKind;
  round?: number;
}

export type NewCommEntry = Omit<CommEntry, "seq" | "ts" | "taskId" | "taskTitle">;

/** Stages of a task kind. Auto tasks have none until the manager has planned them. */
export function stagesFor(kind: TaskKind): StageKind[] {
  switch (kind) {
    case "auto":
      return [];
    case "coding":
      return ["coding"];
    case "design":
      return ["design"];
    case "document":
      return ["document"];
    case "testing":
      return ["testing"];
    case "design-coding":
      return ["design", "coding"];
    case "review":
      return [];
  }
}

/** Stages a task runs: the manager's plan for Auto tasks, otherwise fixed by the task kind. */
export function stageKindsOf(task: Pick<Task, "kind" | "plan">): StageKind[] {
  return task.plan?.stages ?? stagesFor(task.kind);
}

/** A code review of an existing change: a Code review task, or an Auto task the manager planned as one. */
export function isCodeReview(task: Pick<Task, "kind" | "review">): boolean {
  return task.kind === "review" || Boolean(task.review);
}

/** Stages whose deliverable is a document (design doc or other documentation) rather than code. */
export function isDocStage(kind: StageKind): boolean {
  return kind === "design" || kind === "document";
}

/** Agent that writes each round's changes (in the testing stage: the fixer). */
export function authorRoleFor(stage: StageKind): AgentRole {
  switch (stage) {
    case "design":
      return "designer";
    case "document":
      return "writer";
    case "testing":
      return "fixer";
    default:
      return "coder";
  }
}

/** Agent that addresses review comments: a dedicated resolver for code, the fixer for test failures, the document's author otherwise. */
export function resolverRoleFor(stage: StageKind): AgentRole {
  return stage === "coding" ? "resolver" : authorRoleFor(stage);
}

/** Agent that checks each round (in the testing stage: the executor, which runs and verifies the tests). */
export function reviewerRoleFor(stage: StageKind): AgentRole {
  switch (stage) {
    case "design":
      return "design-reviewer";
    case "document":
      return "doc-reviewer";
    case "testing":
      return "executor";
    default:
      return "code-reviewer";
  }
}

export function isReviewerRole(role: AgentRole): boolean {
  return role === "design-reviewer" || role === "code-reviewer" || role === "doc-reviewer" || isCodeReviewRole(role);
}

/** The two reviewers of a code review task. */
export const CODE_REVIEW_ROLES: readonly AgentRole[] = ["lead-reviewer", "peer-reviewer"];

export function isCodeReviewRole(role: AgentRole): boolean {
  return role === "lead-reviewer" || role === "peer-reviewer";
}

/** Agents that work in a checkout pinned to a commit (no branch of their own): reviewers, the executor and the planner. */
export function worksDetached(role: AgentRole): boolean {
  return isReviewerRole(role) || role === "executor" || role === "planner";
}

/** Sub-agents that run the given stages, in workflow order. */
export function rolesForStages(stages: readonly StageKind[]): AgentRole[] {
  const roles: AgentRole[] = [];
  for (const stage of stages) {
    const ordered = stage === "testing" ? ["executor", "fixer"] as AgentRole[] : [authorRoleFor(stage), reviewerRoleFor(stage), resolverRoleFor(stage)];
    for (const role of ordered) {
      if (!roles.includes(role)) roles.push(role);
    }
  }
  return roles;
}

/** Sub-agents a task of the given kind uses, in workflow order (Auto tasks start with the manager's planner). */
export function rolesFor(kind: TaskKind): AgentRole[] {
  if (kind === "review") return [...CODE_REVIEW_ROLES];
  return kind === "auto" ? ["planner"] : rolesForStages(stagesFor(kind));
}

export const ROLE_LABELS: Record<AgentRole, string> = {
  planner: "Planner",
  designer: "Designer",
  "design-reviewer": "Design reviewer",
  writer: "Technical writer",
  "doc-reviewer": "Doc reviewer",
  coder: "Coder",
  resolver: "Comment resolver",
  "code-reviewer": "Code reviewer",
  executor: "Test executor",
  fixer: "Test fixer",
  "lead-reviewer": "Lead reviewer",
  "peer-reviewer": "Peer reviewer",
};

export const ACTIVE_STATUSES: readonly TaskStatus[] = ["queued", "running", "needs-input"];
