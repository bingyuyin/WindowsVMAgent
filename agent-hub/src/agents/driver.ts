import type { AgentRole, FailureCategory, Severity, StageKind, TestStatus, UnrelatedFailure, Verdict } from "../types.ts";

/** Arguments of the `submit_work` tool called by author agents (designer / writer / coder / resolver / fixer). */
export interface WorkSubmissionInput {
  summary: string;
  validation?: string;
  comment_responses?: Array<{ comment_id: string; status: "addressed" | "declined"; note: string }>;
  /** Coding stage: the unit tests the author ran, which the manager re-runs before the review. */
  unit_tests?: UnitTestsInput;
}

export interface UnitTestsInput {
  status: TestStatus;
  commands: string[];
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  reason?: string;
  unrelated_failures?: UnrelatedFailure[];
}

/** Arguments of the `submit_review` tool called by reviewer agents. */
export interface ReviewSubmissionInput {
  verdict: Verdict;
  summary: string;
  comments: Array<{ severity: Severity; file?: string; line?: number; body: string }>;
}

/** Arguments of the `submit_test_results` tool called by the test executor. */
export interface TestRunSubmissionInput {
  status: TestStatus;
  summary: string;
  commands: string[];
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  failures: Array<{ test: string; file?: string; line?: number; error: string; category: FailureCategory; suggestion?: string }>;
  unrelated_failures?: UnrelatedFailure[];
  log_excerpt?: string;
}

/** Arguments of the `submit_plan` tool called by the manager's planner. */
export interface PlanSubmissionInput {
  stages: StageKind[];
  rationale: string;
  instructions: Partial<Record<StageKind, string>>;
  /** What every sub-agent should know about the repository (absent in plans the hub derives itself). */
  briefing?: string;
}

/** The tools of the two code review reviewers, one per step of their discussion. */
export type CodeReviewTool = "submit_findings" | "submit_positions" | "submit_final_review" | "submit_signoff";

/**
 * How an agent hands its structured result back to the workflow. `onSubmit` validates the
 * payload and throws a descriptive error when it is unacceptable, so the agent can retry.
 */
export type SubmitChannel =
  | { kind: "work"; onSubmit: (input: WorkSubmissionInput) => void | Promise<void>; unitTests?: boolean }
  | { kind: "review"; onSubmit: (input: ReviewSubmissionInput) => void | Promise<void> }
  | { kind: "test"; onSubmit: (input: TestRunSubmissionInput) => void | Promise<void> }
  | { kind: "plan"; onSubmit: (input: PlanSubmissionInput) => void | Promise<void> }
  /** Code review reviewers: one tool per discussion step; the hub says which one each turn must call. */
  | { kind: "code-review"; tools: readonly CodeReviewTool[]; onSubmit: (tool: CodeReviewTool, input: unknown) => void | Promise<void> };

export interface ToolStartInfo {
  id: string;
  name: string;
  label: string;
  subAgent: boolean;
}

export interface ToolDoneInfo {
  id: string;
  name: string;
  success: boolean;
  error?: string;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  premiumRequests: number;
}

/** Receives live activity from an agent session. */
export interface AgentObserver {
  onDelta(messageId: string, text: string): void;
  onMessage(text: string): void;
  onIntent(text: string): void;
  onToolStart(info: ToolStartInfo): void;
  onToolDone(info: ToolDoneInfo): void;
  onUsage(usage: UsageInfo): void;
  onError(message: string): void;
  onInfo(message: string): void;
  /** Any session event (streaming, tool output, sub-agent work): the agent is alive. */
  onHeartbeat(): void;
}

export interface UserQuestion {
  question: string;
  choices: string[];
  allowFreeform: boolean;
}

export interface AgentSpec {
  taskId: string;
  role: AgentRole;
  model: string;
  title: string;
  workingDirectory: string;
  systemPrompt: string;
  /** Reviewers and the planner: no file writes, read-only commands only. */
  readOnly: boolean;
  /** Test executor: may run any build/test command, but must not edit files. */
  executeOnly?: boolean;
  /** Parent folders of <name>/SKILL.md skills: repository skill roots in the agent's worktree plus the hub's. */
  skillDirectories: string[];
  /** Hub skills that do not apply to this role. */
  disabledSkills: string[];
  submit: SubmitChannel;
  observer: AgentObserver;
  askUser: (question: UserQuestion) => Promise<string>;
  turnTimeoutMs: number;
}

export interface TurnResult {
  lastMessage?: string;
}

/** A turn ran past the turn timeout. The session may still be working on it, so abort it before reusing the session. */
export class TurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the turn ran longer than the ${Math.round(timeoutMs / 60_000)}-minute turn timeout`);
    this.name = "TurnTimeoutError";
  }
}

export interface AgentHandle {
  readonly sessionId: string;
  /** Sends a prompt and resolves when the agent's turn is complete. */
  send(prompt: string): Promise<TurnResult>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface AgentDriver {
  start(spec: AgentSpec): Promise<AgentHandle>;
}
