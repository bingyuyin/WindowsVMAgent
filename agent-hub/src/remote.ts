import { execFile } from "node:child_process";
import { git } from "./git.ts";
import type { RemoteProvider } from "./types.ts";
import { truncate } from "./util.ts";

export type { RemoteProvider };

/** A git remote, parsed enough to link to its web pages. URLs never carry credentials. */
export interface RemoteDetails {
  name: string;
  url: string;
  provider: RemoteProvider;
  host?: string;
  /** Web page of the repository (null for local paths and unknown hosts). */
  webUrl: string | null;
  /** owner/repo (GitHub, Bitbucket) or group/subgroup/repo (GitLab). */
  slug?: string;
  azure?: { org: string; project: string; repo: string; base: string };
}

export interface PullRequestDetails {
  url: string;
  number?: number;
  draft?: boolean;
}

export interface PullRequestRequest {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

/** Creates pull requests directly (instead of opening the host's create page). */
export interface PullRequestCreator {
  /** True when this creator can create pull requests on the remote's host right now. */
  canCreate(remote: RemoteDetails): Promise<boolean>;
  findOpen(remote: RemoteDetails, head: string): Promise<PullRequestDetails | null>;
  create(remote: RemoteDetails, request: PullRequestRequest): Promise<PullRequestDetails>;
}

const enc = encodeURIComponent;
/** Encodes a branch name for a URL path, keeping its "/" separators readable. */
const encPath = (branch: string) => branch.split("/").map(enc).join("/");

/** Removes user names, passwords and tokens embedded in a remote URL (and from text that contains one). */
export function sanitizeRemoteUrl(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");
}

export function parseRemote(name: string, rawUrl: string): RemoteDetails {
  const url = sanitizeRemoteUrl(rawUrl.trim());
  const base: RemoteDetails = { name, url, provider: "other", webUrl: null };
  // scp-like syntax: git@host:path
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp && !/^[a-z]+:\/\//i.test(url)) {
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return base;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return base;
    host = parsed.hostname.toLowerCase();
    path = decodeURIComponent(parsed.pathname);
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parts = path.split("/").filter(Boolean);

  // Azure DevOps: dev.azure.com/{org}/{project}/_git/{repo}, {org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo},
  // ssh.dev.azure.com:v3/{org}/{project}/{repo}
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    const [version, org, project, repo] = parts;
    if (version === "v3" && org && project && repo) return azure(base, host, org, project, repo, `https://dev.azure.com/${enc(org)}`);
    return base;
  }
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const gitIndex = parts.indexOf("_git");
    if (gitIndex < 1 || !parts[gitIndex + 1]) return base;
    const repo = parts[gitIndex + 1]!;
    const project = parts[gitIndex - 1]!;
    if (host === "dev.azure.com") {
      const org = parts[0]!;
      return azure(base, host, org, project, repo, `https://dev.azure.com/${enc(org)}`);
    }
    const org = host.slice(0, -".visualstudio.com".length);
    const collection = parts.slice(0, gitIndex - 1).map(enc).join("/");
    return azure(base, host, org, project, repo, `https://${host}${collection ? `/${collection}` : ""}`);
  }
  const web = (slug: string) => `https://${host}/${slug.split("/").map(enc).join("/")}`;
  if (host === "github.com" || host.endsWith(".ghe.com") || /(^|\.)github\./.test(host)) {
    if (parts.length < 2) return base;
    const slug = `${parts[0]}/${parts[1]}`;
    return { ...base, provider: "github", host, slug, webUrl: web(slug) };
  }
  if (host === "gitlab.com" || /(^|\.)gitlab\./.test(host)) {
    if (parts.length < 2) return base;
    const slug = parts.join("/");
    return { ...base, provider: "gitlab", host, slug, webUrl: web(slug) };
  }
  if (host === "bitbucket.org") {
    if (parts.length < 2) return base;
    const slug = `${parts[0]}/${parts[1]}`;
    return { ...base, provider: "bitbucket", host, slug, webUrl: web(slug) };
  }
  return base;
}

function azure(base: RemoteDetails, host: string, org: string, project: string, repo: string, orgUrl: string): RemoteDetails {
  const webUrl = `${orgUrl}/${enc(project)}/_git/${enc(repo)}`;
  return { ...base, provider: "azure-devops", host, webUrl, azure: { org, project, repo, base: webUrl } };
}

/**
 * Host and repository path of any remote URL, lower-cased and without ".git" - also for hosts the hub does not
 * recognize (GitHub Enterprise or GitLab on a custom domain, Gitea, SSH host aliases). Null for local paths.
 */
export function remoteLocation(remote: Pick<RemoteDetails, "url" | "host" | "slug">): { host: string; path: string } | null {
  if (remote.host && remote.slug) return { host: remote.host.toLowerCase(), path: remote.slug.toLowerCase() };
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remote.url);
  if (scp && !/^[a-z]+:\/\//i.test(remote.url)) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(remote.url);
    } catch {
      return null;
    }
    if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
    host = parsed.hostname;
    path = decodeURIComponent(parsed.pathname);
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return path ? { host: host.toLowerCase(), path: path.toLowerCase() } : null;
}

/** Web page of a branch on the remote's host. */
export function branchWebUrl(remote: RemoteDetails, branch: string): string | null {
  if (!remote.webUrl) return null;
  const path = encPath(branch);
  switch (remote.provider) {
    case "github":
      return `${remote.webUrl}/tree/${path}`;
    case "gitlab":
      return `${remote.webUrl}/-/tree/${path}`;
    case "bitbucket":
      return `${remote.webUrl}/src/${path}`;
    case "azure-devops":
      return `${remote.webUrl}?version=GB${enc(branch)}`;
    default:
      return null;
  }
}

/** The host's "create pull request" page with the branches (and, where supported, title/description) filled in. */
export function pullRequestPageUrl(remote: RemoteDetails, request: Pick<PullRequestRequest, "head" | "base" | "title" | "body">): string | null {
  if (!remote.webUrl) return null;
  // Keep URLs well below browser and server limits.
  const body = truncate(request.body, 4000);
  switch (remote.provider) {
    case "github":
      return `${remote.webUrl}/compare/${encPath(request.base)}...${encPath(request.head)}?expand=1&title=${enc(request.title)}&body=${enc(body)}`;
    case "gitlab":
      return (
        `${remote.webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(request.head)}` +
        `&merge_request%5Btarget_branch%5D=${enc(request.base)}&merge_request%5Btitle%5D=${enc(request.title)}&merge_request%5Bdescription%5D=${enc(body)}`
      );
    case "bitbucket":
      return `${remote.webUrl}/pull-requests/new?source=${enc(request.head)}&dest=${enc(request.base)}`;
    case "azure-devops":
      return `${remote.webUrl}/pullrequestcreate?sourceRef=${enc(request.head)}&targetRef=${enc(request.base)}`;
    default:
      return null;
  }
}

/** The remote tasks push to: "origin" when it exists, otherwise the first remote. */
export async function primaryRemote(repoPath: string): Promise<RemoteDetails | null> {
  const list = await git(repoPath, ["remote"], { allowFailure: true });
  const names = list.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const name = names.includes("origin") ? "origin" : names[0];
  if (!name) return null;
  const url = await git(repoPath, ["remote", "get-url", name], { allowFailure: true });
  return url.code === 0 && url.stdout.trim() ? parseRemote(name, url.stdout.trim()) : null;
}

/** Every remote of the repository, "origin" first. */
export async function listRemotes(repoPath: string): Promise<RemoteDetails[]> {
  const list = await git(repoPath, ["remote"], { allowFailure: true });
  const names = list.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  names.sort((a, b) => Number(b === "origin") - Number(a === "origin"));
  const remotes: RemoteDetails[] = [];
  for (const name of names) {
    const url = await git(repoPath, ["remote", "get-url", name], { allowFailure: true });
    if (url.code === 0 && url.stdout.trim()) remotes.push(parseRemote(name, url.stdout.trim()));
  }
  return remotes;
}

/** Pushes a local branch to the remote under the same name (fast-forward only; never forced). */
export async function pushBranch(repoPath: string, remote: string, branch: string, timeoutMs = 5 * 60_000): Promise<void> {
  try {
    await git(repoPath, ["push", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs });
  } catch (error) {
    throw new Error(sanitizeRemoteUrl((error as Error).message));
  }
}

/** Creates GitHub pull requests with the GitHub CLI (`gh`) when it is installed and signed in to the host. */
export class GhPullRequestCreator implements PullRequestCreator {
  private readonly ready = new Map<string, { value: boolean; at: number }>();

  async canCreate(remote: RemoteDetails): Promise<boolean> {
    if (remote.provider !== "github" || !remote.host) return false;
    const cached = this.ready.get(remote.host);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const status = await runGh(["auth", "status", "--hostname", remote.host], { allowFailure: true });
    const value = status.code === 0;
    this.ready.set(remote.host, { value, at: Date.now() });
    return value;
  }

  async findOpen(remote: RemoteDetails, head: string): Promise<PullRequestDetails | null> {
    const result = await runGh(["pr", "list", "--repo", repoArg(remote), "--head", head, "--state", "open", "--json", "url,number,isDraft", "--limit", "1"]);
    const [first] = JSON.parse(result.stdout || "[]") as Array<{ url: string; number: number; isDraft: boolean }>;
    return first ? { url: first.url, number: first.number, draft: first.isDraft } : null;
  }

  async create(remote: RemoteDetails, request: PullRequestRequest): Promise<PullRequestDetails> {
    const args = ["pr", "create", "--repo", repoArg(remote), "--head", request.head, "--base", request.base, "--title", request.title, "--body-file", "-"];
    if (request.draft) args.push("--draft");
    const result = await runGh(args, { input: request.body });
    const url = result.stdout.trim().split(/\s+/).find((token) => /^https?:\/\//.test(token));
    if (!url) throw new Error(`gh did not return a pull request URL: ${truncate(result.stdout || result.stderr, 300)}`);
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    return { url, number: Number.isInteger(number) ? number : undefined, draft: request.draft };
  }
}

export function ghRepoArg(remote: Pick<RemoteDetails, "host" | "slug">): string {
  return remote.host === "github.com" ? remote.slug! : `${remote.host}/${remote.slug}`;
}

function repoArg(remote: RemoteDetails): string {
  return ghRepoArg(remote);
}

/** Runs the GitHub CLI non-interactively; rejects with a readable error unless `allowFailure`. */
export function runGh(args: string[], options: { allowFailure?: boolean; input?: string } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_SPINNER_DISABLED: "1", NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        const code = error ? ((error as NodeJS.ErrnoException).code === "ENOENT" ? -1 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        if (!error || options.allowFailure) {
          resolve({ stdout, stderr, code });
          return;
        }
        const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "the GitHub CLI (gh) is not installed" : (stderr || error.message).trim();
        reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${sanitizeRemoteUrl(detail)}`));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}
