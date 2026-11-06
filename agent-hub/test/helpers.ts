import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentDriver,
  AgentHandle,
  AgentSpec,
  PlanSubmissionInput,
  ReviewSubmissionInput,
  TestRunSubmissionInput,
  WorkSubmissionInput,
} from "../src/agents/driver.ts";
import { Bus } from "../src/bus.ts";
import type { HubSkills } from "../src/context.ts";
import type { DocTemplates } from "../src/docs.ts";
import { Store } from "../src/store.ts";
import type { PullRequestCreator, RemoteDetails } from "../src/remote.ts";
import type { CreatedReview, NewReview } from "../src/review/publish.ts";
import type { CommandRunner } from "../src/shell.ts";
import type { AgentRole, ReviewPullRequest, Settings } from "../src/types.ts";
import { TaskRunner, type ReviewHost } from "../src/workflow/runner.ts";

export type Step = (spec: AgentSpec, prompt: string) => Promise<void> | void;

/** Fake agent driver: each role consumes scripted steps in order, across sessions and tasks. */
export class ScriptedDriver implements AgentDriver {
  readonly prompts: Partial<Record<AgentRole, string[]>> = {};
  readonly started: AgentSpec[] = [];
  /** Session IDs whose handles were disposed (closed or killed). */
  readonly disposed: string[] = [];
  private readonly script: Partial<Record<AgentRole, Step[]>>;
  private readonly cursor = new Map<AgentRole, number>();

  constructor(script: Partial<Record<AgentRole, Step[]>>) {
    this.script = script;
  }

  async start(spec: AgentSpec): Promise<AgentHandle> {
    this.started.push(spec);
    const sessionId = `fake-${spec.role}-${this.started.length}`;
    let rejectCurrent: ((error: Error) => void) | null = null;
    return {
      sessionId,
      send: async (prompt: string) => {
        (this.prompts[spec.role] ??= []).push(prompt);
        const index = this.cursor.get(spec.role) ?? 0;
        this.cursor.set(spec.role, index + 1);
        const step = this.script[spec.role]?.[index];
        if (!step) throw new Error(`No scripted step #${index + 1} for ${spec.role}`);
        const aborted = new Promise<never>((_, reject) => {
          rejectCurrent = reject;
        });
        try {
          await Promise.race([Promise.resolve(step(spec, prompt)), aborted]);
        } finally {
          // A later abort() must not reject a promise nobody awaits (e.g. after a step threw synchronously).
          rejectCurrent = null;
        }
        return { lastMessage: `${spec.role} turn ${index + 1} done` };
      },
      abort: async () => {
        rejectCurrent?.(new Error("aborted"));
      },
      dispose: async () => {
        this.disposed.push(sessionId);
      },
    };
  }

  specsFor(role: AgentRole): AgentSpec[] {
    return this.started.filter((spec) => spec.role === role);
  }
}

export const steps =
  (...parts: Step[]): Step =>
  async (spec, prompt) => {
    for (const part of parts) await part(spec, prompt);
  };

export const writeFile =
  (relativePath: string, content: string): Step =>
  (spec) => {
    const file = path.join(spec.workingDirectory, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

export const PASSING_UNIT_TESTS: NonNullable<WorkSubmissionInput["unit_tests"]> = { status: "passed", commands: ["npm test"], total: 3, passed: 3, failed: 0 };

export const submitWork =
  (summary: string, responses: WorkSubmissionInput["comment_responses"] = [], unitTests: WorkSubmissionInput["unit_tests"] = PASSING_UNIT_TESTS): Step =>
  async (spec) => {
    if (spec.submit.kind !== "work") throw new Error(`${spec.role} cannot submit work`);
    await spec.submit.onSubmit({ summary, validation: "tests: ok", comment_responses: responses, unit_tests: unitTests });
  };

export const submitReview =
  (verdict: ReviewSubmissionInput["verdict"], comments: ReviewSubmissionInput["comments"] = []): Step =>
  async (spec) => {
    if (spec.submit.kind !== "review") throw new Error(`${spec.role} cannot submit a review`);
    await spec.submit.onSubmit({ verdict, summary: `${verdict} summary`, comments });
  };

export const submitTests =
  (
    status: TestRunSubmissionInput["status"],
    failures: TestRunSubmissionInput["failures"] = [],
    extra: Partial<TestRunSubmissionInput> = {},
  ): Step =>
  async (spec) => {
    if (spec.submit.kind !== "test") throw new Error(`${spec.role} cannot submit test results`);
    await spec.submit.onSubmit({
      status,
      summary: `Tests ${status}`,
      commands: status === "blocked" ? [] : ["npm test"],
      failures,
      ...extra,
    });
  };

export const submitPlan =
  (stages: string[], instructions: Record<string, string>, rationale = "Fits the request", briefing = "calc.js holds the math helpers; tests run with node --test."): Step =>
  async (spec) => {
    if (spec.submit.kind !== "plan") throw new Error(`${spec.role} cannot submit a plan`);
    await spec.submit.onSubmit({ stages, rationale, instructions, briefing } as unknown as PlanSubmissionInput);
  };

/** A turn that never finishes on its own (until the manager aborts it). */
export const hang: Step = () => new Promise<void>(() => {});

// ---- Code review reviewers -------------------------------------------------------------------------

type ReviewCommentStep = { severity: string; file?: string; line?: number; body: string };

const reviewStep =
  (tool: string, payload: (spec: AgentSpec) => Record<string, unknown>): Step =>
  async (spec) => {
    if (spec.submit.kind !== "code-review") throw new Error(`${spec.role} is not a code review reviewer`);
    await spec.submit.onSubmit(tool as never, payload(spec));
  };

export const submitFindings = (comments: ReviewCommentStep[], verdict: "approve" | "request_changes" = comments.length ? "request_changes" : "approve"): Step =>
  reviewStep("submit_findings", (spec) => ({ change_summary: `${spec.role}: adds greet()`, assessment: `${spec.role} assessment`, verdict, comments }));

export const submitPositions = (input: {
  responses?: Array<{ comment_id: string; position: string; note: string; suggested_body?: string; suggested_severity?: string }>;
  own_updates?: Array<{ comment_id: string; action: string; note: string; body?: string; severity?: string }>;
  new_comments?: ReviewCommentStep[];
}): Step => reviewStep("submit_positions", (spec) => ({ summary: `${spec.role} positions`, responses: [], ...input }));

export const submitFinal = (
  comments: Array<ReviewCommentStep & { sources: string[] }>,
  dropped: Array<{ comment_id: string; reason: string }> = [],
  extra: Record<string, unknown> = {},
): Step =>
  reviewStep("submit_final_review", () => ({
    change_summary: "Adds a greet() helper that builds a greeting.",
    assessment: "Small, focused change; one correctness issue.",
    verdict: comments.some((comment) => comment.severity === "blocker" || comment.severity === "major") ? "request_changes" : "approve",
    comments,
    dropped,
    ...extra,
  }));

export const submitSignoff = (agree: boolean, objections: Array<{ comment_id?: string; issue: string }> = []): Step =>
  reviewStep("submit_signoff", () => ({ agree, summary: agree ? "The final review is right." : "Something is missing.", objections }));

/** Records what the hub publishes, instead of calling GitHub. */
export class FakeReviewHost implements ReviewHost {
  readonly calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  problem: string | null = null;
  lookup: { pullRequest?: ReviewPullRequest | null; forBranch?: ReviewPullRequest | null } = {};
  /** Thrown by the next createReview call. */
  failNextCreate: Error | null = null;
  /** Created reviews come back without their comments' IDs (GitHub created them, but listing them failed). */
  forgetCommentIds = false;
  private nextReviewId = 100;
  private nextCommentId = 1000;

  async pullRequest(_remote: RemoteDetails, number: number): Promise<ReviewPullRequest | null> {
    this.calls.push({ method: "pullRequest", args: { number } });
    return this.lookup.pullRequest ?? null;
  }

  async forBranch(_remote: RemoteDetails, branch: string): Promise<ReviewPullRequest | null> {
    this.calls.push({ method: "forBranch", args: { branch } });
    return this.lookup.forBranch ?? null;
  }

  async unavailable(): Promise<string | null> {
    return this.problem;
  }

  async createReview(pr: ReviewPullRequest, review: NewReview): Promise<CreatedReview> {
    this.calls.push({ method: "createReview", args: { ...review } });
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const reviewId = this.nextReviewId++;
    return {
      reviewId,
      url: `https://github.com/${pr.slug}/pull/${pr.number}#pullrequestreview-${reviewId}`,
      comments: this.forgetCommentIds
        ? []
        : review.comments.map((comment) => {
            const id = this.nextCommentId++;
            return { id, path: comment.path, body: comment.body, url: `https://github.com/${pr.slug}/pull/${pr.number}#discussion_r${id}` };
          }),
    };
  }

  async updateReview(_pr: ReviewPullRequest, reviewId: number, body: string): Promise<void> {
    this.calls.push({ method: "updateReview", args: { reviewId, body } });
  }

  async updateComment(_pr: ReviewPullRequest, commentId: number, body: string): Promise<void> {
    this.calls.push({ method: "updateComment", args: { commentId, body } });
  }

  async deleteComment(_pr: ReviewPullRequest, commentId: number): Promise<void> {
    this.calls.push({ method: "deleteComment", args: { commentId } });
  }

  callsOf(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }
}

/** A GitHub pull request as the GitHub CLI reports it. */
export const githubPullRequest = (number: number, extra: Partial<ReviewPullRequest> = {}): ReviewPullRequest => ({
  provider: "github",
  number,
  host: "github.com",
  slug: "acme/sample",
  url: `https://github.com/acme/sample/pull/${number}`,
  ...extra,
});

/** Extracts the design/document path the hub asked the author to write. */
export const designPathFrom = (prompt: string): string => {
  const match = /`([^`]+\.(?:md|html))` \(relative/.exec(prompt) ?? /document `([^`]+\.(?:md|html))`/.exec(prompt);
  if (!match?.[1]) throw new Error("design path not found in prompt");
  return match[1];
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

export interface Harness {
  root: string;
  store: Store;
  bus: Bus;
  runner: TaskRunner;
  driver: ScriptedDriver;
  repoPath: string;
  worktreesDir: string;
  /** Commands the manager ran to verify unit tests (with the default fake runner, which passes them all). */
  commands: Array<{ command: string; cwd: string }>;
  /** Simulates signing the Copilot runtime in or out. */
  setReady(ready: boolean): void;
  /** Creates a runner as a restarted hub would (same store and driver). */
  newRunner(): TaskRunner;
  cleanup(): void;
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  files?: Record<string, string>;
  hubSkills?: HubSkills;
  docTemplates?: DocTemplates | null;
  ready?: boolean;
  pullRequests?: PullRequestCreator;
  /** Pull request lookups and review publishing for code review tasks. */
  reviewHost?: ReviewHost;
  /** How the manager runs unit test commands (default: a fake that records them and passes). */
  runCommand?: CommandRunner;
}

export const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "templates");

export function createHarness(script: Partial<Record<AgentRole, Step[]>>, options: HarnessOptions = {}): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-"));
  const repoPath = path.join(root, "repo");
  fs.mkdirSync(repoPath);
  git(repoPath, "init", "-q", "-b", "main");
  const files = { "README.md": "# Sample\n", ...options.files };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repoPath, file)), { recursive: true });
    fs.writeFileSync(path.join(repoPath, file), content);
  }
  git(repoPath, "add", "-A");
  git(repoPath, "commit", "-q", "-m", "initial");

  const store = new Store(path.join(root, "data"));
  store.load();
  store.updateSettings({
    authorModel: "fake-author",
    reviewerModel: "fake-reviewer",
    maxRounds: 3,
    inputTimeoutMinutes: 1,
    docFormat: "markdown",
    ...options.settings,
  });
  store.addRepo({ id: "sample", name: "sample", path: repoPath, defaultBranch: "main", remoteUrl: null, addedAt: new Date().toISOString() });
  const bus = new Bus();
  const driver = new ScriptedDriver(script);
  const worktreesDir = path.join(root, "data", "worktrees");
  let ready = options.ready ?? true;
  const commands: Harness["commands"] = [];
  const runCommand: CommandRunner =
    options.runCommand ??
    (async (command, { cwd }) => {
      commands.push({ command, cwd });
      return { exitCode: 0, durationMs: 1, output: "ok" };
    });
  const newRunner = () =>
    new TaskRunner({
      store,
      bus,
      runtime: { isReady: () => ready, deleteSessions: async () => {} },
      driver,
      worktreesDir,
      hubSkills: options.hubSkills,
      docTemplates: options.docTemplates,
      pullRequests: options.pullRequests,
      reviewHost: options.reviewHost,
      runCommand,
    });
  const runner = newRunner();
  return {
    root,
    store,
    bus,
    runner,
    driver,
    repoPath,
    worktreesDir,
    commands,
    setReady: (value) => {
      ready = value;
    },
    newRunner,
    cleanup: () => {
      store.flushAllSync();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const branchHead = (repoPath: string, branch: string): string => git(repoPath, "rev-parse", `refs/heads/${branch}`);
export const branchExists = (repoPath: string, branch: string): boolean => git(repoPath, "branch", "--list", branch).length > 0;

/**
 * Gives the sample repository an "origin" that looks like `url` (so the hub links to that host) while pushes
 * go to a local bare repository. Returns the bare repository's path.
 */
export function addRemote(h: Harness, url = "https://github.com/acme/sample.git"): string {
  const bare = path.join(h.root, "origin.git");
  git(h.root, "init", "-q", "--bare", bare);
  git(h.repoPath, "remote", "add", "origin", url);
  git(h.repoPath, "config", "remote.origin.pushurl", bare);
  return bare;
}

/** Runs git in a bare repository, naming it explicitly (as `safe.bareRepository=explicit` requires). */
export const bareGit = (bare: string, ...args: string[]): string => git(path.dirname(bare), `--git-dir=${bare}`, ...args);

/** Commits `files` on a new branch off main (the change a code review reviews), then checks main out again. Returns the branch head. */
export function featureBranch(h: Harness, branch: string, files: Record<string, string>, message = "Add greet"): string {
  git(h.repoPath, "checkout", "-q", "-b", branch);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(h.repoPath, file)), { recursive: true });
    fs.writeFileSync(path.join(h.repoPath, file), content);
  }
  git(h.repoPath, "add", "-A");
  git(h.repoPath, "commit", "-q", "-m", message);
  const sha = git(h.repoPath, "rev-parse", "HEAD");
  git(h.repoPath, "checkout", "-q", "main");
  return sha;
}
