import path from "node:path";
import { isInside } from "../git.ts";

/** Structural subset of the SDK's PermissionRequest union used by the policy. */
export interface PermissionRequestLike {
  kind: string;
  fullCommandText?: string;
  commands?: ReadonlyArray<{ identifier: string; readOnly: boolean }>;
  commandSegments?: ReadonlyArray<{ fullCommandText: string; identifier: string }>;
  hasWriteFileRedirection?: boolean;
  fileName?: string;
  path?: string;
  resolvedPath?: string;
  readOnly?: boolean;
}

export type PolicyDecision = { kind: "approve-once" } | { kind: "reject"; feedback: string };

export interface PolicyOptions {
  readOnly: boolean;
  workingDirectory: string;
  /** Agent scratch space outside the repository (the runtime's session-state folder). */
  scratchRoots?: readonly string[];
}

const APPROVE: PolicyDecision = { kind: "approve-once" };
const reject = (feedback: string): PolicyDecision => ({ kind: "reject", feedback });
const inScratch = (target: string, options: PolicyOptions) => (options.scratchRoots ?? []).some((root) => isInside(root, target));

const GIT_OPTIONS_WITH_VALUE = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const REVIEWER_GIT_ALLOWED = new Set([
  "diff", "log", "show", "status", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "cat-file",
  "shortlog", "describe", "merge-base", "name-rev", "whatchanged", "help", "version", "--version", "range-diff",
]);

export function createPermissionPolicy(options: PolicyOptions): (request: PermissionRequestLike) => PolicyDecision {
  return (request) => evaluatePermission(request, options);
}

export function evaluatePermission(request: PermissionRequestLike, options: PolicyOptions): PolicyDecision {
  const cwd = options.workingDirectory;
  switch (request.kind) {
    case "write": {
      const raw = request.resolvedPath ?? request.fileName;
      const target = raw ? path.resolve(cwd, raw) : null;
      if (target && inScratch(target, options)) return APPROVE;
      if (options.readOnly) {
        return reject("You are a read-only reviewer: do not create or modify files. Report problems as review comments in submit_review.");
      }
      if (target && !isInside(cwd, target)) {
        return reject(`Writes are only allowed inside the task worktree (${cwd}).`);
      }
      return APPROVE;
    }
    case "read": {
      const raw = request.resolvedPath ?? request.path;
      const target = raw ? path.resolve(cwd, raw) : null;
      if (target && !isInside(cwd, target) && !inScratch(target, options)) {
        return reject(`Reads are limited to the task worktree (${cwd}).`);
      }
      return APPROVE;
    }
    case "shell":
      return evaluateShell(request, options);
    case "memory":
      return reject("Persistent memory is disabled for hub agents.");
    case "url":
    case "custom-tool":
    case "hook":
      return APPROVE;
    case "mcp":
      return options.readOnly && request.readOnly === false ? reject("Read-only reviewer: only read-only MCP tools are allowed.") : APPROVE;
    default:
      return options.readOnly ? reject(`Read-only reviewer: '${request.kind}' operations are not allowed.`) : APPROVE;
  }
}

function evaluateShell(request: PermissionRequestLike, options: PolicyOptions): PolicyDecision {
  const sources = request.commandSegments?.length
    ? request.commandSegments.map((segment) => segment.fullCommandText)
    : [request.fullCommandText ?? ""];
  // Runtimes may report a whole PowerShell line as one segment, so split again ourselves.
  const segments = sources.flatMap(splitCommandText);

  for (const segment of segments) {
    const gitCommand = parseGitCommand(segment);
    if (!gitCommand) continue;
    const problem = options.readOnly ? reviewerGitProblem(gitCommand) : authorGitProblem(gitCommand);
    if (problem) return reject(problem);
  }

  if (options.readOnly) {
    if (request.hasWriteFileRedirection) {
      return reject("Read-only reviewer: commands that write files (output redirection) are not allowed.");
    }
    const runtimeReadOnly = new Set(
      (request.commands ?? []).filter((command) => command.readOnly).map((command) => executableName(command.identifier)),
    );
    for (const segment of segments) {
      const executable = segmentExecutable(segment);
      if (!executable || executable === "git") continue;
      if (READ_ONLY_EXECUTABLES.has(executable) || runtimeReadOnly.has(executable)) continue;
      return reject(
        `Read-only reviewer: '${executable}' may have side effects. Inspect code with read-only tools (view/grep/glob, git diff/log/show) and rely on the author's reported validation.`,
      );
    }
  }
  return APPROVE;
}

/** Commands a read-only reviewer may run (PowerShell cmdlets/aliases and common POSIX tools). */
const READ_ONLY_EXECUTABLES = new Set([
  "get-content", "gc", "cat", "type", "get-childitem", "gci", "ls", "dir", "select-string", "sls", "get-item", "gi",
  "get-itemproperty", "test-path", "resolve-path", "get-location", "pwd", "measure-object", "measure", "select-object",
  "select", "sort-object", "sort", "where-object", "where", "format-table", "ft", "format-list", "fl", "out-string",
  "write-output", "echo", "write-host", "get-filehash", "compare-object", "group-object", "convertfrom-json",
  "convertto-json", "get-date", "split-path", "join-path", "set-location", "sl", "cd", "chdir", "push-location",
  "pushd", "pop-location", "popd", "head", "tail", "less", "more", "wc", "grep", "rg", "tree", "file", "stat", "diff",
  "cmp", "du", "which", "findstr", "realpath", "basename", "dirname", "uniq", "cut", "jq",
]);

function executableName(token: string): string {
  return (token.replace(/^["']|["']$/g, "").split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

function segmentExecutable(segment: string): string | null {
  const tokens = tokenize(segment).filter((token) => token !== "&" && !/^\w+=/.test(token));
  return tokens[0] ? executableName(tokens[0]) : null;
}

export interface GitCommand {
  subcommand: string;
  args: string[];
}

export function parseGitCommand(segment: string): GitCommand | null {
  const tokens = tokenize(segment);
  let index = 0;
  // Skip the PowerShell call operator and leading VAR=value assignments.
  while (index < tokens.length && (tokens[index] === "&" || /^\w+=/.test(tokens[index]!))) index++;
  if (!tokens[index] || !isGitIdentifier(tokens[index]!)) return null;
  index++;
  while (index < tokens.length && tokens[index]!.startsWith("-")) {
    const option = tokens[index]!;
    index += GIT_OPTIONS_WITH_VALUE.has(option) ? 2 : 1;
  }
  const subcommand = tokens[index]?.toLowerCase();
  if (!subcommand) return null;
  return { subcommand, args: tokens.slice(index + 1) };
}

function authorGitProblem({ subcommand, args }: GitCommand): string | null {
  const has = (...flags: string[]) => args.some((arg) => flags.includes(arg));
  switch (subcommand) {
    case "push":
      return "Pushing is not allowed. The hub manages the task branch; leave your changes in the working tree.";
    case "switch":
    case "worktree":
    case "rebase":
      return `'git ${subcommand}' is not allowed: stay on the task branch in this worktree.`;
    case "checkout":
      if (args.includes("--") || (args.length === 1 && args[0] === ".")) return null;
      return "Switching branches is not allowed. To restore files use 'git checkout -- <path>' or 'git restore <path>'.";
    case "reset":
      return has("--hard", "--keep", "--merge") ? "'git reset --hard' is not allowed; it would discard tracked history in the task branch." : null;
    case "branch":
      return has("-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "-f", "--force")
        ? "Creating, renaming or deleting branches is not allowed."
        : null;
    case "remote":
      return ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches"].includes(args[0] ?? "")
        ? "Changing git remotes is not allowed."
        : null;
    case "config":
      return has("--global", "--system") ? "Changing global or system git configuration is not allowed." : null;
    default:
      return null;
  }
}

function reviewerGitProblem({ subcommand, args }: GitCommand): string | null {
  if (REVIEWER_GIT_ALLOWED.has(subcommand)) return null;
  if (subcommand === "branch" || subcommand === "tag") {
    const listing = args.every((arg) => arg.startsWith("-") && !["-d", "-D", "-m", "-M", "-f", "--delete", "--force"].includes(arg));
    if (listing) return null;
  }
  if (subcommand === "remote" && (args.length === 0 || ["-v", "show", "get-url"].includes(args[0] ?? ""))) return null;
  if (subcommand === "config" && args.some((arg) => arg.startsWith("--get") || arg === "-l" || arg === "--list")) return null;
  return `Read-only reviewer: 'git ${subcommand}' is not allowed. Use read-only git commands such as git diff, git log, git show, git status.`;
}

function isGitIdentifier(token: string): boolean {
  return executableName(token) === "git";
}

/** Splits a command line on ; | && || and newlines that are outside quotes. */
export function splitCommandText(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || (char === "&" && text[i + 1] === "&")) {
      if ((char === "|" || char === "&") && text[i + 1] === char) i++;
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}
