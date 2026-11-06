import { git, GitError } from "../git.ts";
import { listRemotes, primaryRemote, remoteLocation, sanitizeRemoteUrl, type RemoteDetails } from "../remote.ts";
import type { RemoteProvider, ReviewPullRequest, ReviewTarget } from "../types.ts";
import { errorMessage, randomId, truncate } from "../util.ts";

/** What the user asked to review, parsed before anything is fetched. */
export type ReviewTargetSpec =
  | { kind: "pr"; number: number; url?: { provider: RemoteProvider; host: string; slug: string } }
  | { kind: "ref"; ref: string };

/** Looks up pull requests on the remote's host (the GitHub CLI); both methods resolve null when they cannot. */
export interface PullRequestLookup {
  pullRequest(remote: RemoteDetails, number: number): Promise<ReviewPullRequest | null>;
  /** The open pull request whose head is `branch`. */
  forBranch(remote: RemoteDetails, branch: string): Promise<ReviewPullRequest | null>;
}

export interface ResolvedReviewTarget {
  target: ReviewTarget;
  /** merge-base(base tip, head): the review covers baseSha..headSha, as the pull request does. */
  baseSha: string;
  /** Suggested task title. */
  title: string;
}

export interface ResolveOptions {
  /** Base branch the user chose (pull requests use their own target branch when the host reports it). */
  baseRef?: string;
  defaultBranch: string;
  lookup?: PullRequestLookup;
  fetchTimeoutMs?: number;
}

const PR_NUMBER = /^(?:#|!|(?:pr|pull|pull request|mr|merge request)\s*[#!:]?\s*)?(\d{1,9})$/i;

/** Parses a pull request number ("12", "#12", "!12", "PR 12"), a pull request URL, or a git ref. */
export function parseReviewTarget(input: string): ReviewTargetSpec {
  const text = input.trim();
  if (!text) throw new Error("Enter the pull request (number or URL) or the branch to review");
  const number = PR_NUMBER.exec(text);
  if (number) return { kind: "pr", number: Number(number[1]) };
  if (/^https?:\/\//i.test(text)) return parsePullRequestUrl(text);
  if (/\s/.test(text) || text.startsWith("-")) throw new Error(`'${truncate(text, 80)}' is neither a pull request nor a branch, tag or commit`);
  return { kind: "ref", ref: text.replace(/^refs\/heads\//, "") };
}

function parsePullRequestUrl(text: string): ReviewTargetSpec {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`'${truncate(text, 120)}' is not a valid URL`);
  }
  const host = url.hostname.toLowerCase();
  const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  const numberAfter = (marker: string) => {
    const index = parts.findIndex((part) => part.toLowerCase() === marker);
    const value = index >= 0 ? Number(parts[index + 1]) : NaN;
    return { index, value: Number.isInteger(value) && value > 0 ? value : null };
  };
  // Azure DevOps: dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}, {org}.visualstudio.com/[collection/]{project}/_git/{repo}/pullrequest/{id}
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const pr = numberAfter("pullrequest");
    const gitIndex = parts.indexOf("_git");
    if (pr.value && gitIndex >= 1 && parts[gitIndex + 1]) {
      const org = host === "dev.azure.com" ? parts[0]! : host.slice(0, -".visualstudio.com".length);
      return { kind: "pr", number: pr.value, url: { provider: "azure-devops", host, slug: `${org}/${parts[gitIndex - 1]}/${parts[gitIndex + 1]}`.toLowerCase() } };
    }
  }
  // GitLab: {group}/{subgroup}/{repo}/-/merge_requests/{id}
  const mr = numberAfter("merge_requests");
  if (mr.value && mr.index >= 3 && parts[mr.index - 1] === "-") {
    return { kind: "pr", number: mr.value, url: { provider: "gitlab", host, slug: parts.slice(0, mr.index - 1).join("/").toLowerCase() } };
  }
  // Bitbucket: {owner}/{repo}/pull-requests/{id}
  const bitbucket = numberAfter("pull-requests");
  if (bitbucket.value && bitbucket.index === 2) {
    return { kind: "pr", number: bitbucket.value, url: { provider: "bitbucket", host, slug: parts.slice(0, 2).join("/").toLowerCase() } };
  }
  // GitHub (and GitHub-like hosts such as Gitea): {owner}/{repo}/pull(s)/{id}
  for (const marker of ["pull", "pulls"]) {
    const pr = numberAfter(marker);
    if (pr.value && pr.index === 2) {
      const github = host === "github.com" || host.endsWith(".ghe.com") || /(^|\.)github\./.test(host);
      return { kind: "pr", number: pr.value, url: { provider: github ? "github" : "other", host, slug: parts.slice(0, 2).join("/").toLowerCase() } };
    }
  }
  throw new Error(`'${truncate(text, 120)}' is not a pull request URL (expected …/pull/<number>, …/-/merge_requests/<number> or …/pullrequest/<number>)`);
}

/** The ref a host exposes for a pull request's head; Azure DevOps only exposes its merge with the target branch. */
export function pullRequestRef(provider: RemoteProvider, number: number): { ref: string; merge: boolean } {
  switch (provider) {
    case "gitlab":
      return { ref: `refs/merge-requests/${number}/head`, merge: false };
    case "azure-devops":
      return { ref: `refs/pull/${number}/merge`, merge: true };
    case "bitbucket":
      throw new Error("Bitbucket does not expose pull requests to git; review the pull request's source branch instead (enter its name)");
    default:
      return { ref: `refs/pull/${number}/head`, merge: false };
  }
}

/** Whether a remote points to the repository of a pull request URL (with `ignoreHost`: the same repository path on any host). */
export function remoteMatches(remote: RemoteDetails, url: { provider: RemoteProvider; host: string; slug: string }, ignoreHost = false): boolean {
  if (url.provider === "azure-devops") {
    if (remote.provider !== "azure-devops" || !remote.azure) return false;
    const { org, project, repo } = remote.azure;
    return `${org}/${project}/${repo}`.toLowerCase() === url.slug;
  }
  const location = remoteLocation(remote);
  return Boolean(location && location.path === url.slug && (ignoreHost || location.host === url.host));
}

/** The remote a pull request URL belongs to: same host and repository, else the only remote of that repository (an SSH host alias). */
async function remoteForUrl(repoPath: string, url: { provider: RemoteProvider; host: string; slug: string }): Promise<RemoteDetails> {
  const remotes = await listRemotes(repoPath);
  const exact = remotes.find((candidate) => remoteMatches(candidate, url));
  if (exact) return exact;
  const sameRepository = remotes.filter((candidate) => remoteMatches(candidate, url, true));
  if (sameRepository.length === 1) return sameRepository[0]!;
  const known = remotes.map((candidate) => `${candidate.name} → ${candidate.url}`).join(", ") || "none";
  throw new Error(`The pull request is on ${url.host}/${url.slug}, but no remote of this repository points there (remotes: ${known})`);
}

/**
 * Resolves what a code review task reviews: fetches a pull request's head (and its base branch) from the
 * remote, or resolves a branch, tag or commit, and computes the merge-base the change is reviewed against -
 * the same change the pull request shows. Throws errors written for the user.
 */
export async function resolveReviewTarget(repoPath: string, input: string, options: ResolveOptions): Promise<ResolvedReviewTarget> {
  const spec = parseReviewTarget(input);
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 3 * 60_000;
  // Fetched commits land on private refs (never FETCH_HEAD, which other tasks may write at the same time); the caller
  // creates the task branch on the head right after, and the private refs are removed.
  const prefix = `refs/agent-hub/fetch/${Date.now().toString(36)}-${randomId(6)}`;
  const temporary: string[] = [];
  const fetchInto: FetchInto = async (remote, source, name) => {
    const local = `${prefix}/${name}`;
    temporary.push(local);
    const result = await git(repoPath, ["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", remote.name, `+${source}:${local}`], {
      allowFailure: true,
      timeoutMs: fetchTimeoutMs,
    });
    if (result.code !== 0) {
      const detail = sanitizeRemoteUrl((result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" "));
      throw new Error(detail || `git fetch ${remote.name} ${source} failed`);
    }
    return commitOf(repoPath, local);
  };
  try {
    if (spec.kind === "pr") return await resolvePullRequest(repoPath, spec, options, fetchInto);
    return await resolveRef(repoPath, spec.ref, options, fetchInto);
  } finally {
    for (const ref of temporary) await git(repoPath, ["update-ref", "-d", ref], { allowFailure: true });
  }
}

type FetchInto = (remote: RemoteDetails, source: string, name: string) => Promise<string | null>;

async function resolvePullRequest(
  repoPath: string,
  spec: Extract<ReviewTargetSpec, { kind: "pr" }>,
  options: ResolveOptions,
  fetchInto: FetchInto,
): Promise<ResolvedReviewTarget> {
  let remote: RemoteDetails | null;
  if (spec.url) {
    remote = await remoteForUrl(repoPath, spec.url);
  } else {
    remote = await primaryRemote(repoPath);
    if (!remote) throw new Error("This repository has no git remote, so there is no pull request to fetch; enter a branch to review instead");
  }
  const provider = spec.url?.provider ?? remote.provider;
  const { ref, merge } = pullRequestRef(provider, spec.number);
  const sign = provider === "gitlab" ? "!" : "#";
  const name = `${provider === "gitlab" ? "merge request" : "pull request"} ${sign}${spec.number}`;

  const info = options.lookup ? await options.lookup.pullRequest(remote, spec.number).catch(() => null) : null;

  let headSha: string | null;
  try {
    headSha = await fetchInto(remote, ref, "head");
  } catch (error) {
    throw new Error(`Could not fetch ${name} from ${remote.name} (${ref}): ${errorMessage(error)}`);
  }
  if (!headSha) throw new Error(`Could not fetch ${name} from ${remote.name} (${ref})`);

  const baseRef = info?.baseBranch ?? options.baseRef ?? options.defaultBranch;
  let baseTipSha: string;
  if (merge) {
    // The merge commit's first parent is the target branch: the review covers exactly what the pull request merges.
    const parent = await commitOf(repoPath, `${headSha}^1`);
    if (!parent) throw new Error(`${name} has no target branch parent to compare with`);
    baseTipSha = parent;
  } else {
    const fetched = await fetchInto(remote, `refs/heads/${baseRef}`, "base").catch(() => null);
    const local = fetched ?? (await commitOf(repoPath, `refs/remotes/${remote.name}/${baseRef}`)) ?? (await commitOf(repoPath, baseRef));
    if (!local) throw new Error(`Cannot find the base branch '${baseRef}' of ${name} on ${remote.name} or locally`);
    baseTipSha = local;
  }
  const baseSha = await mergeBase(repoPath, baseTipSha, headSha, `${name} and '${baseRef}'`);
  if (baseSha === headSha) throw new Error(`${name} has no changes compared with '${baseRef}'`);
  const pullRequest: ReviewPullRequest = {
    ...(info ?? {}),
    provider: info?.provider ?? provider,
    number: spec.number,
    host: info?.host ?? remote.host,
    slug: info?.slug ?? remote.slug,
    url: info?.url ?? pullRequestWebUrl(remote, provider, spec.number),
    headSha: info?.headSha ?? headSha,
  };
  return {
    target: { kind: "pr", input: `${sign}${spec.number}`, headRef: ref, headSha, baseRef, baseTipSha, remote: remote.name, pullRequest },
    baseSha,
    title: `Review ${sign}${spec.number}${pullRequest.title ? `: ${pullRequest.title}` : ""}`,
  };
}

async function resolveRef(repoPath: string, ref: string, options: ResolveOptions, fetchInto: FetchInto): Promise<ResolvedReviewTarget> {
  const remote = await primaryRemote(repoPath);
  let headRef = ref;
  let headSha = await commitOf(repoPath, ref);
  if (!headSha && remote) {
    headRef = `${remote.name}/${ref}`;
    headSha = (await commitOf(repoPath, `refs/remotes/${headRef}`)) ?? (await fetchInto(remote, `refs/heads/${ref}`, "head").catch(() => null));
  }
  if (!headSha) {
    throw new Error(`Cannot find '${ref}' in the repository${remote ? ` or on ${remote.name}` : ""}: enter a branch, tag or commit, or a pull request number or URL`);
  }

  // A branch with an open pull request (GitHub) is reviewed like that pull request: against the pull request's target
  // branch, so the review covers the same change and its comments can be published there.
  let pullRequest: ReviewPullRequest | undefined;
  if (remote && options.lookup && !/^[0-9a-f]{7,40}$/i.test(ref)) {
    const branch = ref.startsWith(`${remote.name}/`) ? ref.slice(remote.name.length + 1) : ref;
    const found = await options.lookup.forBranch(remote, branch).catch(() => null);
    if (found && (!found.headSha || found.headSha === headSha)) pullRequest = found;
  }
  const chosenBase = options.baseRef ?? options.defaultBranch;
  let baseRef = pullRequest?.baseBranch ?? chosenBase;
  const fetchedBase = pullRequest?.baseBranch && remote ? await fetchInto(remote, `refs/heads/${baseRef}`, "base").catch(() => null) : null;
  let best = await closestMergeBase(repoPath, headSha, [...(fetchedBase ? [fetchedBase] : []), ...baseCandidates(baseRef, remote)]);
  if (!best && baseRef !== chosenBase) {
    // The pull request's target branch is nowhere to be found: review against the chosen branch, without the pull request.
    pullRequest = undefined;
    baseRef = chosenBase;
    best = await closestMergeBase(repoPath, headSha, baseCandidates(baseRef, remote));
  }
  if (!best) throw new Error(`Cannot find a common ancestor of '${ref}' and the base branch '${baseRef}'`);
  if (best.base === headSha) throw new Error(`'${ref}' has no changes compared with '${baseRef}'`);
  return {
    target: { kind: "ref", input: ref, headRef, headSha, baseRef, baseTipSha: best.tip, remote: pullRequest ? remote?.name : undefined, pullRequest },
    baseSha: best.base,
    title: `Review ${ref}${pullRequest ? ` (#${pullRequest.number}${pullRequest.title ? `: ${pullRequest.title}` : ""})` : ""}`,
  };
}

/** The base branch and its remote-tracking branch (the local branch may be behind the remote). */
function baseCandidates(baseRef: string, remote: RemoteDetails | null): string[] {
  return [baseRef, ...(remote ? [`refs/remotes/${remote.name}/${baseRef}`] : [])];
}

/** Of the candidate base tips, the one whose merge-base with the head is closest to the head. */
async function closestMergeBase(repoPath: string, headSha: string, candidates: string[]): Promise<{ tip: string; base: string } | null> {
  let best: { tip: string; base: string } | null = null;
  for (const candidate of candidates) {
    const tip = await commitOf(repoPath, candidate);
    if (!tip) continue;
    const result = await git(repoPath, ["merge-base", tip, headSha], { allowFailure: true });
    const base = result.stdout.trim();
    if (result.code !== 0 || !base) continue;
    if (!best || (await isAncestor(repoPath, best.base, base))) best = { tip, base };
  }
  return best;
}

function pullRequestWebUrl(remote: RemoteDetails, provider: RemoteProvider, number: number): string | undefined {
  if (!remote.webUrl) return undefined;
  switch (provider) {
    case "github":
    case "other":
      return `${remote.webUrl}/pull/${number}`;
    case "gitlab":
      return `${remote.webUrl}/-/merge_requests/${number}`;
    case "azure-devops":
      return `${remote.webUrl}/pullrequest/${number}`;
    default:
      return undefined;
  }
}

async function commitOf(repoPath: string, ref: string): Promise<string | null> {
  const result = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  const sha = result.stdout.trim();
  return result.code === 0 && sha ? sha : null;
}

async function mergeBase(repoPath: string, a: string, b: string, what: string): Promise<string> {
  try {
    const sha = (await git(repoPath, ["merge-base", a, b])).stdout.trim();
    if (sha) return sha;
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
  }
  throw new Error(`${what} have no common ancestor`);
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFailure: true })).code === 0;
}
