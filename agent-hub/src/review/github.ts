import { ghRepoArg, remoteLocation, runGh, sanitizeRemoteUrl, type RemoteDetails } from "../remote.ts";
import type { ReviewPullRequest } from "../types.ts";
import { truncate } from "../util.ts";
import { LineOutsideDiffError, type CreatedReview, type NewReview, type ReviewPublisher } from "./publish.ts";
import type { PullRequestLookup } from "./target.ts";

const PR_FIELDS = "number,title,body,url,author,baseRefName,headRefName,headRefOid,isDraft,state";

interface GhPullRequest {
  number: number;
  title?: string;
  body?: string;
  url?: string;
  author?: { login?: string };
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  isDraft?: boolean;
  state?: string;
}

type GitHubRepo = { host: string; slug: string };

/** Looks up GitHub pull requests and publishes reviews on them with the GitHub CLI (`gh`), when it is installed and signed in. */
export class GhReviewHost implements PullRequestLookup, ReviewPublisher {
  private readonly auth = new Map<string, { problem: string | null; at: number }>();

  async pullRequest(remote: RemoteDetails, number: number): Promise<ReviewPullRequest | null> {
    const repo = await this.githubRepo(remote);
    if (!repo) return null;
    const result = await runGh(["pr", "view", String(number), "--repo", ghRepoArg(repo), "--json", PR_FIELDS], { allowFailure: true });
    if (result.code !== 0) return null;
    return toPullRequest(JSON.parse(result.stdout) as GhPullRequest, repo);
  }

  async forBranch(remote: RemoteDetails, branch: string): Promise<ReviewPullRequest | null> {
    const repo = await this.githubRepo(remote);
    if (!repo) return null;
    const result = await runGh(["pr", "list", "--repo", ghRepoArg(repo), "--head", branch, "--state", "open", "--json", PR_FIELDS, "--limit", "1"], {
      allowFailure: true,
    });
    if (result.code !== 0) return null;
    const [first] = JSON.parse(result.stdout || "[]") as GhPullRequest[];
    return first ? toPullRequest(first, repo) : null;
  }

  /**
   * The GitHub repository a remote points to: github.com and GitHub Enterprise hosts the hub recognizes, or a host it
   * does not recognize that the GitHub CLI is signed in to (GitHub Enterprise Server on a custom domain).
   */
  private async githubRepo(remote: RemoteDetails): Promise<GitHubRepo | null> {
    if (remote.provider === "github" && remote.host && remote.slug) return { host: remote.host, slug: remote.slug };
    if (remote.provider !== "other") return null;
    const location = remoteLocation(remote);
    if (!location || location.path.split("/").length !== 2) return null;
    return (await this.authProblem(location.host)) === null ? { host: location.host, slug: location.path } : null;
  }

  async unavailable(pr: ReviewPullRequest): Promise<string | null> {
    if (pr.provider !== "github") {
      return "The hub publishes comments on GitHub pull requests only; copy the review as Markdown and paste it on the pull request instead.";
    }
    if (!pr.host || !pr.slug) return "The pull request's GitHub repository is unknown.";
    return this.authProblem(pr.host);
  }

  private async authProblem(host: string): Promise<string | null> {
    const cached = this.auth.get(host);
    if (cached && Date.now() - cached.at < 60_000) return cached.problem;
    const status = await runGh(["auth", "status", "--hostname", host], { allowFailure: true });
    const problem =
      status.code === -1
        ? "Install the GitHub CLI (gh) and sign it in (gh auth login) to publish comments."
        : status.code !== 0
          ? `Sign the GitHub CLI in to ${host} (gh auth login --hostname ${host}) to publish comments.`
          : null;
    this.auth.set(host, { problem, at: Date.now() });
    return problem;
  }

  async createReview(pr: ReviewPullRequest, review: NewReview): Promise<CreatedReview> {
    const path = `repos/${pr.slug}/pulls/${pr.number}/reviews`;
    const created = (await this.api(pr, "POST", path, {
      commit_id: review.commitId,
      body: review.body,
      event: review.event,
      comments: review.comments.map((comment) => ({ path: comment.path, line: comment.line, side: "RIGHT", body: comment.body })),
    })) as { id: number; html_url?: string };
    let comments: CreatedReview["comments"] = [];
    if (review.comments.length) {
      // The review is on the pull request now: failing to list its comments must not lose it, or publishing again would post it twice.
      try {
        const listed = await this.api(pr, "GET", `${path}/${created.id}/comments?per_page=100`);
        if (Array.isArray(listed)) {
          comments = (listed as Array<{ id: number; path: string; body: string; html_url?: string }>).map((comment) => ({
            id: comment.id,
            path: comment.path,
            body: comment.body,
            url: comment.html_url,
          }));
        }
      } catch {
        // The comments' IDs stay unknown: later edits and deletions of them are then made on GitHub directly.
      }
    }
    return { reviewId: created.id, url: created.html_url, comments };
  }

  async updateReview(pr: ReviewPullRequest, reviewId: number, body: string): Promise<void> {
    await this.api(pr, "PUT", `repos/${pr.slug}/pulls/${pr.number}/reviews/${reviewId}`, { body });
  }

  async updateComment(pr: ReviewPullRequest, commentId: number, body: string): Promise<void> {
    await this.api(pr, "PATCH", `repos/${pr.slug}/pulls/comments/${commentId}`, { body });
  }

  async deleteComment(pr: ReviewPullRequest, commentId: number): Promise<void> {
    await this.api(pr, "DELETE", `repos/${pr.slug}/pulls/comments/${commentId}`);
  }

  private async api(pr: ReviewPullRequest, method: string, path: string, body?: unknown): Promise<unknown> {
    const args = ["api", "--hostname", pr.host!, "--method", method, "-H", "Accept: application/vnd.github+json", path];
    if (body !== undefined) args.push("--input", "-");
    const result = await runGh(args, { allowFailure: true, input: body === undefined ? undefined : JSON.stringify(body) });
    if (result.code === -1) throw new Error("the GitHub CLI (gh) is not installed");
    if (result.code !== 0) {
      const message = apiError(result.stdout, result.stderr);
      if (/line must be part of the diff|line could not be resolved|path could not be resolved|position is invalid|not part of the diff/i.test(message)) {
        throw new LineOutsideDiffError(message);
      }
      throw new Error(message);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  }
}

function toPullRequest(pr: GhPullRequest, repo: GitHubRepo): ReviewPullRequest {
  return {
    provider: "github",
    number: pr.number,
    url: pr.url,
    title: pr.title,
    body: pr.body ? truncate(pr.body, 20_000) : undefined,
    author: pr.author?.login,
    headBranch: pr.headRefName,
    baseBranch: pr.baseRefName,
    headSha: pr.headRefOid,
    draft: pr.isDraft,
    state: pr.state,
    host: repo.host,
    slug: repo.slug,
  };
}

/** GitHub's error message and details from a failed `gh api` call. */
function apiError(stdout: string, stderr: string): string {
  try {
    const parsed = JSON.parse(stdout) as { message?: string; errors?: Array<string | { message?: string; code?: string; field?: string }> };
    const details = (parsed.errors ?? []).map((error) => (typeof error === "string" ? error : (error.message ?? [error.field, error.code].filter(Boolean).join(" ")))).filter(Boolean);
    if (parsed.message) return sanitizeRemoteUrl(truncate(`${parsed.message}${details.length ? `: ${details.join("; ")}` : ""}`, 1000));
  } catch {
    // Not JSON: fall back to stderr.
  }
  return sanitizeRemoteUrl(truncate((stderr || stdout).trim() || "the GitHub API request failed", 1000));
}
