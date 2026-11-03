import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDriver, AgentHandle, AgentSpec, ReviewSubmissionInput, WorkSubmissionInput } from "../src/agents/driver.ts";
import { Bus } from "../src/bus.ts";
import type { HubSkills } from "../src/context.ts";
import { Store } from "../src/store.ts";
import type { AgentRole, Settings } from "../src/types.ts";
import { TaskRunner } from "../src/workflow/runner.ts";

export type Step = (spec: AgentSpec, prompt: string) => Promise<void> | void;

/** Fake agent driver: each role consumes scripted steps in order, across sessions and tasks. */
export class ScriptedDriver implements AgentDriver {
  readonly prompts: Partial<Record<AgentRole, string[]>> = {};
  readonly started: AgentSpec[] = [];
  private readonly script: Partial<Record<AgentRole, Step[]>>;
  private readonly cursor = new Map<AgentRole, number>();

  constructor(script: Partial<Record<AgentRole, Step[]>>) {
    this.script = script;
  }

  async start(spec: AgentSpec): Promise<AgentHandle> {
    this.started.push(spec);
    let rejectCurrent: ((error: Error) => void) | null = null;
    return {
      sessionId: `fake-${spec.role}-${this.started.length}`,
      send: async (prompt: string) => {
        (this.prompts[spec.role] ??= []).push(prompt);
        const index = this.cursor.get(spec.role) ?? 0;
        this.cursor.set(spec.role, index + 1);
        const step = this.script[spec.role]?.[index];
        if (!step) throw new Error(`No scripted step #${index + 1} for ${spec.role}`);
        const aborted = new Promise<never>((_, reject) => {
          rejectCurrent = reject;
        });
        await Promise.race([Promise.resolve(step(spec, prompt)), aborted]);
        return { lastMessage: `${spec.role} turn ${index + 1} done` };
      },
      abort: async () => {
        rejectCurrent?.(new Error("aborted"));
      },
      dispose: async () => {},
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

export const submitWork =
  (summary: string, responses: WorkSubmissionInput["comment_responses"] = []): Step =>
  async (spec) => {
    if (spec.submit.kind !== "work") throw new Error(`${spec.role} cannot submit work`);
    await spec.submit.onSubmit({ summary, validation: "tests: ok", comment_responses: responses });
  };

export const submitReview =
  (verdict: ReviewSubmissionInput["verdict"], comments: ReviewSubmissionInput["comments"] = []): Step =>
  async (spec) => {
    if (spec.submit.kind !== "review") throw new Error(`${spec.role} cannot submit a review`);
    await spec.submit.onSubmit({ verdict, summary: `${verdict} summary`, comments });
  };

/** Extracts the design document path the hub asked the designer to write. */
export const designPathFrom = (prompt: string): string => {
  const match = /`([^`]+\.md)` \(relative/.exec(prompt) ?? /document `([^`]+\.md)`/.exec(prompt);
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
  cleanup(): void;
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  files?: Record<string, string>;
  hubSkills?: HubSkills;
}

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
  store.updateSettings({ authorModel: "fake-author", reviewerModel: "fake-reviewer", maxRounds: 3, inputTimeoutMinutes: 1, ...options.settings });
  store.addRepo({ id: "sample", name: "sample", path: repoPath, defaultBranch: "main", remoteUrl: null, addedAt: new Date().toISOString() });
  const bus = new Bus();
  const driver = new ScriptedDriver(script);
  const worktreesDir = path.join(root, "data", "worktrees");
  const runner = new TaskRunner({
    store,
    bus,
    runtime: { isReady: () => true, deleteSessions: async () => {} },
    driver,
    worktreesDir,
    hubSkills: options.hubSkills,
  });
  return {
    root,
    store,
    bus,
    runner,
    driver,
    repoPath,
    worktreesDir,
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
