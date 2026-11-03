import type { AgentRole, FailureCategory, Severity, StageKind, TestStatus, Verdict } from "../types.ts";

/** Arguments of the `submit_work` tool called by author agents (designer / writer / coder / resolver / fixer). */
export interface WorkSubmissionInput {
  summary: string;
  validation?: string;
  comment_responses?: Array<{ comment_id: string; status: "addressed" | "declined"; note: string }>;
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
  log_excerpt?: string;
}

/** Arguments of the `submit_plan` tool called by the manager's planner. */
export interface PlanSubmissionInput {
  stages: StageKind[];
  rationale: string;
  instructions: Partial<Record<StageKind, string>>;
}

/**
 * How an agent hands its structured result back to the workflow. `onSubmit` validates the
 * payload and throws a descriptive error when it is unacceptable, so the agent can retry.
 */
export type SubmitChannel =
  | { kind: "work"; onSubmit: (input: WorkSubmissionInput) => void | Promise<void> }
  | { kind: "review"; onSubmit: (input: ReviewSubmissionInput) => void | Promise<void> }
  | { kind: "test"; onSubmit: (input: TestRunSubmissionInput) => void | Promise<void> }
  | { kind: "plan"; onSubmit: (input: PlanSubmissionInput) => void | Promise<void> };

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
