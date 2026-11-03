import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isReviewerRole, type AgentRole, type IsolationMode } from "./types.ts";

export class GitError extends Error {
  readonly stderr: string;
  readonly exitCode: number | string | null;
  constructor(message: string, stderr: string, exitCode: number | string | null) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  timeoutMs?: number;
  allowFailure?: boolean;
  maxBuffer?: number;
}

const HUB_IDENTITY = ["-c", "user.name=Copilot Agent Hub", "-c", "user.email=agent-hub@localhost"];

export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
        if (code === "ENOENT") {
          reject(new GitError("git executable not found on PATH", stderr, code));
          return;
        }
        if (options.allowFailure) {
          resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
          return;
        }
        const detail = (stderr || error.message).trim();
        reject(new GitError(`git ${args.join(" ")} failed: ${detail}`, stderr, code));
      },
    );
  });
}

export interface RepoInfo {
  root: string;
  branch: string | null;
  headSha: string | null;
  remoteUrl: string | null;
}

export async function inspectRepo(dir: string): Promise<RepoInfo> {
  if (!fs.existsSync(dir)) throw new Error(`Path does not exist: ${dir}`);
  const top = await git(dir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (top.code !== 0 || !top.stdout.trim()) throw new Error(`Not a git repository: ${dir}`);
  const root = path.resolve(top.stdout.trim());
  const [branch, head, remote] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true }),
    git(root, ["config", "--get", "remote.origin.url"], { allowFailure: true }),
  ]);
  return {
    root,
    branch: branch.stdout.trim() || null,
    headSha: head.stdout.trim() || null,
    remoteUrl: remote.stdout.trim() || null,
  };
}

export async function listBranches(root: string): Promise<string[]> {
  const result = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function resolveCommit(root: string, ref: string): Promise<string> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  const sha = result.stdout.trim();
  if (result.code !== 0 || !sha) throw new Error(`Cannot resolve '${ref}' to a commit`);
  return sha;
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true });
  return result.code === 0;
}

export async function isValidBranchName(root: string, name: string): Promise<boolean> {
  const result = await git(root, ["check-ref-format", "--branch", name], { allowFailure: true });
  return result.code === 0;
}

export async function uniqueBranchName(root: string, base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; await branchExists(root, candidate); i++) candidate = `${base}-${i}`;
  return candidate;
}

export async function isWorktree(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  const result = await git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (result.stdout.trim() !== "true") return false;
  const top = await git(dir, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  return path.resolve(top.stdout.trim()).toLowerCase() === path.resolve(dir).toLowerCase();
}

export async function removeWorktree(root: string, worktreePath: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", worktreePath], { allowFailure: true });
  if (fs.existsSync(worktreePath)) await fsp.rm(worktreePath, { recursive: true, force: true });
  await git(root, ["worktree", "prune"], { allowFailure: true });
}

export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, ["branch", "-D", branch], { allowFailure: true });
}

export async function cloneRepo(url: string, destination: string): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await git(path.dirname(destination), ["clone", "--", url, destination], { timeoutMs: 30 * 60_000 });
}

export interface DiffText {
  text: string;
  truncated: boolean;
}

export async function diffBetween(cwd: string, from: string, to: string, maxBytes: number, paths: string[] = []): Promise<DiffText> {
  const args = ["diff", "--no-color", "--no-ext-diff", from, to];
  if (paths.length) args.push("--", ...paths);
  const text = (await git(cwd, args)).stdout;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function diffStatBetween(cwd: string, from: string, to: string): Promise<string> {
  return (await git(cwd, ["diff", "--stat=160", from, to])).stdout.trimEnd();
}

export async function shortStatBetween(cwd: string, from: string, to: string): Promise<string> {
  return (await git(cwd, ["diff", "--shortstat", from, to])).stdout.trim();
}

export async function commitCountBetween(cwd: string, from: string, to: string): Promise<number> {
  return Number((await git(cwd, ["rev-list", "--count", `${from}..${to}`])).stdout.trim()) || 0;
}

/** Reads a file as of a commit (no checkout needed). */
export async function readFileAt(cwd: string, sha: string, relativePath: string): Promise<string | null> {
  const rel = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  const result = await git(cwd, ["show", `${sha}:${rel}`], { allowFailure: true, maxBuffer: 16 * 1024 * 1024 });
  return result.code === 0 ? result.stdout : null;
}

/** Turns a plain folder into a git repository with one commit of its current contents. */
export async function initRepository(dir: string): Promise<void> {
  await git(dir, ["init", "-q"]);
  await git(dir, ["add", "-A"]);
  await git(dir, [...(await identityArgs(dir)), "commit", "-q", "--allow-empty", "-m", "Initial commit (created by Copilot Agent Hub)"]);
}

export async function deleteBranchesWithPrefix(repoPath: string, prefix: string): Promise<void> {
  const result = await git(repoPath, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`], { allowFailure: true });
  for (const branch of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    await git(repoPath, ["branch", "-D", branch], { allowFailure: true });
  }
}

async function identityArgs(cwd: string): Promise<string[]> {
  const email = await git(cwd, ["config", "user.email"], { allowFailure: true });
  return email.stdout.trim() ? [] : HUB_IDENTITY;
}

/** Commits uncommitted leftovers in a worktree to a side branch so nothing is lost before a switch. */
async function preserveLeftovers(dir: string, sideBranch: string): Promise<boolean> {
  const status = await git(dir, ["status", "--porcelain"]);
  if (!status.stdout.trim()) return false;
  await git(dir, ["checkout", "-q", "-B", sideBranch]);
  await git(dir, ["add", "-A"]);
  await git(dir, [...(await identityArgs(dir)), "commit", "-q", "--no-verify", "-m", "agent-hub: preserved uncommitted leftovers"]);
  return true;
}

/** A worktree one agent works in: its own branch for authors, a detached checkout for reviewers. */
export interface AgentWorkspace {
  readonly role: AgentRole;
  readonly path: string;
  readonly branch: string | null;
  /** Set when leftover changes had to be moved aside while preparing the workspace. */
  readonly notice?: string;
  head(): Promise<string>;
  commitAll(subject: string, body?: string): Promise<string | null>;
  readFile(relativePath: string): Promise<string | null>;
  ensureDir(relativeDir: string): Promise<void>;
  writeFile(relativePath: string, content: string): Promise<void>;
}

/** Git state of one task: the task branch plus each sub-agent's own branch and worktree. */
export interface TaskWorkspace {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly taskBranch: string;
  readonly root: string;
  pathFor(role: AgentRole): string;
  branchFor(role: AgentRole): string | null;
  /** Puts the author's worktree on the author's own branch at the current task head. */
  prepareAuthor(role: AgentRole): Promise<AgentWorkspace>;
  /** Pins the reviewer's own worktree (detached, read-only use) to the commit under review. */
  prepareReviewer(role: AgentRole, sha: string): Promise<AgentWorkspace>;
  taskHead(): Promise<string>;
  /** Fast-forwards the task branch from `from` to `to` (compare-and-swap). */
  advance(from: string, to: string): Promise<void>;
  shortStat(from: string, to: string): Promise<string>;
  diffStat(from: string, to: string): Promise<string>;
  diff(from: string, to: string, maxBytes: number, paths?: string[]): Promise<DiffText>;
  commitCount(from: string, to: string): Promise<number>;
  readAt(sha: string, relativePath: string): Promise<string | null>;
  removeWorktrees(): Promise<void>;
}

export interface TaskWorkspaceOptions {
  repoPath: string;
  baseSha: string;
  taskBranch: string;
  root: string;
  isolation: IsolationMode;
  /** Serializes worktree administration on the repository (shared by all tasks on it). */
  lock: <T>(work: () => Promise<T>) => Promise<T>;
}

export class GitTaskWorkspace implements TaskWorkspace {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly taskBranch: string;
  readonly root: string;
  private readonly isolation: IsolationMode;
  private readonly lock: TaskWorkspaceOptions["lock"];

  constructor(options: TaskWorkspaceOptions) {
    this.repoPath = options.repoPath;
    this.baseSha = options.baseSha;
    this.taskBranch = options.taskBranch;
    this.root = options.root;
    this.isolation = options.isolation;
    this.lock = options.lock;
  }

  pathFor(role: AgentRole): string {
    if (this.isolation === "worktree") return path.join(this.root, role);
    return path.join(this.root, isReviewerRole(role) ? "review" : "author");
  }

  branchFor(role: AgentRole): string | null {
    return isReviewerRole(role) ? null : `${this.taskBranch}--${role}`;
  }

  /** Creates the task branch at the base commit when it does not exist yet. */
  async ensureTaskBranch(): Promise<void> {
    if (!(await branchExists(this.repoPath, this.taskBranch))) await git(this.repoPath, ["branch", this.taskBranch, this.baseSha]);
  }

  /** Removes a pre-v2 single worktree (on the task branch itself) so agents get their own branches. */
  async migrateLegacyWorktree(): Promise<boolean> {
    return this.lock(async () => {
      if (!(await isWorktree(this.root))) return false;
      await preserveLeftovers(this.root, `${this.taskBranch}--legacy-wip-${Date.now()}`);
      await removeWorktree(this.repoPath, this.root);
      return true;
    });
  }

  taskHead(): Promise<string> {
    return resolveCommit(this.repoPath, `refs/heads/${this.taskBranch}`);
  }

  prepareAuthor(role: AgentRole): Promise<AgentWorkspace> {
    const dir = this.pathFor(role);
    const branch = this.branchFor(role);
    if (!branch) throw new Error(`${role} is not an author role`);
    return this.lock(async () => {
      const head = await this.taskHead();
      let notice: string | undefined;
      if (!(await isWorktree(dir))) {
        await this.addWorktree(dir, ["-B", branch, dir, head]);
      } else {
        const [current, currentHead] = await Promise.all([
          git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true }),
          git(dir, ["rev-parse", "HEAD"]),
        ]);
        // The same agent resuming an interrupted turn keeps its uncommitted work; otherwise switch cleanly.
        if (current.stdout.trim() !== branch || currentHead.stdout.trim() !== head) {
          const sideBranch = `${branch}-wip-${Date.now()}`;
          if (await preserveLeftovers(dir, sideBranch)) notice = `Uncommitted leftovers were preserved on branch ${sideBranch}.`;
          await git(dir, ["checkout", "-q", "-B", branch, head]);
        }
      }
      return new GitAgentWorkspace(role, dir, branch, notice);
    });
  }

  prepareReviewer(role: AgentRole, sha: string): Promise<AgentWorkspace> {
    const dir = this.pathFor(role);
    return this.lock(async () => {
      if (!(await isWorktree(dir))) {
        await this.addWorktree(dir, ["--detach", dir, sha]);
      } else {
        await git(dir, ["checkout", "-q", "--detach", "--force", sha]);
        await git(dir, ["clean", "-fdq"]);
      }
      return new GitAgentWorkspace(role, dir, null);
    });
  }

  private async addWorktree(dir: string, args: string[]): Promise<void> {
    await git(this.repoPath, ["worktree", "prune"], { allowFailure: true });
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(dir), { recursive: true });
    await git(this.repoPath, ["worktree", "add", ...args]);
  }

  async advance(from: string, to: string): Promise<void> {
    if (from === to) return;
    const ancestor = await git(this.repoPath, ["merge-base", "--is-ancestor", from, to], { allowFailure: true });
    if (ancestor.code !== 0) {
      throw new Error(`Cannot fast-forward ${this.taskBranch}: ${to.slice(0, 10)} does not build on ${from.slice(0, 10)}.`);
    }
    await git(this.repoPath, ["update-ref", `refs/heads/${this.taskBranch}`, to, from]);
  }

  shortStat(from: string, to: string): Promise<string> {
    return shortStatBetween(this.repoPath, from, to);
  }

  diffStat(from: string, to: string): Promise<string> {
    return diffStatBetween(this.repoPath, from, to);
  }

  diff(from: string, to: string, maxBytes: number, paths: string[] = []): Promise<DiffText> {
    return diffBetween(this.repoPath, from, to, maxBytes, paths);
  }

  commitCount(from: string, to: string): Promise<number> {
    return commitCountBetween(this.repoPath, from, to);
  }

  readAt(sha: string, relativePath: string): Promise<string | null> {
    return readFileAt(this.repoPath, sha, relativePath);
  }

  removeWorktrees(): Promise<void> {
    return this.lock(async () => {
      if (fs.existsSync(this.root)) {
        if (await isWorktree(this.root)) await removeWorktree(this.repoPath, this.root);
        else {
          for (const entry of await fsp.readdir(this.root)) {
            const dir = path.join(this.root, entry);
            if (await isWorktree(dir)) await removeWorktree(this.repoPath, dir);
          }
        }
        await fsp.rm(this.root, { recursive: true, force: true });
      }
      await git(this.repoPath, ["worktree", "prune"], { allowFailure: true });
    });
  }
}

export class GitAgentWorkspace implements AgentWorkspace {
  readonly role: AgentRole;
  readonly path: string;
  readonly branch: string | null;
  readonly notice?: string;

  constructor(role: AgentRole, worktreePath: string, branch: string | null, notice?: string) {
    this.role = role;
    this.path = worktreePath;
    this.branch = branch;
    this.notice = notice;
  }

  async head(): Promise<string> {
    return (await git(this.path, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async commitAll(subject: string, body?: string): Promise<string | null> {
    await git(this.path, ["add", "-A"]);
    const staged = await git(this.path, ["diff", "--cached", "--quiet"], { allowFailure: true });
    if (staged.code === 0) return null;
    const message = ["-m", subject];
    if (body) message.push("-m", body);
    await git(this.path, [...(await identityArgs(this.path)), "commit", "--no-verify", "-q", ...message]);
    return this.head();
  }

  async readFile(relativePath: string): Promise<string | null> {
    const full = path.resolve(this.path, relativePath);
    if (!isInside(this.path, full)) return null;
    try {
      return await fsp.readFile(full, "utf8");
    } catch {
      return null;
    }
  }

  async ensureDir(relativeDir: string): Promise<void> {
    const full = path.resolve(this.path, relativeDir);
    if (!isInside(this.path, full)) throw new Error(`Directory is outside the worktree: ${relativeDir}`);
    await fsp.mkdir(full, { recursive: true });
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const full = path.resolve(this.path, relativePath);
    if (!isInside(this.path, full)) throw new Error(`File is outside the worktree: ${relativePath}`);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, content, "utf8");
  }
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
