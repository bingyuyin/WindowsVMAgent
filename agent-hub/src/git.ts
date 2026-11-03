import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

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

/** Creates (or re-attaches) an isolated worktree for a task branch. */
export async function addWorktree(root: string, worktreePath: string, branch: string, baseSha: string): Promise<void> {
  await git(root, ["worktree", "prune"], { allowFailure: true });
  if (fs.existsSync(worktreePath)) await fsp.rm(worktreePath, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
  if (await branchExists(root, branch)) {
    await git(root, ["worktree", "add", worktreePath, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
  }
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

/** Git operations bound to one task worktree. */
export interface Workspace {
  readonly path: string;
  readonly baseSha: string;
  commitAll(subject: string, body?: string): Promise<string | null>;
  head(): Promise<string>;
  shortStat(from: string, to: string): Promise<string>;
  diffStat(from: string, to: string): Promise<string>;
  diff(from: string, to: string, maxBytes: number, paths?: string[]): Promise<DiffText>;
  commitCount(from: string, to: string): Promise<number>;
  readFile(relativePath: string): Promise<string | null>;
  ensureDir(relativeDir: string): Promise<void>;
}

export class GitWorkspace implements Workspace {
  readonly path: string;
  readonly baseSha: string;

  constructor(worktreePath: string, baseSha: string) {
    this.path = worktreePath;
    this.baseSha = baseSha;
  }

  async commitAll(subject: string, body?: string): Promise<string | null> {
    await git(this.path, ["add", "-A"]);
    const staged = await git(this.path, ["diff", "--cached", "--quiet"], { allowFailure: true });
    if (staged.code === 0) return null;
    const email = await git(this.path, ["config", "user.email"], { allowFailure: true });
    const identity = email.stdout.trim() ? [] : HUB_IDENTITY;
    const message = ["-m", subject];
    if (body) message.push("-m", body);
    await git(this.path, [...identity, "commit", "--no-verify", "-q", ...message]);
    return this.head();
  }

  async head(): Promise<string> {
    return (await git(this.path, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async shortStat(from: string, to: string): Promise<string> {
    return (await git(this.path, ["diff", "--shortstat", from, to])).stdout.trim();
  }

  async diffStat(from: string, to: string): Promise<string> {
    return (await git(this.path, ["diff", "--stat=160", from, to])).stdout.trimEnd();
  }

  async diff(from: string, to: string, maxBytes: number, paths: string[] = []): Promise<DiffText> {
    const args = ["diff", "--no-color", "--no-ext-diff", from, to];
    if (paths.length) args.push("--", ...paths);
    const text = (await git(this.path, args)).stdout;
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
    return { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
  }

  async commitCount(from: string, to: string): Promise<number> {
    const result = await git(this.path, ["rev-list", "--count", `${from}..${to}`]);
    return Number(result.stdout.trim()) || 0;
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
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
