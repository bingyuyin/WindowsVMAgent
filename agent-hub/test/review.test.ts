import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import type { PlanSubmissionInput } from "../src/agents/driver.ts";
import type { CopilotService } from "../src/copilot/service.ts";
import { createApiRouter } from "../src/http/api.ts";
import { createHttpServer } from "../src/http/server.ts";
import type { RepoService } from "../src/repos.ts";
import { LineOutsideDiffError } from "../src/review/publish.ts";
import { TodoService } from "../src/todos.ts";
import { summarizeTask } from "../src/workflow/summary.ts";
import {
  addRemote,
  bareGit,
  branchHead,
  createHarness,
  designPathFrom,
  FakeReviewHost,
  featureBranch,
  git,
  githubPullRequest,
  hang,
  steps,
  submitFinal,
  submitFindings,
  submitPositions,
  submitReview,
  submitSignoff,
  submitWork,
  waitFor,
  writeFile,
  type Harness,
  type Step,
} from "./helpers.ts";

const GREET = "export function greet(name) {\n  return 'Hello ' + name;\n}\n";

/** The usual discussion: both find the concatenation, the peer adds a nit the lead drops, the lead also flags the README; they agree. */
function agreeingReview(): Record<"lead-reviewer" | "peer-reviewer", Step[]> {
  return {
    "lead-reviewer": [
      submitFindings([
        { severity: "major", file: "greet.js", line: 2, body: "Concatenation turns undefined into 'Hello undefined'." },
        { severity: "minor", file: "README.md", line: 1, body: "Document greet() in the README." },
      ]),
      submitPositions({ responses: [{ comment_id: "P1", position: "agree", note: "Same issue" }, { comment_id: "P2", position: "disagree", note: "Style only" }] }),
      submitFinal(
        [
          { sources: ["L1", "P1"], severity: "major", file: "greet.js", line: 2, body: "Handle a missing name: `'Hello ' + name` prints 'Hello undefined'." },
          { sources: ["L2"], severity: "minor", file: "README.md", line: 1, body: "Document greet() in the README." },
        ],
        [{ comment_id: "P2", reason: "Style preference, not a problem" }],
      ),
    ],
    "peer-reviewer": [
      submitFindings([
        { severity: "major", file: "greet.js", line: 2, body: "greet(undefined) returns 'Hello undefined'." },
        { severity: "nit", file: "greet.js", line: 1, body: "Use an arrow function." },
      ]),
      submitPositions({ responses: [{ comment_id: "L1", position: "agree", note: "Yes" }, { comment_id: "L2", position: "refine", note: "Minor", suggested_severity: "nit" }] }),
      submitSignoff(true),
    ],
  };
}

describe("code review tasks", () => {
  test("two reviewers on different models review a branch independently, discuss, and agree on a final review", async () => {
    const h = createHarness(agreeingReview(), { settings: { reviewerModel: "fake-lead", peerReviewerModel: "fake-peer" } });
    try {
      const head = featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      assert.equal(created.title, "Review feature/greet");
      assert.match(created.description, /correctness, security/);
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      const review = task.review!;

      // The change under review: merge-base(main, head)..head, on a local branch that keeps the head.
      assert.equal(review.target.kind, "ref");
      assert.equal(review.target.headSha, head);
      assert.equal(task.baseSha, git(h.repoPath, "rev-parse", "main"));
      assert.equal(branchHead(h.repoPath, task.branch!), head);
      assert.deepEqual(review.files, [{ path: "greet.js", additions: 3, deletions: 0 }]);
      assert.equal(review.commits, 1);
      assert.equal(task.stages.length, 0);

      // Independent reviews, discussion, final review, sign-off.
      assert.deepEqual(review.rounds.map((round) => [round.phase, round.entries.map((entry) => entry.role).sort()]), [
        ["findings", ["lead-reviewer", "peer-reviewer"]],
        ["positions", ["lead-reviewer", "peer-reviewer"]],
        ["final", ["lead-reviewer"]],
        ["signoff", ["peer-reviewer"]],
      ]);
      assert.deepEqual(review.comments.map((comment) => comment.id).sort(), ["L1", "L2", "P1", "P2"]);
      assert.equal(review.signoff?.agreed, true);
      assert.equal(task.result?.approved, true);
      assert.deepEqual(review.curated?.map((comment) => [comment.id, comment.decision, comment.sources.join("+")]), [
        ["R1", "keep", "L1+P1"],
        ["R2", "keep", "L2"],
      ]);
      assert.equal(review.body, "Small, focused change; one correctness issue.");
      assert.equal(review.event, "COMMENT");

      // Each reviewer: its own model, a read-only worktree of its own at the head, and one tool per step.
      const [lead] = h.driver.specsFor("lead-reviewer");
      const [peer] = h.driver.specsFor("peer-reviewer");
      assert.equal(lead!.model, "fake-lead");
      assert.equal(peer!.model, "fake-peer");
      assert.equal(lead!.readOnly, true);
      assert.equal(peer!.readOnly, true);
      assert.notEqual(lead!.workingDirectory, peer!.workingDirectory);
      assert.equal(path.basename(peer!.workingDirectory), "review-peer");
      assert.deepEqual(lead!.submit.kind === "code-review" && lead!.submit.tools, ["submit_findings", "submit_positions", "submit_final_review"]);
      assert.deepEqual(peer!.submit.kind === "code-review" && peer!.submit.tools, ["submit_findings", "submit_positions", "submit_signoff"]);
      assert.match(lead!.systemPrompt, /LEAD CODE REVIEWER/);
      assert.match(peer!.systemPrompt, /PEER CODE REVIEWER/);

      // What each turn showed.
      const leadPrompts = h.driver.prompts["lead-reviewer"]!;
      const peerPrompts = h.driver.prompts["peer-reviewer"]!;
      assert.match(leadPrompts[0]!, /## The change/);
      assert.match(leadPrompts[0]!, /\+export function greet\(name\)/);
      assert.match(leadPrompts[0]!, /feature\/greet compared with main/);
      assert.match(leadPrompts[0]!, /peer reviewer \(on fake-peer\)/);
      assert.match(leadPrompts[1]!, /\[P1\] \(major\) greet\.js:2/);
      assert.match(leadPrompts[1]!, /Your comments:\n- \[L1\]/);
      assert.doesNotMatch(leadPrompts[1]!, /## The change/);
      assert.match(leadPrompts[2]!, /Account for each of these comment IDs, in a comment's sources or in dropped: L1, L2, P1, P2/);
      assert.match(leadPrompts[2]!, /↳ peer reviewer: refine - Minor \(suggested severity nit\)/);
      assert.match(peerPrompts[2]!, /\[R1\] \(major\) greet\.js:2 \(from L1, P1\)/);
      assert.match(peerPrompts[2]!, /\[P2\] \(nit\) greet\.js:1 "Use an arrow function\." - Style preference/);

      // Both reviewers worked at once in rounds 1 and 2; the checkouts are gone, the user's checkout untouched.
      assert.equal(fs.existsSync(task.workspaceRoot!), false);
      assert.equal(git(h.repoPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => /Code review complete: 2 comment\(s\) \(1 major, 1 minor\); both reviewers agree/.test(event.text)));
      assert.equal(task.push, undefined);
      await assert.rejects(Promise.resolve().then(() => h.runner.retry(task.id)), /This code review is finished/);
      assert.throws(() => h.runner.requestChanges(task.id, { request: "More" }), /do not change code/);
    } finally {
      h.cleanup();
    }
  });

  test("the user keeps, drops, edits and restores comments; publishing posts them, and later publishes update the pull request", async () => {
    const host = new FakeReviewHost();
    host.lookup.forBranch = githubPullRequest(5, { title: "Add greet" });
    const h = createHarness(agreeingReview(), { reviewHost: host });
    try {
      addRemote(h);
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "Focus on edge cases", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      assert.equal(created.title, "Review feature/greet (#5: Add greet)");
      await h.runner.idle();
      const id = created.id;
      const review = () => h.store.getTask(id)!.review!;
      assert.equal(review().target.pullRequest?.number, 5);

      // R1 is on a changed line (inline); R2 is on a line the change does not touch (the review's text).
      let status = await h.runner.reviewPublishStatus(id);
      assert.deepEqual([status.available, status.inline, status.inBody, status.pending], [true, 1, 1, null]);

      h.runner.updateReviewComment(id, "R1", { body: "Handle a missing name: default it to 'there'." });
      assert.equal(review().curated![0]!.original?.body, "Handle a missing name: `'Hello ' + name` prints 'Hello undefined'.");
      h.runner.updateReviewSummary(id, { body: "Nice and small. One thing to fix.", event: "REQUEST_CHANGES" });
      assert.throws(() => h.runner.updateReviewComment(id, "R1", { body: "  " }), /needs text/);
      assert.throws(() => h.runner.updateReviewComment(id, "R9", { decision: "drop" }), /no comment R9/);

      let outcome = await h.runner.publishReviewComments(id);
      assert.equal(outcome.ok, true, outcome.message);
      assert.match(outcome.message, /Published the review on pull request #5: 1 inline comment, 1 in the review's text/);
      const [created1] = host.callsOf("createReview") as Array<{ commitId: string; event: string; body: string; comments: Array<{ path: string; line: number; body: string }> }>;
      assert.equal(created1!.commitId, review().target.headSha);
      assert.equal(created1!.event, "REQUEST_CHANGES");
      assert.deepEqual(created1!.comments, [{ path: "greet.js", line: 2, body: "**Major:** Handle a missing name: default it to 'there'." }]);
      assert.match(created1!.body, /^Nice and small\. One thing to fix\.\n\n#### Comments outside the changed lines\n\n\*\*Minor\*\* · `README\.md:1`\n\nDocument greet\(\) in the README\.$/);
      assert.equal(review().curated![0]!.published?.remoteId, 1000);
      assert.equal(review().curated![1]!.published?.inline, false);
      status = await h.runner.reviewPublishStatus(id);
      assert.equal(status.pending, 0);
      assert.throws(() => h.runner.updateReviewSummary(id, { event: "APPROVE" }), /already published/);

      // Later: drop R1, edit R2 and restore the nit the lead dropped (P2, on a changed line).
      h.runner.updateReviewComment(id, "R1", { decision: "drop" });
      h.runner.updateReviewComment(id, "R2", { body: "Add a usage example for greet() to the README.", severity: "nit" });
      h.runner.addReviewComment(id, "P2");
      assert.throws(() => h.runner.addReviewComment(id, "P2"), /already part of a kept comment/);
      assert.deepEqual(review().curated!.map((comment) => [comment.id, comment.decision, comment.addedByUser ?? false]), [
        ["R1", "drop", false],
        ["R2", "keep", false],
        ["R3", "keep", true],
      ]);
      status = await h.runner.reviewPublishStatus(id);
      assert.equal(status.pending, 3);

      outcome = await h.runner.publishReviewComments(id);
      assert.equal(outcome.ok, true, outcome.message);
      assert.match(outcome.message, /Updated the review on pull request #5: 1 added, 1 deleted, review text updated/);
      assert.deepEqual(host.callsOf("deleteComment"), [{ commentId: 1000 }]);
      const followUp = host.callsOf("createReview")[1] as { event: string; comments: Array<{ path: string; line: number; body: string }> };
      assert.equal(followUp.event, "COMMENT");
      assert.deepEqual(followUp.comments, [{ path: "greet.js", line: 1, body: "**Nit:** Use an arrow function." }]);
      const [textUpdate] = host.callsOf("updateReview") as Array<{ reviewId: number; body: string }>;
      assert.equal(textUpdate!.reviewId, 100);
      assert.match(textUpdate!.body, /\*\*Nit\*\* · `README\.md:1`\n\nAdd a usage example/);
      assert.equal(review().curated![0]!.published, undefined);

      // Editing a published inline comment edits it on the pull request; nothing else is sent again.
      h.runner.updateReviewComment(id, "R3", { body: "Prefer an arrow function, as elsewhere in this file." });
      outcome = await h.runner.publishReviewComments(id);
      assert.match(outcome.message, /1 edited/);
      assert.deepEqual(host.callsOf("updateComment"), [{ commentId: 1001, body: "**Nit:** Prefer an arrow function, as elsewhere in this file." }]);
      outcome = await h.runner.publishReviewComments(id);
      assert.match(outcome.message, /Nothing new to publish/);
      assert.equal(host.callsOf("createReview").length, 2);

      const { markdown } = h.runner.reviewAsMarkdown(id);
      assert.match(markdown, /^## Review feature\/greet \(#5: Add greet\)/);
      assert.match(markdown, /### Comments \(2\)/);
      assert.doesNotMatch(markdown, /default it to 'there'/);
      const events = await h.store.readEvents(id);
      assert.ok(events.some((event) => /Updated the review on pull request #5/.test(event.text)));
    } finally {
      h.cleanup();
    }
  });

  test("when the host rejects a diff line, every comment goes into the review's text; without a pull request the review can only be copied", async () => {
    const host = new FakeReviewHost();
    host.lookup.forBranch = githubPullRequest(9);
    host.failNextCreate = new LineOutsideDiffError("Line could not be resolved");
    const h = createHarness(agreeingReview(), { reviewHost: host });
    try {
      addRemote(h);
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      await h.runner.idle();
      const outcome = await h.runner.publishReviewComments(created.id);
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /0 inline comments, 2 in the review's text.*rejected inline comments/);
      const [first, retry] = host.callsOf("createReview") as Array<{ comments: unknown[]; body: string }>;
      assert.equal(first!.comments.length, 1);
      assert.deepEqual(retry!.comments, []);
      assert.match(retry!.body, /greet\.js:2/);
      assert.equal(h.store.getTask(created.id)!.review!.lastPublish?.ok, false);

      host.problem = "Sign the GitHub CLI in to github.com (gh auth login --hostname github.com) to publish comments.";
      const status = await h.runner.reviewPublishStatus(created.id);
      assert.equal(status.available, false);
      await assert.rejects(h.runner.publishReviewComments(created.id), /Sign the GitHub CLI in/);
    } finally {
      h.cleanup();
    }

    const noPr = createHarness(agreeingReview(), { reviewHost: new FakeReviewHost() });
    try {
      featureBranch(noPr, "feature/greet", { "greet.js": GREET });
      const created = await noPr.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      await noPr.runner.idle();
      const status = await noPr.runner.reviewPublishStatus(created.id);
      assert.equal(status.available, false);
      assert.match(status.reason ?? "", /no open GitHub pull request/);
      await assert.rejects(noPr.runner.publishReviewComments(created.id), /no pull request to publish to/);
      assert.match(noPr.runner.reviewAsMarkdown(created.id).markdown, /### Comments \(2\)/);
    } finally {
      noPr.cleanup();
    }
  });

  test("a review GitHub created is never posted twice, even when its comments' IDs are unknown", async () => {
    const host = new FakeReviewHost();
    host.lookup.forBranch = githubPullRequest(5);
    host.forgetCommentIds = true;
    const h = createHarness(agreeingReview(), { reviewHost: host });
    try {
      addRemote(h);
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      await h.runner.idle();
      assert.equal((await h.runner.publishReviewComments(created.id)).ok, true);
      const again = await h.runner.publishReviewComments(created.id);
      assert.match(again.message, /Nothing new to publish/);
      assert.equal(host.callsOf("createReview").length, 1);
      // Without the comment's ID an edit cannot reach the pull request: the user is told to make it there.
      h.runner.updateReviewComment(created.id, "R1", { body: "Changed" });
      const edited = await h.runner.publishReviewComments(created.id);
      assert.equal(edited.ok, false);
      assert.match(edited.message, /R1: the hub does not know its comment on the pull request, so edit it there/);
      assert.equal(host.callsOf("createReview").length, 1);
      assert.equal(host.callsOf("updateComment").length, 0);
    } finally {
      h.cleanup();
    }
  });

  test("a branch with an open pull request is reviewed against the pull request's target branch", async () => {
    const host = new FakeReviewHost();
    const h = createHarness({}, { reviewHost: host, ready: false });
    try {
      // develop has a commit main does not; the feature branch was cut from develop and its pull request targets develop.
      git(h.repoPath, "checkout", "-q", "-b", "develop");
      fs.writeFileSync(path.join(h.repoPath, "develop.txt"), "on develop\n");
      git(h.repoPath, "add", "-A");
      git(h.repoPath, "commit", "-q", "-m", "develop work");
      const developTip = git(h.repoPath, "rev-parse", "HEAD");
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const bare = path.join(h.root, "origin.git");
      git(h.root, "init", "-q", "--bare", bare);
      git(h.repoPath, "remote", "add", "origin", bare);
      git(h.repoPath, "push", "-q", "origin", "main", "develop");

      host.lookup.forBranch = githubPullRequest(6, { baseBranch: "develop", headBranch: "feature/greet", title: "Add greet" });
      const viaPr = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet", baseRef: "main" });
      assert.equal(viaPr.review!.target.baseRef, "develop");
      assert.equal(viaPr.baseSha, developTip);
      assert.equal(viaPr.review!.target.pullRequest?.number, 6);
      assert.equal(viaPr.title, "Review feature/greet (#6: Add greet)");
      assert.deepEqual(git(h.repoPath, "diff", "--name-only", `${viaPr.baseSha}..${viaPr.review!.target.headSha}`), "greet.js");

      // A target branch that exists nowhere: the review falls back to the chosen branch, without the pull request.
      host.lookup.forBranch = githubPullRequest(7, { baseBranch: "release/9" });
      const fallback = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet", baseRef: "main" });
      assert.equal(fallback.review!.target.baseRef, "main");
      assert.equal(fallback.review!.target.pullRequest, undefined);
      assert.equal(fallback.baseSha, git(h.repoPath, "rev-parse", "main"));
      assert.equal(git(h.repoPath, "for-each-ref", "refs/agent-hub"), "");
    } finally {
      h.cleanup();
    }
  });

  test("the lead revises the final review when the peer reviewer objects, until it signs off", async () => {
    const h = createHarness({
      "lead-reviewer": [
        submitFindings([{ severity: "major", file: "greet.js", line: 2, body: "Missing name handling." }]),
        submitPositions({ responses: [{ comment_id: "P1", position: "disagree", note: "Not an issue" }] }),
        submitFinal([{ sources: ["L1"], severity: "major", file: "greet.js", line: 2, body: "Handle a missing name." }], [{ comment_id: "P1", reason: "Not an issue" }]),
        submitFinal(
          [
            { sources: ["L1"], severity: "major", file: "greet.js", line: 2, body: "Handle a missing name." },
            { sources: ["P1"], severity: "minor", file: "greet.js", line: 1, body: "Export a default as well." },
          ],
          [],
          { objection_responses: [{ objection: "P1 was dropped", response: "Restored it as R2" }] },
        ),
      ],
      "peer-reviewer": [
        submitFindings([{ severity: "minor", file: "greet.js", line: 1, body: "Export a default as well." }]),
        submitPositions({ responses: [{ comment_id: "L1", position: "agree", note: "Right" }] }),
        submitSignoff(false, [{ comment_id: "P1", issue: "P1 is a real compatibility problem; keep it." }]),
        submitSignoff(true),
      ],
    });
    try {
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      const review = task.review!;
      assert.deepEqual(review.rounds.map((round) => round.phase), ["findings", "positions", "final", "signoff", "final", "signoff"]);
      assert.equal(review.signoff?.agreed, true);
      assert.deepEqual(review.final?.objectionResponses, [{ objection: "P1 was dropped", response: "Restored it as R2" }]);
      assert.deepEqual(review.curated?.map((comment) => [comment.id, comment.objection ?? null]), [
        ["R1", null],
        ["R2", null],
      ]);
      const revisePrompt = h.driver.prompts["lead-reviewer"]![3]!;
      assert.match(revisePrompt, /revise the final review/);
      assert.match(revisePrompt, /1\. \[P1\] P1 is a real compatibility problem/);
      assert.match(h.driver.prompts["peer-reviewer"]![3]!, /The lead reviewer's answers to your objections:\n- P1 was dropped: Restored it as R2/);
    } finally {
      h.cleanup();
    }
  });

  test("stops after the final-review budget and shows the peer's remaining objections with the comments", async () => {
    const h = createHarness({
      "lead-reviewer": [
        submitFindings([{ severity: "major", file: "greet.js", line: 2, body: "Missing name handling." }]),
        submitPositions({ responses: [] }),
        submitFinal([{ sources: ["L1"], severity: "minor", file: "greet.js", line: 2, body: "Handle a missing name." }]),
      ],
      "peer-reviewer": [
        submitFindings([]),
        submitPositions({ responses: [{ comment_id: "L1", position: "agree", note: "Right" }] }),
        submitSignoff(false, [{ comment_id: "R1", issue: "This is major, not minor." }]),
      ],
    });
    try {
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet", maxRounds: 1 });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.result?.approved, false);
      assert.equal(task.review!.curated![0]!.objection, "This is major, not minor.");
      assert.equal(h.driver.prompts["lead-reviewer"]!.length, 3);
      const events = await h.store.readEvents(task.id);
      assert.ok(events.some((event) => event.type === "warning" && /still objects after 1 final review round/.test(event.text)));
      assert.ok(events.some((event) => /the peer reviewer still objects to 1 item/.test(event.text)));
    } finally {
      h.cleanup();
    }
  });

  test("a cancelled review resumes on retry without repeating the steps that finished", async () => {
    const script = agreeingReview();
    // The peer reviewer hangs in the discussion; after the retry it responds.
    script["peer-reviewer"].splice(1, 0, hang);
    const h = createHarness(script);
    try {
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "feature/greet" });
      // Cancel once the lead has responded and the peer is inside its (hanging) discussion turn.
      await waitFor(
        () =>
          (h.driver.prompts["peer-reviewer"]?.length ?? 0) >= 2 &&
          Boolean(h.store.getTask(created.id)!.review!.rounds[1]?.entries.some((entry) => entry.role === "lead-reviewer")),
      );
      h.runner.cancel(created.id);
      await h.runner.idle();
      assert.equal(h.store.getTask(created.id)!.status, "cancelled");

      h.runner.retry(created.id);
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.deepEqual(task.review!.rounds.map((round) => [round.phase, round.entries.length]), [
        ["findings", 2],
        ["positions", 2],
        ["final", 1],
        ["signoff", 1],
      ]);
      // The lead's discussion turn was not repeated; its fresh session got the full context again.
      const leadPrompts = h.driver.prompts["lead-reviewer"]!;
      assert.equal(leadPrompts.length, 3);
      assert.match(leadPrompts[2]!, /## The change/);
      assert.match(leadPrompts[2]!, /write the final review/);
      assert.match(h.driver.prompts["peer-reviewer"]![2]!, /## The change/);
    } finally {
      h.cleanup();
    }
  });

  test("a pull request is fetched from the remote with its details and reviewed against its target branch", async () => {
    const host = new FakeReviewHost();
    host.lookup.pullRequest = githubPullRequest(7, { title: "Add greet", author: "octocat", baseBranch: "main", headBranch: "feature/greet", body: "Adds greet()." });
    const h = createHarness(agreeingReview(), { reviewHost: host });
    try {
      const head = featureBranch(h, "feature/greet", { "greet.js": GREET });
      const bare = path.join(h.root, "origin.git");
      git(h.root, "init", "-q", "--bare", bare);
      git(h.repoPath, "remote", "add", "origin", bare);
      git(h.repoPath, "push", "-q", "origin", "main", `feature/greet:refs/pull/7/head`);
      git(h.repoPath, "branch", "-D", "feature/greet");
      assert.equal(bareGit(bare, "rev-parse", "refs/pull/7/head"), head);

      await assert.rejects(h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "#8" }), /Could not fetch pull request #8 from origin/);
      await assert.rejects(
        h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "https://github.com/other/repo/pull/7" }),
        /no remote of this repository points there/,
      );
      await assert.rejects(h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "no-such-branch" }), /Cannot find 'no-such-branch'/);
      await assert.rejects(h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "main" }), /'main' has no changes compared with 'main'/);

      const created = await h.runner.submit({ description: "", kind: "review", repoId: "sample", reviewTarget: "PR 7" });
      assert.equal(created.title, "Review #7: Add greet");
      const target = created.review!.target;
      assert.equal(target.kind, "pr");
      assert.equal(target.headRef, "refs/pull/7/head");
      assert.equal(target.headSha, head);
      assert.equal(target.remote, "origin");
      assert.equal(target.pullRequest?.slug, "acme/sample");
      assert.equal(branchHead(h.repoPath, created.branch!), head);
      // Fetched commits only live on the task branch; the hub's temporary refs are gone.
      assert.equal(git(h.repoPath, "for-each-ref", "refs/agent-hub"), "");
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      const first = h.driver.prompts["lead-reviewer"]![0]!;
      assert.match(first, /Pull request #7 "Add greet" by octocat \(https:\/\/github\.com\/acme\/sample\/pull\/7\)/);
      assert.match(first, /Branches: feature\/greet → main/);
      assert.match(first, /> Adds greet\(\)\./);
    } finally {
      h.cleanup();
    }
  });
});

/** A bare "origin" holding main and a feature branch published as pull request #N (refs/pull/N/head); returns the head. */
function pullRequestOnOrigin(h: Harness, number = 7): string {
  const head = featureBranch(h, "feature/greet", { "greet.js": GREET });
  const bare = path.join(h.root, "origin.git");
  git(h.root, "init", "-q", "--bare", bare);
  git(h.repoPath, "remote", "add", "origin", bare);
  git(h.repoPath, "push", "-q", "origin", "main", `feature/greet:refs/pull/${number}/head`);
  git(h.repoPath, "branch", "-D", "feature/greet");
  return head;
}

describe("auto tasks: the manager assigns code reviews to the reviewers", () => {
  test("a request that names a pull request to review goes straight to the lead and peer reviewers, without planning", async () => {
    const host = new FakeReviewHost();
    host.lookup.pullRequest = githubPullRequest(7, { title: "Add greet", baseBranch: "main", headBranch: "feature/greet" });
    const reviewers = agreeingReview();
    const leadFindings = reviewers["lead-reviewer"][0]!;
    reviewers["lead-reviewer"][0] = steps((_spec, prompt) => {
      assert.match(prompt, /## The request\n\nPlease review PR #7 and check the error handling/);
      assert.doesNotMatch(prompt, /## Manager's (briefing|assignment)/);
      assert.match(prompt, /Pull request #7 "Add greet"/);
      assert.match(prompt, /\+export function greet\(name\)/);
    }, leadFindings);
    const h = createHarness({ planner: [], ...reviewers }, { reviewHost: host });
    try {
      const head = pullRequestOnOrigin(h);
      const created = await h.runner.submit({ description: "Please review PR #7 and check the error handling", kind: "auto", repoId: "sample" });
      assert.equal(created.peerReviewerModel, "fake-author", "Auto tasks carry a peer reviewer model in case the manager plans a code review");
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.kind, "auto");
      assert.equal(h.driver.specsFor("planner").length, 0, "no planning: the request named the change to review");
      assert.deepEqual(task.plan?.stages, []);
      assert.deepEqual(task.plan?.review, { target: "#7" });
      assert.equal(task.plan?.direct, true);
      assert.match(task.plan?.rationale ?? "", /^The request asks to review pull request #7, so the manager assigned the code review team directly/);
      assert.deepEqual(task.stages, []);

      // Only the two reviewers worked: no planner, test executor, test fixer or coder.
      assert.deepEqual((task.agents ?? []).map((agent) => agent.role).sort(), ["lead-reviewer", "peer-reviewer"]);
      for (const role of ["executor", "fixer", "coder", "code-reviewer"] as const) assert.equal(h.driver.specsFor(role).length, 0, role);

      // The task became the review of the pull request: its branch points at the head, its base is the merge-base.
      const target = task.review!.target;
      assert.deepEqual([target.kind, target.headSha, target.baseRef, target.pullRequest?.number], ["pr", head, "main", 7]);
      assert.equal(task.baseSha, git(h.repoPath, "rev-parse", "main"));
      assert.equal(branchHead(h.repoPath, task.branch!), head);
      assert.deepEqual(task.review!.rounds.map((round) => [round.phase, round.entries.map((entry) => entry.role).sort()]), [
        ["findings", ["lead-reviewer", "peer-reviewer"]],
        ["positions", ["lead-reviewer", "peer-reviewer"]],
        ["final", ["lead-reviewer"]],
        ["signoff", ["peer-reviewer"]],
      ]);
      assert.deepEqual(task.review!.curated?.map((comment) => comment.id), ["R1", "R2"]);
      assert.equal(task.push, undefined, "a code review is never pushed");
      const comm = h.store.recentComm({ taskId: task.id });
      assert.ok(comm.some((entry) => entry.text === "The request asks to review #7: fetching it and assigning the code review team (no planning needed)"));
      assert.ok(comm.some((entry) => entry.kind === "plan" && entry.from === "manager" && /^Plan: Code review of pull request #7 - /.test(entry.text)));
      assert.ok(comm.some((entry) => entry.text === "Creating sub-agents: Lead reviewer, Peer reviewer"));
      assert.throws(() => h.runner.retry(task.id), /This code review is finished/);
      await assert.rejects(h.runner.pushNow(task.id), /no branch of their own to push/);
      assert.deepEqual(summarizeTask(task).plan?.review, { target: "#7" });
      assert.equal(summarizeTask(task).plan?.direct, true);
      assert.equal((await h.runner.reviewPublishStatus(task.id)).pullRequest?.number, 7);
    } finally {
      h.cleanup();
    }
  });

  test("when a review request also asks for more, the planner must choose the reviewers or confirm otherwise", async () => {
    const host = new FakeReviewHost();
    host.lookup.pullRequest = githubPullRequest(7, { title: "Add greet", baseBranch: "main", headBranch: "feature/greet" });
    const reviewPlan = (target: string, stages = ["review"]) =>
      ({
        stages,
        review_target: target,
        rationale: "The request is to review pull request #7",
        instructions: { review: "Focus on error handling" },
        briefing: "greet.js holds the greeting helpers.",
      }) as unknown as PlanSubmissionInput;
    const codingPlan = { stages: ["coding"], rationale: "Fix risky code", instructions: { coding: "Fix it" }, briefing: "greet.js" } as unknown as PlanSubmissionInput;
    const reviewers = agreeingReview();
    const leadFindings = reviewers["lead-reviewer"][0]!;
    reviewers["lead-reviewer"][0] = steps((_spec, prompt) => {
      assert.match(prompt, /## Manager's briefing on the repository\n\ngreet\.js holds the greeting helpers\./);
      assert.match(prompt, /## Manager's assignment for the review\n\nFocus on error handling/);
    }, leadFindings);
    const h = createHarness(
      {
        planner: [
          async (spec) => {
            if (spec.submit.kind !== "plan") throw new Error("the planner submits plans");
            const submit = spec.submit.onSubmit;
            assert.match(spec.systemPrompt, /- review: a lead reviewer and a peer reviewer/);
            assert.match(spec.systemPrompt, /Never answer it with `testing`/);
            // The request reads as a review: a plan without the reviewers goes back once, with the reason.
            await assert.rejects(async () => submit(codingPlan), /The request reads as a request to review #7, an existing change\. A code review goes to the review team/);
            // A pull request the remote does not have goes back to the planner, as does mixing teams.
            await assert.rejects(async () => submit(reviewPlan("#99")), /The hub cannot review '#99': Could not fetch pull request #99 from origin/);
            await assert.rejects(async () => submit(reviewPlan("#7", ["review", "testing"])), /A code review stands alone/);
            await submit(reviewPlan("PR 7"));
          },
        ],
        ...reviewers,
      },
      { reviewHost: host },
    );
    try {
      pullRequestOnOrigin(h);
      const created = await h.runner.submit({ description: "Review PR #7 and fix anything risky you find", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(h.driver.specsFor("planner").length, 1);
      assert.deepEqual(task.plan?.review, { target: "PR 7", instructions: "Focus on error handling" });
      assert.equal(task.plan?.direct, undefined);
      assert.deepEqual((task.agents ?? []).map((agent) => agent.role).sort(), ["lead-reviewer", "peer-reviewer", "planner"]);
      assert.equal(task.review?.target.pullRequest?.number, 7);
      for (const role of ["executor", "fixer", "coder"] as const) assert.equal(h.driver.specsFor(role).length, 0, role);
      const comm = h.store.recentComm({ taskId: task.id });
      assert.ok(comm.some((entry) => entry.kind === "plan" && entry.from === "planner" && /^Plan: Code review of pull request #7 - /.test(entry.text)));
    } finally {
      h.cleanup();
    }

    // A planner that confirms its plan keeps it: the request asked for changes after all.
    const coding = createHarness({
      planner: [
        async (spec) => {
          if (spec.submit.kind !== "plan") throw new Error("the planner submits plans");
          const submit = spec.submit.onSubmit;
          await assert.rejects(async () => submit(codingPlan), /If the request really asks for changes rather than a review, call submit_plan again with your plan unchanged/);
          await submit(codingPlan);
        },
      ],
      coder: [steps(writeFile("README.md", "# Sample\n\nFixed.\n"), submitWork("Fixed the README"))],
      "code-reviewer": [submitReview("approve")],
    });
    try {
      const created = await coding.runner.submit({ description: "Review the branch main and fix the README typo", kind: "auto", repoId: "sample" });
      await coding.runner.idle();
      const task = coding.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.deepEqual(task.plan?.stages, ["coding"]);
      assert.equal(task.review, undefined);
      assert.equal(coding.driver.specsFor("lead-reviewer").length, 0);
    } finally {
      coding.cleanup();
    }
  });

  test("without a plan from the planner, a review request still gets the reviewers; a pull request that does not exist fails clearly", async () => {
    const h = createHarness({ planner: [() => {}, () => {}, () => {}], ...agreeingReview() }, { reviewHost: new FakeReviewHost() });
    try {
      pullRequestOnOrigin(h);
      const created = await h.runner.submit({ description: "Review pull request #7 and fix anything risky", kind: "auto", repoId: "sample" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      assert.equal(task.plan?.fallback, true);
      assert.deepEqual(task.plan?.review, { target: "#7" });
      assert.equal(task.review?.target.headRef, "refs/pull/7/head");
      assert.deepEqual(task.review!.rounds.map((round) => round.phase), ["findings", "positions", "final", "signoff"]);
      assert.equal(h.driver.specsFor("executor").length, 0);
    } finally {
      h.cleanup();
    }

    const missing = createHarness({}, { reviewHost: new FakeReviewHost() });
    try {
      pullRequestOnOrigin(missing);
      const created = await missing.runner.submit({ description: "Review pull request #99", kind: "auto", repoId: "sample" });
      await missing.runner.idle();
      const task = missing.store.getTask(created.id)!;
      assert.equal(task.status, "failed");
      assert.match(task.error ?? "", /The request asks to review #99, but the hub cannot find it: Could not fetch pull request #99/);
      assert.equal(task.review, undefined);
      assert.equal(task.plan, undefined, "Retry plans the task again");
      assert.equal(missing.driver.specsFor("planner").length, 0);
      assert.equal(missing.driver.specsFor("executor").length, 0);
      assert.equal(branchHead(missing.repoPath, task.branch!), git(missing.repoPath, "rev-parse", "main"), "the task branch was not moved");
    } finally {
      missing.cleanup();
    }
  });
});

describe("code review over HTTP", () => {
  test("the UI's routes create a review, curate its comments, publish them and export Markdown", async () => {
    const host = new FakeReviewHost();
    host.lookup.forBranch = githubPullRequest(5);
    const h = createHarness(agreeingReview(), { reviewHost: host });
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(free));
      });
    });
    const build = { version: "0.1.0", commit: "abc1234", ui: "ui-1" };
    const copilot = { getState: () => ({ authenticated: true }) } as unknown as CopilotService;
    const server = createHttpServer({
      host: "127.0.0.1",
      port,
      publicDir: path.join(import.meta.dirname, "..", "public"),
      router: createApiRouter({ store: h.store, bus: h.bus, runner: h.runner, copilot, repos: {} as RepoService, todos: new TodoService(h.store, h.bus, h.runner), build }),
      uiBuild: build.ui,
    });
    const origin = `http://127.0.0.1:${port}`;
    const call = async (method: string, url: string, body?: unknown) => {
      const response = await fetch(`${origin}${url}`, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json()) as Record<string, any> };
    };
    try {
      addRemote(h);
      featureBranch(h, "feature/greet", { "greet.js": GREET });
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

      // Pages learn which code the hub runs; a page loaded from other UI files cannot change anything.
      assert.deepEqual((await call("GET", "/api/health")).json, { ok: true, ...build });
      const stream = await fetch(`${origin}/api/stream`);
      const reader = stream.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      assert.deepEqual(JSON.parse(/^data: (.*)$/m.exec(first)![1]!).build, build);
      const fromPage = (ui?: string) =>
        fetch(`${origin}/api/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", Origin: origin, ...(ui ? { "X-Hub-UI": ui } : {}) },
          body: JSON.stringify({ maxRounds: 2 }),
        });
      for (const ui of [undefined, "ui-0"]) {
        const stale = await fromPage(ui);
        assert.equal(stale.status, 409);
        assert.deepEqual(await stale.json(), { error: "This page was loaded from an older version of Agent Hub. Reload the page (Ctrl+F5), then try again.", reload: true });
      }
      assert.equal(h.store.settings.maxRounds, 3, "the outdated page changed nothing");
      assert.equal((await fromPage("ui-1")).status, 200);
      assert.equal(h.store.settings.maxRounds, 2);

      const missing = await call("POST", "/api/tasks", { kind: "review", repoId: "sample" });
      assert.equal(missing.status, 400);
      assert.match(missing.json.error, /Enter the pull request/);
      const created = await call("POST", "/api/tasks", { kind: "review", repoId: "sample", reviewTarget: "feature/greet", peerReviewerModel: "fake-peer" });
      assert.equal(created.status, 200, JSON.stringify(created.json));
      const id = created.json.id as string;
      assert.equal(created.json.peerReviewerModel, "fake-peer");
      const early = await call("PATCH", `/api/tasks/${id}/review/comments/R1`, { decision: "drop" });
      assert.equal(early.status, 409);
      await h.runner.idle();

      const dropped = await call("PATCH", `/api/tasks/${id}/review/comments/R2`, { decision: "drop" });
      assert.equal(dropped.status, 200);
      assert.equal(dropped.json.review.curated[1].decision, "drop");
      const edited = await call("PATCH", `/api/tasks/${id}/review/comments/r1`, { body: "Default the name.", severity: "minor" });
      assert.equal(edited.json.review.curated[0].body, "Default the name.");
      assert.equal((await call("PATCH", `/api/tasks/${id}/review/comments/R1`, { severity: "huge" })).status, 400);
      assert.equal((await call("PUT", `/api/tasks/${id}/review/summary`, { body: "Thanks!", event: "COMMENT" })).json.review.body, "Thanks!");
      assert.equal((await call("PUT", `/api/tasks/${id}/review/summary`, { event: "MERGE" })).status, 400);
      const restored = await call("POST", `/api/tasks/${id}/review/comments`, { from: "P2" });
      assert.equal(restored.json.review.curated.length, 3);

      const status = await call("GET", `/api/tasks/${id}/review/publish`);
      assert.deepEqual([status.json.available, status.json.inline, status.json.inBody, status.json.pending], [true, 2, 0, null]);
      const published = await call("POST", `/api/tasks/${id}/review/publish`, {});
      assert.equal(published.status, 200);
      assert.equal(published.json.ok, true, published.json.message);
      assert.match(published.json.message, /2 inline comments/);
      assert.equal(published.json.task.review.publications.length, 1);
      const markdown = await call("GET", `/api/tasks/${id}/review/markdown`);
      assert.match(markdown.json.markdown, /\*\*Minor\*\* · `greet\.js:2`\n\nDefault the name\./);
      assert.equal((await call("POST", `/api/tasks/${id}/push`, {})).status, 409);
      assert.equal((await call("POST", `/api/tasks/${id}/pull-request`, {})).status, 409);
      const settings = await call("PUT", "/api/settings", { peerReviewerModel: "fake-peer-2" });
      assert.equal(settings.json.peerReviewerModel, "fake-peer-2");
    } finally {
      server.close();
      h.cleanup();
    }
  });
});

describe("documents a task generates", () => {
  test("a document task can write several documents; each is listed with its versions and can be viewed", async () => {
    let docPath = "";
    const h = createHarness(
      {
        writer: [
          steps(
            (_spec, prompt) => {
              docPath = designPathFrom(prompt);
            },
            (spec) => fs.writeFileSync(path.join(spec.workingDirectory, docPath), "# Operations guide\n\nSee [FAQ](faq.md).\n"),
            writeFile("docs/faq.md", "# FAQ\n\nQ: Why?\n"),
            submitWork("Wrote the guide and an FAQ"),
          ),
          steps(writeFile("docs/faq.md", "# FAQ\n\nQ: Why?\nA: Because.\n"), submitWork("Answered the FAQ", [{ comment_id: "W1", status: "addressed", note: "Done" }])),
        ],
        "doc-reviewer": [submitReview("request_changes", [{ severity: "major", file: "docs/faq.md", body: "Answer the question" }]), submitReview("approve")],
      },
      { settings: { docFormat: "markdown", documentDir: "docs" } },
    );
    try {
      const created = await h.runner.submit({ description: "Write an operations guide and an FAQ", kind: "document", repoId: "sample", title: "Ops docs" });
      await h.runner.idle();
      const task = h.store.getTask(created.id)!;
      assert.equal(task.status, "completed", String(task.error));
      const stage = task.stages[0]!;
      assert.equal(stage.docPath, "docs/t-001-ops-docs.md");
      assert.deepEqual(stage.extraDocs, ["docs/faq.md"]);
      assert.deepEqual(stage.rounds[0]!.author!.documents?.map((doc) => doc.path), ["docs/t-001-ops-docs.md", "docs/faq.md"]);
      assert.deepEqual(stage.rounds[1]!.author!.documents?.map((doc) => doc.path), ["docs/t-001-ops-docs.md", "docs/faq.md"]);

      // The writer may write several documents; the reviewer reads all of them.
      assert.match(h.driver.specsFor("writer")[0]!.systemPrompt, /When the request calls for several documents/);
      assert.match(h.driver.prompts.writer![0]!, /If the request calls for several documents, `docs\/t-001-ops-docs\.md` is the main one/);
      assert.match(h.driver.prompts["doc-reviewer"]![0]!, /also wrote 1 further document\(s\)[\s\S]*`docs\/faq\.md`:[\s\S]*Q: Why\?/);

      // Each document, at each version.
      const faq = await h.runner.document(task.id, undefined, "docs/faq.md");
      assert.deepEqual([faq.path, faq.format, faq.round, faq.rounds], ["docs/faq.md", "markdown", 2, [1, 2]]);
      assert.match(faq.content!, /A: Because\./);
      const firstFaq = await h.runner.document(task.id, 1, "docs/faq.md");
      assert.doesNotMatch(firstFaq.content!, /A: Because/);
      const main = await h.runner.document(task.id);
      assert.equal(main.path, "docs/t-001-ops-docs.md");
      assert.match(main.content!, /# Operations guide/);
      await assert.rejects(h.runner.document(task.id, undefined, "README.md"), /wrote no document README\.md/);
    } finally {
      h.cleanup();
    }
  });
});
