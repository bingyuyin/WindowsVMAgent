import { del, get, patch, post, put } from "../lib/api.js";
import {
  agentStatusInfo,
  chip,
  clock,
  compactNumber,
  confirmDialog,
  copyButton,
  copyText,
  duration,
  h,
  isCodeReviewTask,
  isDocStage,
  isReviewerRole,
  KIND_LABELS,
  phaseLabel,
  relTime,
  ROLE_DESCRIPTIONS,
  ROLE_ICONS,
  ROLE_LABELS,
  ROLE_SKILLS,
  roleTag,
  rolesForTask,
  setContent,
  shortSha,
  spinner,
  STAGE_LABELS,
  statusInfo,
  toast,
  worksDetached,
} from "../lib/dom.js";
import { renderDiff, renderMarkdown } from "../lib/markdown.js";
import { state } from "../lib/store.js";

const ACTIVE = ["queued", "running", "needs-input"];
const REVIEWER_ROLE = { design: "design-reviewer", document: "doc-reviewer", coding: "code-reviewer", testing: "executor" };
const AUTHOR_ROLE = { design: "designer", document: "writer", coding: "coder", testing: "fixer" };
const TEST_STATUS = { passed: ["Passed", "success"], failed: ["Failed", "danger"], blocked: ["Blocked", "warning"] };
const UNIT_TEST_STATUS = { passed: ["Unit tests pass", "success"], failed: ["Unit tests fail", "danger"], blocked: ["Unit tests blocked", "warning"] };
const CATEGORY_CLASS = { "product-bug": "danger", "test-bug": "warning", environment: "neutral", flaky: "info", integrity: "danger", unknown: "neutral" };
const STAGE_STATUS = {
  pending: ["Pending", "neutral"],
  running: ["In progress", "running"],
  approved: ["Approved", "success"],
  "not-approved": ["Not approved", "warning"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};
const SEVERITY_CLASS = { blocker: "danger", major: "warning", minor: "info", nit: "neutral" };
/** Who makes and who verifies a change request in each stage. */
const CHANGE_TEAMS = {
  design: "the designer revises the design, the design reviewer verifies",
  coding: "the comment resolver changes the code, the code reviewer verifies",
  testing: "the test fixer makes the change, the test executor re-runs and verifies",
  document: "the technical writer revises the document, the doc reviewer verifies",
};
const PROVIDER_NAMES = { github: "GitHub", "azure-devops": "Azure DevOps", gitlab: "GitLab", bitbucket: "Bitbucket" };
const REVIEW_PHASE_TITLES = { findings: "Independent reviews", positions: "Discussion", final: "Final review", signoff: "Sign-off" };
const POSITION_CLASS = { agree: "success", disagree: "danger", refine: "info" };
const REVIEW_EVENT_LABELS = { COMMENT: "Comment", REQUEST_CHANGES: "Request changes", APPROVE: "Approve" };
const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"];
/** Testing stages pass or fail rather than being approved. */
const stageStatus = (stage) =>
  stage.kind === "testing" && stage.status === "approved"
    ? ["Tests pass", "success"]
    : stage.kind === "testing" && stage.status === "not-approved"
      ? ["Tests failing", "warning"]
      : (STAGE_STATUS[stage.status] ?? [stage.status, "neutral"]);
const roundsTabLabel = (task) => (task.stages.length && task.stages.every((stage) => stage.kind === "testing") ? "Test runs" : "Rounds");
const EVENT_ICONS = {
  status: "●",
  phase: "▸",
  info: "ℹ",
  warning: "⚠",
  error: "✕",
  "agent.message": "✦",
  "tool.start": "›",
  submission: "✎",
  review: "◎",
  commit: "⎇",
  "input.request": "?",
  "input.answer": "↩",
};

const meta = (label, ...value) => h("div", { class: "meta" }, h("div", { class: "meta-label" }, label), h("div", { class: "meta-value" }, value));
const excerpt = (text, max = 280) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** "12 tests · 11 passed · 1 failed · 2 skipped · 1 unrelated failure" */
const testCounts = (run) =>
  [
    run.total !== undefined ? `${run.total} test${run.total === 1 ? "" : "s"}` : null,
    run.passed !== undefined ? `${run.passed} passed` : null,
    run.failed ? `${run.failed} failed` : null,
    run.skipped ? `${run.skipped} skipped` : null,
    run.unrelatedFailures?.length ? `${run.unrelatedFailures.length} unrelated failure${run.unrelatedFailures.length === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ") || "no counts reported";

/** Failing tests the change has nothing to do with: reported, not fixed by the task. */
const unrelatedFailuresBlock = (failures) =>
  failures?.length
    ? h(
        "details",
        { class: "sub-block" },
        h("summary", { class: "label" }, `Unrelated failing tests, left for their owners (${failures.length})`),
        h("ul", { class: "small" }, failures.map((failure) => h("li", {}, h("span", { class: "mono" }, failure.test), ` — ${failure.reason}`))),
      )
    : null;

export function taskDetailView(root, { params }) {
  const id = params[0];
  let task = null;
  const events = [];
  let lastSeq = 0;
  let stream = null;
  let reconnectTimer = null;
  let disposed = false;
  let activeTab = "conversation";
  let showTools = true;
  let docRound = null;
  let docMode = "rendered";
  let docFrame = null;
  // The document shown in the Documents tab (null: the first one).
  let docPath = null;
  // Code review: comments being edited (id -> draft), the review text draft, and the publish state from the server.
  const commentDrafts = new Map();
  let bodyDraft = null;
  let reviewBusy = false;
  let publishInfo = null;
  let publishInfoKey = null;
  let showDropped = false;
  let diffSelection = null;
  let renderedInputId = null;
  const signatures = {};
  const toolRows = new Map();
  const toolStatus = new Map();
  const live = { role: null, messageId: null, text: "" };
  // Push / pull request state: what the remote supports (GET /pull-request) and in-flight actions.
  let remoteInfo = null;
  let remoteInfoKey = null;
  let pushBusy = false;
  let prBusy = false;
  let createPageUrl = null;
  // Text typed into the Request changes dialog, kept if the dialog is closed or the request fails.
  let requestDraft = "";
  const deliveryHero = h("div", { class: "delivery" });
  const deliveryResult = h("div", { class: "delivery" });

  const titleBox = h("div", { class: "detail-title-row" });
  const metaBox = h("div", { class: "meta-grid" });
  const requestBox = h("details", { class: "request card" });
  const heroBox = h("div");
  const heroElapsed = h("span", { class: "muted small mono" });
  const inputBox = h("div");
  const planBox = h("div");
  const agentsBox = h("section", { class: "agents" });
  const pipelineBox = h("div");
  const streamRole = h("span", { class: "muted small" });
  const streamPre = h("pre", { class: "stream", "aria-live": "off" });
  const liveActivity = h("div", { class: "live-activity" });
  const liveTools = h("div", { class: "live-tools" });
  const liveHead = h("div", { class: "live-head" });
  const liveBox = h(
    "div",
    { class: "card live", hidden: true },
    liveHead,
    liveActivity,
    h("div", { class: "live-grid" }, h("div", {}, h("div", { class: "label" }, "Agent output ", streamRole), streamPre), h("div", {}, h("div", { class: "label" }, "Recent tool calls"), liveTools)),
  );
  const tabsBar = h("div", { class: "tabs", role: "tablist" });
  const tabBody = h("div", { class: "tab-body" });
  const timelineList = h("div", { class: "timeline" });

  root.append(
    h("a", { class: "back", href: "#/tasks" }, "← Tasks"),
    h("div", { class: "detail-header" }, titleBox, metaBox),
    heroBox,
    inputBox,
    planBox,
    agentsBox,
    pipelineBox,
    liveBox,
    requestBox,
    tabsBar,
    tabBody,
  );
  const body = h("div", { class: "card" }, spinner("Loading task…"));
  tabBody.append(body);

  load();
  const ticker = setInterval(() => task && ACTIVE.includes(task.status) && renderMeta(), 5000);
  const heroTicker = setInterval(() => {
    if (task && ["running", "needs-input"].includes(task.status) && task.phaseStartedAt) {
      heroElapsed.textContent = `${duration(task.phaseStartedAt)} in this step`;
    }
  }, 1000);
  // The sandboxed document viewer reports its content height so the iframe can fit it.
  const onFrameMessage = (event) => {
    if (!docFrame || event.source !== docFrame.contentWindow || event.data?.type !== "hub-doc-height") return;
    const height = Number(event.data.height);
    if (Number.isFinite(height)) docFrame.height = String(Math.min(Math.max(Math.ceil(height) + 4, 320), 40000));
  };
  window.addEventListener("message", onFrameMessage);

  async function load() {
    try {
      const data = await get(`/api/tasks/${encodeURIComponent(id)}`);
      if (disposed) return;
      task = data.task;
      for (const event of data.events) acceptEvent(event, false);
      setContent(requestBox, h("summary", {}, "Request"), renderMarkdown(task.description));
      renderAll();
      connect();
    } catch (error) {
      setContent(tabBody, h("div", { class: "callout callout-danger" }, error.message));
    }
  }

  function connect() {
    if (disposed) return;
    stream = new EventSource(`/api/tasks/${encodeURIComponent(id)}/stream?after=${lastSeq}`);
    stream.onmessage = (message) => handle(JSON.parse(message.data));
    stream.onerror = () => {
      stream.close();
      if (!disposed) reconnectTimer = setTimeout(connect, 2000);
    };
  }

  function handle(message) {
    switch (message.type) {
      case "task":
        task = message.task;
        renderAll();
        break;
      case "event":
        acceptEvent(message.event, true);
        break;
      case "delta":
        if (message.messageId !== live.messageId) {
          live.messageId = message.messageId;
          live.text = "";
        }
        live.role = message.role;
        live.text = (live.text + message.text).slice(-12_000);
        streamRole.textContent = `· ${ROLE_LABELS[message.role] ?? message.role}`;
        streamPre.textContent = live.text;
        streamPre.scrollTop = streamPre.scrollHeight;
        break;
      case "activity":
        if (task) {
          task.activity = message.activity;
          renderLiveHead();
          renderHero();
        }
        break;
    }
  }

  function acceptEvent(event, isLive) {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    events.push(event);
    if (event.type === "tool.done") {
      const success = event.data?.success !== false;
      toolStatus.set(event.data?.toolCallId, { success, error: event.text });
      updateToolRow(event.data?.toolCallId);
    }
    if (!isLive) return;
    if (event.type === "tool.start" || event.type === "tool.done") renderLiveTools();
    if (activeTab === "timeline" && event.type !== "tool.done" && (showTools || event.type !== "tool.start")) {
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      timelineList.append(eventRow(event));
      if (atBottom) window.scrollTo({ top: document.body.scrollHeight });
    }
  }

  // ---- rendering --------------------------------------------------------------------------

  function renderAll() {
    if (!task) return;
    renderTitle();
    renderMeta();
    renderHero();
    renderInput();
    renderPlan();
    renderAgents();
    renderPipeline();
    renderLive();
    renderTabs();
    renderActiveTab(false);
  }

  /** Auto tasks: what the manager decided - which stages (sub-agent teams) to run and each team's assignment. */
  function renderPlan() {
    const signature = JSON.stringify([task.kind, task.plan, task.status, task.phase, task.review?.target]);
    if (signatures.plan === signature) return;
    signatures.plan = signature;
    if (task.kind !== "auto") {
      setContent(planBox);
      return;
    }
    const plan = task.plan;
    if (!plan) {
      const planning = ["running", "needs-input"].includes(task.status);
      setContent(
        planBox,
        h(
          "section",
          { class: "card plan-card" },
          h("div", { class: "plan-head" }, h("span", { class: "plan-badge", "aria-hidden": "true" }, "◆"), h("strong", {}, "Manager's plan")),
          planning
            ? spinner("The manager is reading the request and the repository to decide which sub-agents to create…")
            : h("p", { class: "muted small" }, task.status === "queued" ? "The manager plans this task when it starts." : "The task stopped before the manager finished planning; Retry plans it again."),
        ),
      );
      return;
    }
    const plannedReview = plan.review;
    const reviewTarget = task.review?.target;
    const reviewStatus = task.status === "completed" ? "approved" : ACTIVE.includes(task.status) ? "running" : task.status === "failed" ? "failed" : "pending";
    setContent(
      planBox,
      h(
        "section",
        { class: "card plan-card" },
        h(
          "div",
          { class: "plan-head" },
          h("span", { class: "plan-badge", "aria-hidden": "true" }, "◆"),
          h("strong", {}, "Manager's plan"),
          plan.direct ? chip("assigned directly", "info", "The request names the change to review, so the manager assigned the reviewers without planning") : null,
          plan.fallback ? chip("derived from keywords", "warning", "The planner did not submit a plan; the hub chose from the request") : null,
          h("span", { class: "spacer" }),
          h("span", { class: "muted small" }, plan.plannedAt ? `planned ${clock(plan.plannedAt)}` : ""),
        ),
        h(
          "div",
          { class: "plan-flow" },
          plannedReview
            ? h(
                "span",
                { class: `plan-stage plan-${reviewStatus}` },
                "Code review",
                h("span", { class: "plan-roles" }, `${ROLE_LABELS["lead-reviewer"]} · ${ROLE_LABELS["peer-reviewer"]}`),
              )
            : plan.stages.map((stage, index) => [
                index ? h("span", { class: "plan-arrow", "aria-hidden": "true" }, "→") : null,
                h(
                  "span",
                  { class: `plan-stage plan-${task.stages.find((candidate) => candidate.kind === stage)?.status ?? "pending"}` },
                  STAGE_LABELS[stage],
                  h("span", { class: "plan-roles" }, rolesForTask({ kind: "auto", plan: { stages: [stage] } }).slice(1).map((role) => ROLE_LABELS[role]).join(" · ")),
                ),
              ]),
        ),
        h("p", { class: "plan-rationale" }, plan.rationale),
        plannedReview
          ? h(
              "p",
              { class: "small" },
              h("span", { class: "muted" }, "Reviewing "),
              reviewTarget ? reviewTargetLabel(reviewTarget) : h("span", { class: "mono" }, plannedReview.target),
            )
          : null,
        plan.briefing
          ? h("details", { class: "plan-assignments" }, h("summary", {}, "Briefing on the repository the manager gave every sub-agent"), h("div", { class: "plan-assignment" }, renderMarkdown(plan.briefing)))
          : null,
        plannedReview?.instructions
          ? h(
              "details",
              { class: "plan-assignments" },
              h("summary", {}, "Assignment the manager gave the reviewers"),
              h("div", { class: "plan-assignment" }, renderMarkdown(plannedReview.instructions)),
            )
          : plan.stages.some((stage) => plan.instructions?.[stage])
            ? h(
                "details",
                { class: "plan-assignments" },
                h("summary", {}, "Assignments the manager gave each team"),
                plan.stages.map((stage) =>
                  plan.instructions?.[stage]
                    ? h("div", { class: "plan-assignment" }, h("div", { class: "label" }, `${STAGE_LABELS[stage]} team`), renderMarkdown(plan.instructions[stage]))
                    : null,
                ),
              )
            : null,
      ),
    );
  }

  function renderTitle() {
    const status = statusInfo(task);
    const review = isCodeReviewTask(task);
    const actions = [];
    if (ACTIVE.includes(task.status)) actions.push(h("button", { class: "btn btn-danger-outline", onclick: cancelTask }, "Cancel"));
    if (["failed", "cancelled", "interrupted"].includes(task.status)) actions.push(h("button", { class: "btn btn-primary", onclick: () => retryTask(false) }, "Retry"));
    if (!review && task.status === "completed" && task.result && !task.result.approved) {
      actions.push(h("button", { class: "btn btn-primary", onclick: () => retryTask(true) }, task.stages.at(-1)?.kind === "testing" ? "Continue fixing" : "Continue review loop"));
    }
    if (!review && task.status === "completed" && task.result) actions.push(h("button", { class: "btn", onclick: requestChanges }, "✎ Request changes"));
    if (!ACTIVE.includes(task.status)) actions.push(h("button", { class: "btn btn-ghost-danger", onclick: deleteTask }, "Delete"));
    setContent(
      titleBox,
      h(
        "div",
        { class: "grow" },
        h("div", { class: "task-card-top" }, chip(status.label, status.cls), h("span", { class: "task-id mono" }, task.id), chip(KIND_LABELS[task.kind], "outline")),
        h("h1", { class: "detail-title" }, task.title),
      ),
      h("div", { class: "detail-actions" }, actions),
    );
  }

  function renderMeta() {
    const usage = task.usage ?? {};
    const usageText = `${compactNumber(usage.premiumRequests)} premium req · ${compactNumber((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))} tokens · ${usage.modelCalls ?? 0} calls`;
    if (isCodeReviewTask(task)) {
      const target = task.review?.target;
      const manager = task.kind === "auto" && task.managerModel ? `manager ${task.managerModel} · ` : "";
      setContent(
        metaBox,
        meta("Repository", task.repoName),
        meta("Reviewing", target ? reviewTargetLabel(target) : "—"),
        meta(
          "Change",
          h("span", { class: "mono" }, `${shortSha(task.baseSha)}..${shortSha(target?.headSha)}`),
          task.review?.shortStat ? h("div", { class: "muted small" }, `${task.review.shortStat}${task.review.commits ? ` · ${task.review.commits} commit(s)` : ""}`) : null,
        ),
        meta("Local branch", task.branch ? [h("span", { class: "mono" }, task.branch), " ", copyButton(task.branch)] : "—", h("div", { class: "muted small" }, "points at the reviewed head")),
        meta("Models", h("span", { class: "mono small" }, `${manager}lead ${task.reviewerModel} · peer ${task.peerReviewerModel || task.authorModel}`)),
        meta("Final-review rounds", `up to ${task.roundsBudget ?? task.maxRounds}${task.attempt > 1 ? ` · attempt ${task.attempt}` : ""}`),
        meta("Duration", task.startedAt ? duration(task.startedAt, ACTIVE.includes(task.status) ? null : task.finishedAt) : "—"),
        meta("Usage", usageText),
      );
      return;
    }
    const resolver = task.kind === "coding" || task.kind === "design-coding" || task.kind === "testing" || task.kind === "auto" ? (task.resolverModel && task.resolverModel !== task.authorModel ? ` · resolver/fixer ${task.resolverModel}` : "") : "";
    const manager = task.kind === "auto" && task.managerModel && task.managerModel !== task.authorModel ? `manager ${task.managerModel} · ` : "";
    setContent(
      metaBox,
      meta("Repository", task.repoName),
      meta("Base", h("span", { class: "mono" }, `${task.baseRef} @ ${shortSha(task.baseSha)}`)),
      meta("Task branch", task.branch ? [h("span", { class: "mono" }, task.branch), " ", copyButton(task.branch)] : "—"),
      meta(
        "Workspaces",
        task.workspaceRoot
          ? [h("span", { class: "mono small break" }, task.workspaceRoot), " ", copyButton(task.workspaceRoot)]
          : task.worktreePath
            ? h("span", { class: "mono small break" }, task.worktreePath)
            : "—",
        h("div", { class: "muted small" }, task.isolation === "worktree" ? "one worktree per agent" : "authors share a worktree on their own branches; reviewers have their own"),
      ),
      meta("Models", h("span", { class: "mono small" }, `${manager}author ${task.authorModel}${resolver} · reviewer ${task.reviewerModel}`)),
      meta("Review rounds", `up to ${task.roundsBudget ?? task.maxRounds}${task.attempt > 1 ? ` · attempt ${task.attempt}` : ""}`),
      meta("Duration", task.startedAt ? duration(task.startedAt, ACTIVE.includes(task.status) ? null : task.finishedAt) : "—"),
      meta(
        "Usage",
        usageText,
      ),
    );
  }

  /** "Pull request #12 ↗ Add retry support (feature/retry → main)" or "feature/x → main". */
  function reviewTargetLabel(target) {
    const pr = target.pullRequest;
    const branches = `${pr?.headBranch ?? target.headRef} → ${pr?.baseBranch ?? target.baseRef}`;
    if (!pr) return h("span", {}, h("span", { class: "mono" }, branches));
    const name = `${pr.provider === "gitlab" ? "Merge request !" : "Pull request #"}${pr.number}`;
    return h(
      "span",
      {},
      pr.url ? h("a", { href: pr.url, target: "_blank", rel: "noopener noreferrer" }, `${name} ↗`) : name,
      pr.title ? h("span", {}, ` ${pr.title}`) : null,
      h("div", { class: "muted small mono" }, `${branches}${pr.author ? ` · by ${pr.author}` : ""}`),
    );
  }

  /** Top-of-page status: what is happening right now, or the outcome once the task has finished. */
  function renderHero() {
    const status = task.status;
    // The change request this run works on (if it was started by one).
    const activeRequest = ACTIVE.includes(status) ? (task.changeRequests ?? []).findLast((request) => request.attempt === task.attempt) : undefined;
    const requestLine = activeRequest
      ? h(
          "div",
          { class: "hero-request" },
          h("span", { class: "mono comment-id" }, activeRequest.id),
          h("span", { class: "muted" }, ` Your change request (${STAGE_LABELS[activeRequest.stage]} stage): `),
          `“${excerpt(activeRequest.text, 240)}”`,
        )
      : null;
    if (status === "queued") {
      setContent(
        heroBox,
        h(
          "div",
          { class: "card hero" },
          h("div", { class: "hero-kicker" }, "QUEUED"),
          h("div", { class: "hero-title" }, "Waiting for a free slot"),
          h("div", { class: "muted" }, `Up to ${state.settings?.maxConcurrency ?? 10} tasks run in parallel; this one starts automatically when a slot frees up.`),
          requestLine,
        ),
      );
      return;
    }
    if (status === "running" || status === "needs-input") {
      const working = (task.agents ?? []).find((agent) => agent.status === "working");
      const together = (task.agents ?? []).filter((agent) => agent.status === "working");
      const role = working?.role ?? task.activity?.role;
      const budget = task.roundsBudget ?? task.maxRounds;
      const now = task.activity && task.activity.role === role ? task.activity.text : working?.lastActivity;
      const kicker = [phaseLabel(task.currentStage, task.phase).toUpperCase(), task.currentRound ? `ROUND ${task.currentRound} OF ${Math.max(budget, task.currentRound)}` : null]
        .filter(Boolean)
        .join(" · ");
      heroElapsed.textContent = task.phaseStartedAt ? `${duration(task.phaseStartedAt)} in this step` : "";
      setContent(
        heroBox,
        h(
          "div",
          { class: `card hero hero-live ${status === "needs-input" ? "hero-attention" : ""}` },
          h("div", { class: "hero-top" }, h("span", { class: "pulse", "aria-hidden": "true" }), h("span", { class: "hero-kicker" }, `LIVE · ${kicker}`), h("span", { class: "spacer" }), heroElapsed),
          h(
            "div",
            { class: "hero-main" },
            h("div", { class: `hero-icon role-${role ?? "none"}`, "aria-hidden": "true" }, role ? ROLE_ICONS[role] : "…"),
            h(
              "div",
              { class: "grow" },
              h(
                "div",
                { class: "hero-title" },
                status === "needs-input"
                  ? `${ROLE_LABELS[task.pendingInput?.role] ?? "An agent"} is waiting for your answer`
                  : role === "planner"
                    ? "Manager is planning: deciding which sub-agents to create and what each should do"
                    : together.length > 1
                      ? `${together.map((agent) => ROLE_LABELS[agent.role]).join(" and ")} are working in parallel: ${phaseLabel(task.currentStage, task.phase).toLowerCase()}`
                      : role
                        ? `${ROLE_LABELS[role]}: ${working?.assignment ?? phaseLabel(task.currentStage, task.phase)}`
                        : phaseLabel(task.currentStage, task.phase),
              ),
              requestLine,
              now ? h("div", { class: "hero-now" }, h("span", { class: "muted" }, "Now: "), h("span", { class: "mono" }, now)) : null,
              working?.lastMessage ? h("div", { class: "hero-message" }, `“${excerpt(working.lastMessage)}”`) : null,
            ),
          ),
        ),
      );
      return;
    }
    if (status === "completed" && task.result && isCodeReviewTask(task)) {
      renderReviewHero();
      return;
    }
    if (status === "completed" && task.result) {
      const result = task.result;
      const lastStage = task.stages.at(-1);
      const testsLast = lastStage?.kind === "testing";
      // The latest approval (a change request adds rounds after the first one).
      const approvedRound = lastStage?.rounds.findLast((round) => round.review?.verdict === "approve");
      const reviewer = lastStage ? ROLE_LABELS[REVIEWER_ROLE[lastStage.kind]] : "reviewer";
      const docPath = result.docPath ?? result.designDocPath;
      const docStage = task.stages.find((stage) => isDocStage(stage.kind));
      const documentCount = documentsOfTask().length;
      const tests = result.tests;
      // Later attempts (retries, change requests) report their own run time, not the time since the first run.
      const tookText =
        task.attempt > 1 && task.attemptStartedAt ? `this run took ${duration(task.attemptStartedAt, task.finishedAt)}` : `took ${duration(task.startedAt, task.finishedAt)}`;
      const title = testsLast
        ? result.approved
          ? `✓ All tests pass — verified by the test executor${approvedRound ? ` in round ${approvedRound.n}` : ""}`
          : `Tests still failing — ${result.openComments} failure(s) remain`
        : result.approved
          ? `✓ Approved by the ${reviewer.toLowerCase()}${approvedRound ? ` in round ${approvedRound.n}` : ""}`
          : `Finished without approval — ${result.openComments} review comment(s) still open`;
      setContent(
        heroBox,
        h(
          "div",
          { class: `card hero hero-result ${result.approved ? "hero-ok" : "hero-warn"}` },
          h("div", { class: "hero-top" }, h("span", { class: "hero-kicker" }, "RESULT"), h("span", { class: "spacer" }), h("span", { class: "muted small" }, tookText)),
          h("div", { class: "hero-title" }, title),
          h(
            "div",
            { class: "result-stats" },
            tests ? h("span", {}, chip(...(TEST_STATUS[tests.status] ?? [tests.status, "neutral"])), " ", testCounts(tests)) : null,
            result.unitTests ? h("span", {}, chip(...(UNIT_TEST_STATUS[result.unitTests.status] ?? [result.unitTests.status, "neutral"]))) : null,
            h("span", {}, h("strong", {}, String(result.commits ?? 0)), " commit(s)"),
            result.shortStat ? h("span", {}, result.shortStat) : null,
            docPath ? h("span", {}, docStage?.kind === "document" ? "document " : "design ", h("span", { class: "mono" }, docPath)) : null,
            task.branch ? h("span", {}, "branch ", h("span", { class: "mono" }, task.branch), " ", copyButton(task.branch)) : null,
          ),
          result.summary ? h("div", { class: "hero-summary" }, renderMarkdown(result.summary)) : null,
          deliveryHero,
          h(
            "div",
            { class: "row wrap" },
            docStage
              ? h(
                  "button",
                  { class: "btn btn-sm btn-primary", onclick: () => selectTab("document") },
                  documentCount > 1 ? `View documents (${documentCount})` : docStage.kind === "document" ? "View document" : "View design",
                )
              : null,
            h("button", { class: "btn btn-sm", onclick: () => selectTab("changes") }, "View changes"),
            h("button", { class: "btn btn-sm", onclick: () => selectTab("conversation") }, roundsTabLabel(task)),
            h("button", { class: "btn btn-sm", onclick: () => selectTab("result") }, "Merge instructions"),
            !result.approved ? h("button", { class: "btn btn-sm btn-primary", onclick: () => retryTask(true) }, testsLast ? "Continue fixing" : "Continue review loop") : null,
            h("button", { class: "btn btn-sm", title: "Ask the agents for further changes or adjustments", onclick: requestChanges }, "✎ Request changes"),
          ),
        ),
      );
      renderDelivery();
      return;
    }
    if (status === "failed") {
      setContent(heroBox, h("div", { class: "callout callout-danger" }, h("strong", {}, "Failed: "), task.error ?? "unknown error", h("div", { class: "muted small" }, "Retry resumes from the last completed step; the agents' branches and worktrees are kept.")));
    } else if (status === "interrupted") {
      setContent(heroBox, h("div", { class: "callout callout-warning" }, "The hub stopped while this task was running. Retry resumes from the last completed step."));
    } else if (status === "cancelled") {
      setContent(heroBox, h("div", { class: "callout" }, "Cancelled. Work committed so far stays on the task branch; Retry resumes from the last completed step."));
    } else {
      setContent(heroBox);
    }
  }

  /** A finished code review: what changed, how many comments, whether the reviewers agree, and where it was published. */
  function renderReviewHero() {
    const review = task.review ?? {};
    const final = review.final;
    const kept = (review.curated ?? []).filter((comment) => comment.decision === "keep");
    const signoff = review.signoff;
    const main = review.publications?.find((publication) => publication.main);
    const pr = review.target?.pullRequest;
    const tookText =
      task.attempt > 1 && task.attemptStartedAt ? `this run took ${duration(task.attemptStartedAt, task.finishedAt)}` : `took ${duration(task.startedAt, task.finishedAt)}`;
    const consensus = signoff?.agreed
      ? chip("Both reviewers agree", "success")
      : signoff?.fallback
        ? chip("The peer reviewer did not sign off", "warning")
        : signoff
          ? chip(`The peer reviewer objects to ${signoff.objections.length} item(s)`, "warning")
          : null;
    setContent(
      heroBox,
      h(
        "div",
        { class: `card hero hero-result ${signoff && !signoff.agreed ? "hero-warn" : "hero-ok"}` },
        h("div", { class: "hero-top" }, h("span", { class: "hero-kicker" }, "CODE REVIEW"), h("span", { class: "spacer" }), h("span", { class: "muted small" }, tookText)),
        h(
          "div",
          { class: "hero-title" },
          main ? `✓ Review published on ${pr ? `pull request #${pr.number}` : "the pull request"}` : `Code review ready: ${kept.length} comment${kept.length === 1 ? "" : "s"} to publish`,
        ),
        h(
          "div",
          { class: "result-stats" },
          consensus,
          severityChips(kept),
          final ? h("span", {}, `verdict: ${final.verdict === "approve" ? "approve" : "request changes"}`) : null,
          review.shortStat ? h("span", {}, review.shortStat) : null,
          main?.url ? h("a", { href: main.url, target: "_blank", rel: "noopener noreferrer" }, "View on the pull request ↗") : null,
        ),
        final?.changeSummary ? h("div", { class: "hero-summary" }, h("div", { class: "label" }, "What the change does"), renderMarkdown(final.changeSummary)) : null,
        h(
          "div",
          { class: "row wrap" },
          h("button", { class: "btn btn-sm btn-primary", onclick: () => selectTab("review") }, main ? "Review & update the comments" : "Review & publish the comments"),
          h("button", { class: "btn btn-sm", onclick: () => selectTab("discussion") }, "Reviewers' discussion"),
          h("button", { class: "btn btn-sm", onclick: () => selectTab("changes") }, "View changes"),
        ),
      ),
    );
  }

  /** "2 major · 1 minor" as chips, most severe first. */
  function severityChips(comments) {
    return SEVERITY_ORDER.map((severity) => [severity, comments.filter((comment) => comment.severity === severity).length])
      .filter(([, count]) => count)
      .map(([severity, count]) => chip(`${count} ${severity}`, SEVERITY_CLASS[severity]));
  }

  /** Every document the task's design/document stages wrote, deliverables first, with the rounds each one changed in. */
  function documentsOfTask() {
    const documents = [];
    for (const stage of task.stages.filter((candidate) => isDocStage(candidate.kind))) {
      const rounds = new Map();
      if (stage.docPath) rounds.set(stage.docPath, []);
      for (const round of stage.rounds) {
        const written = round.author?.documents ?? (round.author?.docSnapshot && stage.docPath ? [{ path: stage.docPath }] : []);
        for (const doc of written) {
          if (!rounds.has(doc.path)) rounds.set(doc.path, []);
          rounds.get(doc.path).push(round.n);
        }
      }
      for (const [path, versions] of rounds) {
        if (!versions.length) continue;
        const primary = path === stage.docPath;
        documents.push({
          stage,
          path,
          primary,
          versions,
          format: primary && stage.docFormat ? stage.docFormat : /\.html?$/i.test(path) ? "html" : "markdown",
        });
      }
    }
    return documents;
  }

  /** Where the task branch stands on the remote, plus the push and pull request actions (hero and Result tab). */
  function renderDelivery() {
    if (!task || task.status !== "completed" || !task.result || isCodeReviewTask(task)) return;
    refreshRemoteInfo();
    setContent(deliveryHero, deliveryContent());
    setContent(deliveryResult, deliveryContent());
  }

  function refreshRemoteInfo() {
    const key = JSON.stringify([task.id, task.push?.status, task.push?.sha, task.pullRequest?.url]);
    if (remoteInfoKey === key) return;
    remoteInfoKey = key;
    get(`/api/tasks/${encodeURIComponent(task.id)}/pull-request`)
      .catch((error) => ({ remote: null, direct: false, supported: false, error: error.message }))
      .then((info) => {
        if (disposed || remoteInfoKey !== key) return;
        remoteInfo = info;
        renderDelivery();
      });
  }

  function deliveryContent() {
    const push = task.push;
    const pullRequest = task.pullRequest ?? remoteInfo?.pullRequest;
    const remote = remoteInfo?.remote ?? null;
    const noChanges = !task.result.commits;
    const pushing = pushBusy || push?.status === "pushing";
    const behind = push?.status === "pushed" && push.sha && task.result.headSha && push.sha !== task.result.headSha;
    const where = push?.remote ? `${push.remote}/${push.branch}` : push?.branch;
    const link = (href, label) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);

    let status;
    if (pushing) {
      status = [spinner(), h("span", {}, `Pushing ${task.branch} to ${push?.remote ?? remote?.name ?? "the remote"}…`)];
    } else if (push?.status === "pushed") {
      status = [
        h("span", { class: "delivery-icon delivery-ok" }, "✓"),
        h("span", {}, "Pushed to ", h("span", { class: "mono" }, where)),
        h("span", { class: "muted" }, `${shortSha(push.sha)} · ${relTime(push.at)}${push.auto ? " · automatically" : ""}`),
        push.webUrl ? link(push.webUrl, "View branch ↗") : null,
        behind ? h("span", { class: "delivery-warn" }, "the branch has newer commits") : null,
      ];
    } else if (push?.status === "failed") {
      status = [h("span", { class: "delivery-icon delivery-bad" }, "✕"), h("span", {}, "Push to ", h("span", { class: "mono" }, where ?? task.branch), " failed")];
    } else if (push?.status === "skipped") {
      status = [h("span", { class: "delivery-icon" }, "–"), h("span", { class: "muted" }, `Not pushed: ${push.reason}`)];
    } else {
      status = [h("span", { class: "delivery-icon" }, "–"), h("span", { class: "muted" }, state.settings?.pushOnComplete === false ? "Not pushed (automatic pushes are off)" : "Not pushed yet")];
    }

    const canPush = remote && !pushing && !noChanges && (push?.status !== "pushed" || behind);
    const pushButton = canPush
      ? h("button", { class: "btn btn-sm", onclick: pushTaskBranch }, push?.status === "failed" ? "Retry push" : behind ? "Push again" : "Push branch")
      : null;

    let prButton;
    if (pullRequest) {
      prButton = [
        h("a", { class: "btn btn-sm btn-primary", href: pullRequest.url, target: "_blank", rel: "noopener noreferrer" }, `Pull request${pullRequest.number ? ` #${pullRequest.number}` : ""} ↗`),
        pullRequest.draft ? chip("Draft", "neutral") : null,
      ];
    } else {
      const direct = Boolean(remoteInfo?.direct);
      const disabledReason = !remoteInfo
        ? "Checking the repository's remote…"
        : !remote
          ? "No git remote is configured for this repository"
          : !remoteInfo.supported
            ? `Pull requests are not supported for ${remote.url}`
            : noChanges
              ? "The task made no changes"
              : pushing
                ? "Wait for the push to finish"
                : null;
      const label = prBusy ? "Creating…" : `Create ${direct && !task.result.approved ? "draft " : ""}pull request${direct ? "" : " ↗"}`;
      prButton = h(
        "button",
        {
          class: `btn btn-sm ${task.result.approved ? "btn-primary" : ""}`,
          disabled: Boolean(disabledReason) || prBusy,
          title: disabledReason ?? (direct ? "Pushes the branch if needed and opens the pull request" : "Pushes the branch if needed and opens the page to create the pull request"),
          onclick: createPullRequest,
        },
        label,
      );
    }

    const host = remote ? (PROVIDER_NAMES[remote.provider] ?? remote.host ?? "the remote") : null;
    let hint = null;
    if (remoteInfo?.error) hint = `Could not check the remote: ${remoteInfo.error}`;
    else if (remoteInfo && !remote) hint = "No git remote is configured for this repository; add one (git remote add origin <url>) to push the branch and open pull requests.";
    else if (remote && !pullRequest && remoteInfo.supported && !remoteInfo.direct && !noChanges)
      hint = `The pull request button opens ${host}'s create page with the branches filled in${remote.provider === "github" ? "; sign the GitHub CLI in (gh auth login) to have the hub create it directly" : ""}.`;

    return [
      h("div", { class: "delivery-row" }, h("div", { class: "delivery-status" }, status), h("span", { class: "spacer" }), pushButton, prButton),
      push?.status === "failed" && push.reason && !pushing ? h("div", { class: "delivery-error" }, push.reason) : null,
      createPageUrl && !pullRequest ? h("div", { class: "small" }, "If the page didn't open: ", link(createPageUrl, `create the pull request on ${host ?? "the remote"} ↗`)) : null,
      hint ? h("div", { class: "muted small" }, hint) : null,
    ];
  }

  /** One card per sub-agent: role, model, status, own branch/workspace, current assignment and activity. */
  function renderAgents() {
    const byRole = new Map((task.agents ?? []).map((agent) => [agent.role, agent]));
    const signature = JSON.stringify([task.status, task.agents, task.activity?.text, task.plan?.stages]);
    if (signatures.agents === signature) return;
    signatures.agents = signature;
    if (!task.agents?.length && task.layout !== 2 && !ACTIVE.includes(task.status)) {
      setContent(
        agentsBox,
        h("h2", { class: "section-title" }, "Agents"),
        h("div", { class: "callout" }, "This task ran before per-agent branches and tracking were added; see Review rounds and Timeline for what each agent did."),
      );
      return;
    }
    setContent(
      agentsBox,
      h("h2", { class: "section-title" }, "Agents"),
      task.kind === "auto" && !task.plan && ACTIVE.includes(task.status)
        ? h("p", { class: "muted small" }, "The manager creates the other sub-agents once it has planned the task.")
        : null,
      h(
        "div",
        { class: "agent-grid" },
        rolesForTask(task).map((role) => {
          const agent = byRole.get(role);
          const notNeeded = !agent && !ACTIVE.includes(task.status) && task.status === "completed";
          const info = notNeeded ? { label: "Not needed", cls: "neutral" } : agentStatusInfo(agent);
          const detached = worksDetached(role);
          const tokens = agent ? (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0) : 0;
          const skills = agent?.skills ?? ROLE_SKILLS[role];
          const recoveries = agent?.recoveries ? ` · recovered ${agent.recoveries}×` : "";
          const workspace = agent?.workspace
            ? agent.workspaceRemoved
              ? h("span", { class: "muted small" }, "worktree removed after completion")
              : [h("span", { class: "mono small break" }, agent.workspace), " ", copyButton(agent.workspace)]
            : h("span", { class: "muted small" }, "—");
          const checkout =
            role === "executor"
              ? "detached at the commit under test (runs commands, cannot edit files)"
              : role === "planner"
                ? "read-only checkout at the base commit"
                : "detached at the reviewed commit (read-only)";
          const branch = detached
            ? h("span", { class: "muted small" }, checkout)
            : agent?.branch
              ? [h("span", { class: "mono small break" }, agent.branch), " ", copyButton(agent.branch)]
              : h("span", { class: "muted small" }, notNeeded ? "—" : "created when the agent starts");
          const unusedText =
            role === "resolver" ? "approved without review comments to resolve" : role === "fixer" ? "tests passed without failures to fix" : "not used by this run";
          return h(
            "div",
            { class: `agent-card agent-${agent?.status ?? (notNeeded ? "unused" : "pending")}` },
            h(
              "div",
              { class: "agent-head" },
              h("span", { class: `agent-icon role-${role}`, "aria-hidden": "true" }, ROLE_ICONS[role]),
              h("div", { class: "grow" }, h("div", { class: "agent-name" }, ROLE_LABELS[role]), h("div", { class: "muted small" }, ROLE_DESCRIPTIONS[role])),
              chip(info.label, info.cls),
            ),
            agent?.status === "working" && agent.assignment ? h("div", { class: "agent-now" }, agent.assignment) : null,
            agent?.lastActivity && agent.status === "working" ? h("div", { class: "agent-activity mono ellipsis", title: agent.lastActivity }, `› ${agent.lastActivity}`) : null,
            agent?.lastMessage ? h("div", { class: "agent-message", title: agent.lastMessage }, `“${excerpt(agent.lastMessage, 180)}”`) : null,
            h(
              "dl",
              { class: "agent-meta" },
              h("dt", {}, "Model"),
              h("dd", { class: "mono small" }, agent?.model ?? modelForRole(role)),
              h("dt", {}, detached ? "Checkout" : "Branch"),
              h("dd", {}, branch),
              h("dt", {}, "Worktree"),
              h("dd", {}, workspace),
              h("dt", {}, "Progress"),
              h(
                "dd",
                { class: "small" },
                agent
                  ? `${agent.rounds.length ? `round${agent.rounds.length > 1 ? "s" : ""} ${agent.rounds.join(", ")} · ` : ""}${agent.turns} turn(s) · ${compactNumber(tokens)} tokens${recoveries}`
                  : notNeeded
                    ? unusedText
                    : "not started",
              ),
              skills.length ? h("dt", {}, "Skills") : null,
              skills.length ? h("dd", { class: "small" }, skills.map((skill) => h("span", { class: "skill-chip" }, skill))) : null,
            ),
          );
        }),
      ),
    );
  }

  function modelForRole(role) {
    if (role === "planner") return task.managerModel || task.authorModel;
    if (role === "peer-reviewer") return task.peerReviewerModel || task.authorModel;
    if (isReviewerRole(role) || role === "executor") return task.reviewerModel;
    if (role === "resolver" || role === "fixer") return task.resolverModel || task.authorModel;
    return task.authorModel;
  }

  function renderInput() {
    const pending = task.pendingInput;
    if (!pending) {
      renderedInputId = null;
      setContent(inputBox);
      return;
    }
    if (renderedInputId === pending.id) return;
    renderedInputId = pending.id;
    const answerInput = h("textarea", { class: "input", rows: "3", placeholder: "Type your answer…" });
    const send = async (answer) => {
      if (!answer.trim()) return;
      try {
        await post(`/api/tasks/${encodeURIComponent(task.id)}/input`, { inputId: pending.id, answer });
        toast("Answer sent", "success");
      } catch (error) {
        toast(error.message, "error");
      }
    };
    setContent(
      inputBox,
      h(
        "div",
        { class: "card input-card" },
        h("div", { class: "input-head" }, chip("Needs your input", "attention"), roleTag(pending.role), h("span", { class: "muted small" }, clock(pending.askedAt))),
        renderMarkdown(pending.question),
        pending.choices.length ? h("div", { class: "row wrap" }, pending.choices.map((choice) => h("button", { class: "btn", onclick: () => send(choice) }, choice))) : null,
        pending.allowFreeform || !pending.choices.length
          ? h("div", { class: "stack" }, answerInput, h("div", { class: "row end" }, h("button", { class: "btn btn-primary", onclick: () => send(answerInput.value) }, "Send answer")))
          : null,
      ),
    );
  }

  function renderPipeline() {
    if (isCodeReviewTask(task)) {
      renderReviewPipeline();
      return;
    }
    const signature = JSON.stringify([task.status, task.phase, task.currentStage, task.currentRound, task.stages.map((s) => [s.status, s.rounds.map((r) => [Boolean(r.author), r.review?.verdict, r.review?.comments.length])])]);
    if (signatures.pipeline === signature) return;
    signatures.pipeline = signature;
    const running = ["running", "needs-input"].includes(task.status);
    if (!task.stages.length) {
      setContent(pipelineBox, task.kind === "auto" ? h("div", { class: "card pipeline muted small" }, running ? spinner("Stages appear once the manager has planned the task…") : "Not planned yet.") : null);
      return;
    }
    setContent(
      pipelineBox,
      h(
        "div",
        { class: "card pipeline" },
        task.stages.map((stage, index) => {
          const [label, cls] = stageStatus(stage);
          const testing = stage.kind === "testing";
          return [
            index > 0 ? h("div", { class: "stage-arrow", "aria-hidden": "true" }, "→") : null,
            h(
              "div",
              { class: `stage stage-${stage.status}` },
              h("div", { class: "stage-head" }, h("span", { class: "stage-name" }, `${STAGE_LABELS[stage.kind]} stage`), chip(label, cls)),
              h(
                "div",
                { class: "rounds" },
                stage.rounds.length
                  ? stage.rounds.map((round) => {
                      if (round.review?.by === "user") {
                        const ids = round.review.comments.map((comment) => comment.id).join(", ");
                        return h(
                          "div",
                          { class: "round-node round-node-user" },
                          h("div", { class: "rn-title" }, `Round ${round.n}`),
                          h("div", { class: "rn-steps" }, h("span", { class: "rn-step rn-user", title: round.review.comments.map((comment) => `${comment.id}: ${excerpt(comment.body, 200)}`).join("\n") }, `✎ Your request ${ids}`)),
                        );
                      }
                      const current = running && task.currentStage === stage.kind && task.currentRound === round.n;
                      const authorState = round.author ? "done" : current && task.phase !== "reviewing" ? "active" : "pending";
                      const reviewState = round.review ? (round.review.verdict === "approve" ? "approved" : "changes") : current && task.phase === "reviewing" ? "active" : "pending";
                      const run = round.review?.testRun;
                      const reviewLabel = round.review
                        ? testing
                          ? run?.status === "passed"
                            ? "✓ Passed"
                            : run?.status === "blocked"
                              ? "⛔ Blocked"
                              : `✕ ${round.review.comments.length} failing`
                          : round.review.verdict === "approve"
                            ? "✓ Approved"
                            : `✕ ${round.review.comments.length} comment${round.review.comments.length === 1 ? "" : "s"}`
                        : reviewState === "active"
                          ? testing
                            ? "Running…"
                            : "Reviewing…"
                          : testing
                            ? "▶ Run"
                            : "Review";
                      const authorLabel = authorState === "active"
                        ? testing
                          ? "Fixing…"
                          : `${isDocStage(stage.kind) ? "Writing" : "Coding"}…`
                        : testing
                          ? "✚ Fix"
                          : isDocStage(stage.kind)
                            ? "✎ Draft"
                            : "✎ Code";
                      // The first test run has no fix step before it.
                      const showAuthor = !testing || Boolean(round.author) || authorState === "active";
                      return h(
                        "div",
                        { class: `round-node ${current ? "current" : ""}` },
                        h("div", { class: "rn-title" }, `Round ${round.n}`),
                        h(
                          "div",
                          { class: "rn-steps" },
                          showAuthor ? h("span", { class: `rn-step rn-${authorState}` }, authorLabel) : null,
                          showAuthor ? h("span", { class: "rn-sep" }, "→") : null,
                          h("span", { class: `rn-step rn-${reviewState}` }, reviewLabel),
                        ),
                      );
                    })
                  : h("span", { class: "muted small" }, task.status === "queued" ? "Waiting to start" : "Not started"),
              ),
            ),
          ];
        }),
      ),
    );
  }

  /** Code review progress: independent reviews → discussion → final review ↔ sign-off → your curation and publishing. */
  function renderReviewPipeline() {
    const review = task.review;
    const kept = (review?.curated ?? []).filter((comment) => comment.decision === "keep").length;
    const published = Boolean(review?.publications?.some((publication) => publication.main));
    const signature = JSON.stringify([
      task.status,
      task.phase,
      task.currentRound,
      review?.rounds.map((round) => [round.phase, round.entries.map((entry) => [entry.role, entry.signoff?.agreed, entry.final?.comments.length, entry.comments?.length])]),
      published,
      kept,
    ]);
    if (signatures.pipeline === signature) return;
    signatures.pipeline = signature;
    const running = ["running", "needs-input"].includes(task.status);
    const rounds = review?.rounds ?? [];
    const rolesIn = (phase) => (phase === "findings" || phase === "positions" ? ["lead-reviewer", "peer-reviewer"] : phase === "final" ? ["lead-reviewer"] : ["peer-reviewer"]);
    const step = (round, role) => {
      const entry = round.entries.find((candidate) => candidate.role === role);
      const who = role === "lead-reviewer" ? "Lead" : "Peer";
      if (!entry) {
        const active = running && task.currentRound === round.n;
        return h("span", { class: `rn-step ${active ? "rn-active" : "rn-pending"}` }, active ? `${who}…` : who);
      }
      const text =
        round.phase === "findings"
          ? `✓ ${who}: ${entry.comments?.length ?? 0} comment(s)`
          : round.phase === "positions"
            ? `✓ ${who}: ${entry.positions?.length ?? 0} response(s)`
            : round.phase === "final"
              ? `✓ ${who}: ${entry.final?.comments.length ?? 0} comment(s)`
              : entry.signoff?.agreed
                ? `✓ ${who} agrees`
                : `✕ ${who}: ${entry.signoff?.objections.length ?? 0} objection(s)`;
      const cls = round.phase === "signoff" ? (entry.signoff?.agreed ? "rn-approved" : "rn-changes") : "rn-done";
      return h("span", { class: `rn-step ${cls}`, title: excerpt(entry.summary, 300) }, text);
    };
    const nodes = rounds.map((round) =>
      h(
        "div",
        { class: `round-node ${running && task.currentRound === round.n ? "current" : ""}` },
        h("div", { class: "rn-title" }, `Round ${round.n} · ${REVIEW_PHASE_TITLES[round.phase]}`),
        h("div", { class: "rn-steps" }, rolesIn(round.phase).map((role) => step(round, role))),
      ),
    );
    const yours =
      task.status === "completed" && review?.curated
        ? h(
            "div",
            { class: "round-node round-node-user" },
            h("div", { class: "rn-title" }, "You"),
            h("div", { class: "rn-steps" }, h("span", { class: `rn-step ${published ? "rn-approved" : "rn-user"}` }, published ? `✓ Published ${kept} comment(s)` : `✎ Keep, drop or edit ${kept}, then publish`)),
          )
        : null;
    const [label, cls] =
      task.status === "completed" ? (published ? ["Published", "success"] : ["Ready for you", "success"]) : running ? ["In progress", "running"] : [statusInfo(task).label, statusInfo(task).cls];
    setContent(
      pipelineBox,
      h(
        "div",
        { class: "card pipeline" },
        h(
          "div",
          { class: `stage stage-${task.status === "completed" ? "approved" : running ? "running" : "pending"}` },
          h("div", { class: "stage-head" }, h("span", { class: "stage-name" }, "Code review"), chip(label, cls)),
          h("div", { class: "rounds" }, nodes.length ? [nodes, yours] : h("span", { class: "muted small" }, task.status === "queued" ? "Waiting to start" : "Not started")),
        ),
      ),
    );
  }

  function renderLive() {
    const running = ["running", "needs-input"].includes(task.status);
    liveBox.hidden = !running;
    if (!running) return;
    renderLiveHead();
    renderLiveTools();
  }

  function renderLiveHead() {
    const role = task.activity?.role;
    setContent(
      liveHead,
      h("span", { class: "pulse", "aria-hidden": "true" }),
      h("strong", {}, "Live"),
      h("span", { class: "muted" }, `· ${phaseLabel(task.currentStage, task.phase)}${task.currentRound ? ` · round ${task.currentRound}` : ""}`),
      role ? roleTag(role) : null,
    );
    setContent(liveActivity, task.activity ? [h("span", { class: "muted small" }, "Now: "), h("span", { class: "mono" }, task.activity.text)] : h("span", { class: "muted small" }, "Waiting for agent activity…"));
  }

  function renderLiveTools() {
    if (liveBox.hidden) return;
    const recent = events.filter((event) => event.type === "tool.start").slice(-8).reverse();
    setContent(
      liveTools,
      recent.length
        ? recent.map((event) => {
            const status = toolStatus.get(event.data?.toolCallId);
            return h(
              "div",
              { class: "live-tool" },
              h("span", { class: `tool-status ${status ? (status.success ? "ok" : "fail") : "run"}` }, status ? (status.success ? "✓" : "✕") : "…"),
              event.role ? roleTag(event.role) : null,
              h("span", { class: "mono ellipsis", title: event.text }, event.text),
            );
          })
        : h("div", { class: "muted small" }, "No tool calls yet."),
    );
  }

  function renderTabs() {
    const docStage = task.stages.find((stage) => isDocStage(stage.kind));
    const documentCount = documentsOfTask().length;
    const tabs =
      isCodeReviewTask(task)
        ? [
            ["review", "Review"],
            ["discussion", "Discussion"],
            ["changes", "Changes"],
            ["timeline", "Timeline"],
            ["context", "Context"],
          ]
        : [
            ["conversation", roundsTabLabel(task)],
            ["timeline", "Timeline"],
            docStage ? ["document", documentCount > 1 ? `Documents (${documentCount})` : docStage.kind === "document" ? "Document" : "Design doc"] : null,
            ["changes", "Changes"],
            ["context", "Context"],
            ["result", "Result"],
          ].filter(Boolean);
    if (!tabs.some(([tabId]) => tabId === activeTab)) activeTab = tabs[0][0];
    setContent(
      tabsBar,
      tabs.map(([tabId, label]) =>
        h(
          "button",
          {
            class: `tab ${activeTab === tabId ? "active" : ""}`,
            role: "tab",
            "aria-selected": String(activeTab === tabId),
            onclick: () => selectTab(tabId, false),
          },
          label,
        ),
      ),
    );
  }

  function selectTab(tabId, scroll = true) {
    if (activeTab !== tabId) {
      activeTab = tabId;
      renderTabs();
      renderActiveTab(true);
    }
    if (scroll) tabsBar.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderActiveTab(force) {
    const renderers = {
      conversation: renderConversation,
      timeline: renderTimeline,
      document: renderDocument,
      changes: renderChanges,
      context: renderContext,
      result: renderResult,
      review: renderReview,
      discussion: renderDiscussion,
    };
    renderers[activeTab]?.(force);
  }

  // ---- tabs ------------------------------------------------------------------------------

  function renderContext(force) {
    const context = task.context;
    const signature = JSON.stringify(context ?? null);
    if (!force && signatures.context === signature) return;
    signatures.context = signature;
    const roles = rolesForTask(task).filter((role) => ROLE_SKILLS[role].length);
    const hubSkills = h(
      "div",
      { class: "context-section" },
      h("h3", {}, "Hub best-practice skills"),
      h("p", { class: "muted small" }, "Each agent loads its role's skills; repository instructions and skills take precedence where they differ."),
      h(
        "ul",
        { class: "context-list" },
        roles.map((role) => h("li", {}, roleTag(role), " ", ROLE_SKILLS[role].map((skill) => h("span", { class: "skill-chip" }, skill)))),
      ),
      context?.techSkills?.length
        ? h(
            "p",
            { class: "small" },
            "Technology best practices (for the agents that design, write, review or test code): ",
            context.techSkills.map((skill) => h("span", { class: "skill-chip" }, skill)),
          )
        : null,
    );
    if (!context) {
      setContent(
        tabBody,
        h("div", { class: "card" }, h("p", { class: "muted" }, ACTIVE.includes(task.status) ? "Repository context is discovered when the task starts." : "No repository context was recorded for this task."), hubSkills),
      );
      return;
    }
    const files = (title, items, help) =>
      h(
        "div",
        { class: "context-section" },
        h("h3", {}, title, " ", h("span", { class: "count" }, String(items.length))),
        help ? h("p", { class: "muted small" }, help) : null,
        items.length ? h("ul", { class: "context-list" }, items.map((item) => h("li", { class: "mono small" }, item))) : h("p", { class: "muted small" }, "None found."),
      );
    const empty = !context.instructions.length && !context.guides.length && !context.designDocs.length && !context.skills.length;
    setContent(
      tabBody,
      h(
        "div",
        { class: "card" },
        h("p", { class: "muted small" }, `Discovered at the base commit ${shortSha(task.baseSha)} on ${new Date(context.discoveredAt).toLocaleString()}.`),
        empty ? h("div", { class: "callout callout-info" }, "No repository-specific guidance was found, so the agents follow the code's visible conventions and the hub best-practice skills.") : null,
        files("Instruction files", context.instructions, "Root instruction files are loaded automatically by the Copilot runtime from each agent's worktree; agents are told to read the others (for example AGENTS.md in subfolders)."),
        files("Guides", context.guides, "Agents are asked to read the relevant ones before starting."),
        files("Design docs and ADRs", context.designDocs, "Designers follow their format and prior decisions; coders respect them."),
        h(
          "div",
          { class: "context-section" },
          h("h3", {}, "Repository skills ", h("span", { class: "count" }, String(context.skills.length))),
          h("p", { class: "muted small" }, "Passed to every agent; loaded on demand with the skill tool."),
          context.skills.length
            ? h(
                "ul",
                { class: "context-list" },
                context.skills.map((skill) => h("li", {}, h("span", { class: "skill-chip" }, skill.name), " ", h("span", { class: "muted small" }, skill.description || skill.path))),
              )
            : h("p", { class: "muted small" }, "None found."),
        ),
        h(
          "div",
          { class: "context-section" },
          h("h3", {}, "Build and test commands"),
          context.validation.length ? h("div", { class: "row wrap" }, context.validation.map((command) => h("code", { class: "cmd" }, command))) : h("p", { class: "muted small" }, "None detected; agents look for them in the repository."),
          context.stack.length ? h("p", { class: "muted small" }, `Stack: ${context.stack.join(", ")}`) : null,
        ),
        hubSkills,
      ),
    );
  }

  function renderConversation(force) {
    const signature = JSON.stringify([task.status, task.phase, task.currentRound, task.stages]);
    if (!force && signatures.conversation === signature) return;
    signatures.conversation = signature;
    const stages = task.stages.filter((stage) => stage.rounds.length);
    if (!stages.length) {
      setContent(
        tabBody,
        h(
          "div",
          { class: "empty card muted" },
          ACTIVE.includes(task.status) ? spinner(task.phase === "planning" ? "The manager is planning which agents to create…" : "Agents are starting…") : "No rounds were recorded.",
        ),
      );
      return;
    }
    setContent(
      tabBody,
      stages.map((stage) =>
        h(
          "section",
          { class: "conv-stage" },
          h("h2", { class: "section-title" }, `${STAGE_LABELS[stage.kind]} stage`, " ", chip(...stageStatus(stage))),
          stage.rounds.map((round) => roundCard(stage, round)),
        ),
      ),
    );
  }

  function roundCard(stage, round) {
    const current = ["running", "needs-input"].includes(task.status) && task.currentStage === stage.kind && task.currentRound === round.n;
    const testing = stage.kind === "testing";
    const author = round.author;
    const review = round.review;
    if (review?.by === "user") {
      return h(
        "div",
        { class: "card round-card round-user" },
        h(
          "div",
          { class: "round-head" },
          h("strong", {}, `Round ${round.n}`),
          chip("Your change request", "info"),
          round.attempt > 1 ? chip(`attempt ${round.attempt}`, "outline") : null,
          h("span", { class: "muted small" }, clock(round.startedAt)),
        ),
        h(
          "div",
          { class: "conv-block user-request" },
          h("div", { class: "conv-block-head" }, h("span", { class: "role-tag role-user" }, "You"), h("span", { class: "muted small" }, review.summary)),
          review.comments.map((comment) => commentCard(comment, true)),
        ),
      );
    }
    const authorRole =
      author?.role ??
      (isDocStage(stage.kind) || testing ? AUTHOR_ROLE[stage.kind] : round.n > 1 || (current && task.phase === "revising") ? "resolver" : "coder");
    const reviewerRole = REVIEWER_ROLE[stage.kind];
    const run = review?.testRun;
    return h(
      "div",
      { class: `card round-card ${current ? "current" : ""}` },
      h(
        "div",
        { class: "round-head" },
        h("strong", {}, `Round ${round.n}`),
        testing && !author ? h("span", { class: "muted small" }, round.n > 1 ? "re-run" : "initial run") : null,
        round.attempt > 1 ? chip(`attempt ${round.attempt}`, "outline") : null,
        h("span", { class: "muted small" }, clock(round.startedAt)),
      ),
      author
        ? h(
            "div",
            { class: "conv-block" },
            h(
              "div",
              { class: "conv-block-head" },
              roleTag(authorRole),
              author.commit ? h("span", { class: "mono small" }, `commit ${shortSha(author.commit)}`) : chip("no file changes", "outline"),
              author.branch ? h("span", { class: "mono small muted" }, `on ${author.branch}`) : null,
              author.shortStat ? h("span", { class: "muted small" }, author.shortStat) : null,
              author.fallback ? chip("no structured submission", "warning") : null,
            ),
            renderMarkdown(author.summary),
            author.validation ? h("div", { class: "sub-block" }, h("div", { class: "label" }, "Validation"), h("pre", { class: "pre-wrap" }, author.validation)) : null,
            unitTestsBlock(author.unitTests),
            author.responses?.length
              ? h(
                  "div",
                  { class: "sub-block" },
                  h("div", { class: "label" }, testing ? "Responses to test failures" : "Responses to review comments"),
                  author.responses.map((response) =>
                    h(
                      "div",
                      { class: "response" },
                      h("span", { class: "mono comment-id" }, response.commentId),
                      chip(response.status === "addressed" && testing ? "fixed" : response.status, response.status === "addressed" ? "success" : "warning"),
                      h("span", {}, response.note),
                    ),
                  ),
                )
              : null,
          )
        : current && task.phase !== "reviewing"
          ? h("div", { class: "conv-block" }, spinner(task.phase === "verifying" ? "The manager is running the unit tests before the review…" : `${ROLE_LABELS[authorRole]} is working…`))
          : null,
      review
        ? h(
            "div",
            { class: `conv-block review ${run ? `test-run test-${run.status}` : ""}` },
            h(
              "div",
              { class: "conv-block-head" },
              roleTag(reviewerRole),
              run
                ? chip(...(TEST_STATUS[run.status] ?? [run.status, "neutral"]))
                : review.verdict === "approve"
                  ? chip("Approved", "success")
                  : chip("Changes requested", "warning"),
              run ? h("span", { class: "small" }, testCounts(run)) : null,
              review.reviewedSha ? h("span", { class: "mono small muted" }, `${run ? "tested" : "reviewed"} ${shortSha(review.reviewedSha)}`) : null,
              review.fallback ? chip(run ? "no structured results" : "no structured review", "warning") : null,
            ),
            renderMarkdown(review.summary),
            run?.commands.length
              ? h("div", { class: "sub-block" }, h("div", { class: "label" }, "Commands run"), h("pre", { class: "pre-wrap test-commands" }, run.commands.join("\n")))
              : null,
            run?.logExcerpt ? h("details", { class: "sub-block" }, h("summary", { class: "label" }, "Output excerpt"), h("pre", { class: "pre-wrap" }, run.logExcerpt)) : null,
            unrelatedFailuresBlock(run?.unrelatedFailures),
            review.comments.length && run ? h("div", { class: "label sub-block" }, `Failures (${review.comments.length})`) : null,
            review.comments.map((comment) => commentCard(comment)),
          )
        : current && (author || testing) && task.phase === "reviewing"
          ? h("div", { class: "conv-block review" }, spinner(testing ? `${ROLE_LABELS[reviewerRole]} is running the tests…` : `${ROLE_LABELS[reviewerRole]} is reviewing…`))
          : null,
    );
  }

  /** A coding round's unit tests: what the author reported and whether the manager's own run passed. */
  function unitTestsBlock(check) {
    if (!check) return null;
    const [label, cls] = UNIT_TEST_STATUS[check.status] ?? [check.status, "neutral"];
    return h(
      "div",
      { class: "sub-block" },
      h("div", { class: "label" }, "Unit tests"),
      h(
        "div",
        { class: "row wrap small" },
        chip(label, cls),
        check.verified ? h("span", { class: "muted" }, "re-run by the manager before the review") : null,
        check.total !== undefined ? h("span", {}, testCounts(check)) : null,
        check.fixAttempts ? h("span", { class: "muted" }, `${check.fixAttempts} fix attempt(s) after failing runs`) : null,
        check.flaky?.length ? chip("flaky", "warning") : null,
      ),
      check.flaky?.length ? h("p", { class: "small muted" }, `Failed once, passed when the manager ran it again: ${check.flaky.join(", ")}`) : null,
      check.reason ? h("p", { class: "small" }, check.reason) : null,
      check.commands?.length ? h("pre", { class: "pre-wrap test-commands" }, check.commands.join("\n")) : null,
      check.logExcerpt ? h("details", {}, h("summary", { class: "label" }, "Output of the failing run"), h("pre", { class: "pre-wrap" }, check.logExcerpt)) : null,
      unrelatedFailuresBlock(check.unrelatedFailures),
    );
  }

  function commentCard(comment, fromUser = false) {
    const statusChip =
      comment.status === "addressed"
        ? chip(comment.test ? "Fix submitted" : fromUser ? "Done" : "Addressed", "success")
        : comment.status === "declined"
          ? chip("Declined", "warning")
          : chip("Open", "neutral");
    return h(
      "div",
      { class: `comment ${fromUser ? "comment-user" : `sev-${comment.severity}`}` },
      h(
        "div",
        { class: "comment-head" },
        h("span", { class: "mono comment-id" }, comment.id),
        comment.test
          ? chip(comment.category ?? "unknown", CATEGORY_CLASS[comment.category] ?? "neutral")
          : fromUser
            ? chip("change request", "info")
            : chip(comment.severity, SEVERITY_CLASS[comment.severity] ?? "neutral"),
        comment.test ? h("strong", { class: "small break" }, comment.test) : null,
        comment.file ? h("span", { class: "mono small" }, comment.line ? `${comment.file}:${comment.line}` : comment.file) : null,
        h("span", { class: "spacer" }),
        statusChip,
      ),
      renderMarkdown(comment.body),
      comment.response ? h("div", { class: "comment-response" }, h("span", { class: "muted" }, fromUser ? "↳ Agent's response: " : "↳ Resolution: "), comment.response) : null,
    );
  }

  // ---- Code review: the summary of the change, the comments to curate, and publishing ---------------

  const SEVERITY_TITLES = { blocker: "Blocker", major: "Major", minor: "Minor", nit: "Nit" };
  /** The comment text as published on the pull request (mirrors the server's formatComment). */
  const publishedText = (comment) => `**${SEVERITY_TITLES[comment.severity]}:** ${comment.body.trim()}`;

  function renderReview(force) {
    if (activeTab !== "review") return;
    const review = task.review;
    const signature = JSON.stringify([
      task.status,
      review?.final,
      review?.curated,
      review?.body,
      review?.event,
      review?.publications,
      review?.lastPublish,
      [...commentDrafts.keys()],
      showDropped,
      publishInfo,
      reviewBusy,
    ]);
    if (!force && signatures.review === signature) return;
    signatures.review = signature;
    if (!review?.curated || !review.final) {
      setContent(
        tabBody,
        h(
          "div",
          { class: "empty card muted" },
          ACTIVE.includes(task.status)
            ? spinner(task.status === "queued" ? "Waiting to start…" : "The reviewers are at work. Their comments appear here once they agree on the final review; follow them in the Discussion tab.")
            : "The review did not finish. Retry resumes it from the last completed step.",
        ),
      );
      return;
    }
    refreshPublishInfo();
    const final = review.final;
    const curated = review.curated;
    const kept = curated.filter((comment) => comment.decision === "keep");
    const files = review.files ?? [];
    const summaryCard = h(
      "section",
      { class: "card review-summary" },
      h("h3", {}, "Summary of the change"),
      h(
        "div",
        { class: "row wrap small" },
        reviewTargetLabel(review.target),
        review.shortStat ? h("span", { class: "muted" }, `· ${review.shortStat}`) : null,
        review.commits ? h("span", { class: "muted" }, `· ${review.commits} commit(s)`) : null,
      ),
      final.changeSummary ? renderMarkdown(final.changeSummary) : h("p", { class: "muted" }, "The reviewers gave no summary."),
      files.length
        ? h(
            "details",
            { class: "sub-block" },
            h("summary", { class: "label" }, `Files changed (${files.length})`),
            h(
              "table",
              { class: "file-table" },
              h(
                "tbody",
                {},
                files.map((file) =>
                  h(
                    "tr",
                    {},
                    h("td", { class: "mono small break" }, file.path),
                    h("td", { class: "num add" }, file.additions === null ? "bin" : `+${file.additions}`),
                    h("td", { class: "num del" }, file.deletions === null ? "" : `−${file.deletions}`),
                  ),
                ),
              ),
            ),
          )
        : null,
      h("div", { class: "label sub-block" }, `Reviewers' assessment · verdict: ${final.verdict === "approve" ? "approve" : "request changes"}`),
      renderMarkdown(final.assessment),
      review.signoff
        ? review.signoff.agreed
          ? h("div", { class: "callout callout-success small" }, h("strong", {}, "Both reviewers agree on this review. "), review.signoff.summary)
          : h(
              "div",
              { class: "callout callout-warning small" },
              h("strong", {}, review.signoff.fallback ? "The peer reviewer did not sign off. " : "The peer reviewer still objects: "),
              review.signoff.summary,
              review.signoff.objections.length ? h("div", { class: "muted" }, "Its objections are shown on the comments they concern; you decide.") : null,
            )
        : null,
    );
    const commentsSection = h(
      "section",
      { class: "review-comments" },
      h(
        "div",
        { class: "row between wrap" },
        h("h2", { class: "section-title" }, `Comments · keeping ${kept.length} of ${curated.length}`),
        h("div", { class: "row wrap" }, severityChips(kept)),
      ),
      h("p", { class: "muted small" }, "Keep, drop or edit each comment. Publishing posts the comments as they are now; after publishing, edits and drops are applied to the pull request the next time you publish."),
      curated.length ? curated.map(curatedCard) : h("div", { class: "empty card muted" }, "The reviewers found nothing to comment on."),
    );
    setContent(tabBody, summaryCard, commentsSection, leftOutSection(), publishCard());
  }

  function sourcesLabel(sources) {
    const lead = sources.some((id) => id.startsWith("L"));
    const peer = sources.some((id) => id.startsWith("P"));
    if (lead && peer) return "found by both reviewers";
    if (lead) return "lead reviewer";
    if (peer) return "peer reviewer";
    return "added in the final review";
  }

  function curatedStatus(comment) {
    if (comment.decision === "drop") return comment.published?.inline ? ["Dropped · deleted from the PR on publish", "danger"] : ["Dropped", "neutral"];
    if (comment.published) return comment.published.body !== publishedText(comment) ? ["Edited since publishing", "warning"] : ["Published", "success"];
    return comment.original ? ["Edited · keep", "info"] : ["Keep", "success"];
  }

  /** One comment of the final review, with keep/drop and edit controls. */
  function curatedCard(comment) {
    const draft = commentDrafts.get(comment.id);
    const dropped = comment.decision === "drop";
    const location = comment.file ? (comment.line ? `${comment.file}:${comment.line}` : comment.file) : null;
    const head = h(
      "div",
      { class: "comment-head" },
      h("span", { class: "mono comment-id" }, comment.id),
      chip(comment.severity, SEVERITY_CLASS[comment.severity] ?? "neutral"),
      location ? h("span", { class: "mono small break" }, location) : h("span", { class: "muted small" }, "general"),
      chip(sourcesLabel(comment.sources), "outline", comment.sources.length ? `Reviewer comments: ${comment.sources.join(", ")}` : undefined),
      comment.addedByUser ? chip("added by you", "info") : null,
      h("span", { class: "spacer" }),
      chip(...curatedStatus(comment)),
    );
    if (draft) {
      const severity = h(
        "select",
        { class: "input input-inline", onchange: () => (draft.severity = severity.value) },
        SEVERITY_ORDER.map((value) => h("option", { value, selected: value === draft.severity }, value)),
      );
      const text = h("textarea", { class: "input", rows: String(Math.min(16, Math.max(4, draft.body.split("\n").length + 1))), value: draft.body, oninput: () => (draft.body = text.value) });
      return h(
        "div",
        { class: `comment review-comment sev-${comment.severity} editing` },
        head,
        h("div", { class: "row small" }, h("span", { class: "muted" }, "Severity"), severity),
        text,
        h(
          "div",
          { class: "row end" },
          h("button", { class: "btn btn-sm", disabled: reviewBusy, onclick: () => cancelEdit(comment.id) }, "Cancel"),
          h("button", { class: "btn btn-sm btn-primary", disabled: reviewBusy, onclick: () => saveEdit(comment.id) }, "Save"),
        ),
      );
    }
    const decision = (value, label) =>
      h(
        "button",
        {
          class: `seg-item ${comment.decision === value ? "active" : ""}`,
          disabled: reviewBusy,
          "aria-pressed": String(comment.decision === value),
          onclick: () => comment.decision !== value && reviewRequest(() => patch(commentUrl(comment.id), { decision: value })),
        },
        label,
      );
    return h(
      "div",
      { class: `comment review-comment sev-${comment.severity} ${dropped ? "is-dropped" : ""}` },
      head,
      renderMarkdown(comment.body),
      comment.objection ? h("div", { class: "callout callout-warning small" }, h("strong", {}, "Peer reviewer objects: "), comment.objection) : null,
      comment.original
        ? h("details", { class: "sub-block" }, h("summary", { class: "label" }, `The reviewers' version (${comment.original.severity})`), renderMarkdown(comment.original.body))
        : null,
      h(
        "div",
        { class: "row wrap comment-actions" },
        h("div", { class: "seg seg-sm", role: "group", "aria-label": `Keep or drop ${comment.id}` }, decision("keep", "Keep"), decision("drop", "Drop")),
        h("button", { class: "btn btn-sm", disabled: reviewBusy, onclick: () => startEdit(comment) }, "✎ Update"),
        comment.original ? h("button", { class: "btn btn-sm btn-ghost", disabled: reviewBusy, onclick: () => reviewRequest(() => patch(commentUrl(comment.id), { revert: true })) }, "Undo edit") : null,
        h("span", { class: "spacer" }),
        comment.published
          ? comment.published.inline
            ? comment.published.url
              ? h("a", { class: "small", href: comment.published.url, target: "_blank", rel: "noopener noreferrer" }, "On the pull request ↗")
              : h("span", { class: "muted small" }, "inline on the pull request")
            : h("span", { class: "muted small" }, "in the review's text")
          : null,
      ),
    );
  }

  const commentUrl = (commentId) => `/api/tasks/${encodeURIComponent(task.id)}/review/comments/${encodeURIComponent(commentId)}`;

  function startEdit(comment) {
    commentDrafts.set(comment.id, { body: comment.body, severity: comment.severity });
    renderReview(true);
  }

  function cancelEdit(commentId) {
    commentDrafts.delete(commentId);
    renderReview(true);
  }

  async function saveEdit(commentId) {
    const draft = commentDrafts.get(commentId);
    if (!draft) return;
    if (!draft.body.trim()) {
      toast("A comment needs text; drop it instead", "error");
      return;
    }
    if (await reviewRequest(() => patch(commentUrl(commentId), { body: draft.body, severity: draft.severity }))) {
      commentDrafts.delete(commentId);
      renderReview(true);
    }
  }

  /** Runs a review edit; the response (and the live stream) carry the updated task. */
  async function reviewRequest(call, success) {
    reviewBusy = true;
    renderReview(true);
    try {
      const result = await call();
      const updated = result?.task ?? (result?.id === task.id ? result : null);
      if (updated) {
        task = updated;
        renderAll();
      }
      if (success) success(result);
      return true;
    } catch (error) {
      toast(error.message, "error");
      return false;
    } finally {
      reviewBusy = false;
      renderReview(true);
    }
  }

  /** Reviewer comments the final review leaves out (dropped, withdrawn or disputed), each one can be put back. */
  function leftOutSection() {
    const review = task.review;
    const curated = review.curated ?? [];
    const covered = new Set(curated.flatMap((comment) => comment.sources));
    const leftOut = review.comments.filter((comment) => !covered.has(comment.id));
    if (!leftOut.length) return null;
    const objections = review.signoff && !review.signoff.agreed ? review.signoff.objections : [];
    const disputed = leftOut.filter((comment) => objections.some((objection) => objection.commentId === comment.id)).length;
    return h(
      "details",
      { class: "card left-out", open: showDropped || disputed > 0, ontoggle: (event) => (showDropped = event.target.open) },
      h("summary", {}, `Left out of the final review (${leftOut.length})${disputed ? ` · the peer reviewer wants ${disputed} back` : ""}`),
      h("p", { class: "muted small" }, "Comments a reviewer raised that the final review does not include. Add one back if you think it belongs in the review."),
      leftOut.map((comment) => {
        const reason = comment.withdrawn
          ? `Withdrawn by the ${comment.id.startsWith("L") ? "lead" : "peer"} reviewer: ${comment.withdrawn.note}`
          : (review.final?.dropped.find((entry) => entry.commentId === comment.id)?.reason ?? "Not included in the final review.");
        const objection = objections.filter((entry) => entry.commentId === comment.id).map((entry) => entry.issue).join(" ");
        return h(
          "div",
          { class: `comment sev-${comment.severity} is-dropped` },
          h(
            "div",
            { class: "comment-head" },
            h("span", { class: "mono comment-id" }, comment.id),
            chip(comment.severity, SEVERITY_CLASS[comment.severity] ?? "neutral"),
            comment.file ? h("span", { class: "mono small break" }, comment.line ? `${comment.file}:${comment.line}` : comment.file) : null,
            chip(comment.id.startsWith("L") ? "lead reviewer" : "peer reviewer", "outline"),
            h("span", { class: "spacer" }),
            h(
              "button",
              { class: "btn btn-xs", disabled: reviewBusy, onclick: () => reviewRequest(() => post(`/api/tasks/${encodeURIComponent(task.id)}/review/comments`, { from: comment.id })) },
              "+ Add to review",
            ),
          ),
          renderMarkdown(comment.body),
          h("div", { class: "muted small" }, reason),
          objection ? h("div", { class: "callout callout-warning small" }, h("strong", {}, "Peer reviewer objects to leaving it out: "), objection) : null,
        );
      }),
    );
  }

  function refreshPublishInfo() {
    const review = task.review;
    const key = JSON.stringify([task.id, review?.curated, review?.body, review?.publications]);
    if (publishInfoKey === key) return;
    publishInfoKey = key;
    get(`/api/tasks/${encodeURIComponent(task.id)}/review/publish`)
      .catch((error) => ({ available: false, reason: error.message, pending: null, inline: 0, inBody: 0, pullRequest: null }))
      .then((info) => {
        if (disposed || publishInfoKey !== key) return;
        publishInfo = info;
        if (activeTab === "review") renderReview(false);
      });
  }

  /** The review text, the kind of review, and the Publish / Copy as Markdown actions. */
  function publishCard() {
    const review = task.review;
    const pr = review.target.pullRequest;
    const main = review.publications?.find((publication) => publication.main);
    const info = publishInfo;
    const prName = pr ? `${pr.provider === "gitlab" ? "merge request !" : "pull request #"}${pr.number}` : "the pull request";
    const publishButton = h("button", { class: "btn btn-primary", onclick: publishComments });
    // Typing in the review text must not re-render (and lose focus), so the controls it affects update in place.
    const updatePublishButton = () => {
      const pending = info?.pending ?? null;
      const upToDate = Boolean(main) && pending === 0 && bodyDraft === null;
      const blocked = !info
        ? "Checking where the review can be published…"
        : !info.available
          ? info.reason
          : commentDrafts.size
            ? "Save or cancel the comment you are editing first"
            : upToDate
              ? "Nothing new to publish"
              : null;
      publishButton.disabled = Boolean(blocked) || reviewBusy;
      publishButton.title = blocked ?? "";
      publishButton.textContent = reviewBusy
        ? "Working…"
        : main
          ? upToDate
            ? "✓ Pull request is up to date"
            : `Publish updates${pending ? ` (${pending})` : ""}`
          : `Publish comments to ${prName}`;
    };
    const saveRow = h(
      "div",
      { class: "row end", hidden: bodyDraft === null },
      h("button", { class: "btn btn-sm", disabled: reviewBusy, onclick: () => ((bodyDraft = null), renderReview(true)) }, "Discard"),
      h("button", { class: "btn btn-sm btn-primary", disabled: reviewBusy, onclick: saveReviewText }, "Save text"),
    );
    const text = h("textarea", {
      class: "input",
      rows: "6",
      value: bodyDraft ?? review.body ?? "",
      oninput: () => {
        bodyDraft = text.value;
        saveRow.hidden = false;
        updatePublishButton();
      },
    });
    const event = h(
      "select",
      {
        class: "input input-inline",
        disabled: Boolean(main) || reviewBusy,
        title: main ? "The review was published; its kind cannot change any more" : "How the review is submitted on the pull request",
        onchange: () => reviewRequest(() => put(`/api/tasks/${encodeURIComponent(task.id)}/review/summary`, { event: event.value })),
      },
      Object.entries(REVIEW_EVENT_LABELS).map(([value, label]) => h("option", { value, selected: (review.event ?? "COMMENT") === value }, label)),
    );
    updatePublishButton();
    const pending = info?.pending ?? null;
    const status = info
      ? info.available
        ? h(
            "div",
            { class: "muted small" },
            `Publishes on ${prName}: ${info.inline} inline comment(s)${info.inBody ? `, ${info.inBody} in the review's text (not on a changed line)` : ""}.`,
            main && pending ? ` ${pending} change(s) are not on the pull request yet.` : "",
          )
        : h("div", { class: "callout callout-info small" }, info.reason)
      : spinner("Checking the pull request…");
    return h(
      "section",
      { class: "card publish-card" },
      h("h3", {}, "Publish"),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Review text (posted with the comments)"), text, saveRow),
      h("div", { class: "row wrap" }, h("span", { class: "field-label" }, "Submit as"), event, h("span", { class: "muted small" }, "GitHub does not let you approve or request changes on your own pull request.")),
      status,
      h(
        "div",
        { class: "row wrap" },
        publishButton,
        h("button", { class: "btn", onclick: copyReviewMarkdown }, "Copy as Markdown"),
        main?.url ? h("a", { class: "btn btn-ghost", href: main.url, target: "_blank", rel: "noopener noreferrer" }, "View the review ↗") : null,
      ),
      review.lastPublish
        ? h(
            "div",
            { class: `callout small ${review.lastPublish.ok ? "callout-success" : "callout-danger"}` },
            h("strong", {}, `${relTime(review.lastPublish.at)}: `),
            review.lastPublish.message,
          )
        : null,
    );
  }

  async function saveReviewText() {
    const body = bodyDraft;
    if (body === null) return;
    if (await reviewRequest(() => put(`/api/tasks/${encodeURIComponent(task.id)}/review/summary`, { body }))) {
      bodyDraft = null;
      renderReview(true);
    }
  }

  async function publishComments() {
    if (bodyDraft !== null) {
      const body = bodyDraft;
      if (!(await reviewRequest(() => put(`/api/tasks/${encodeURIComponent(task.id)}/review/summary`, { body })))) return;
      bodyDraft = null;
    }
    const main = task.review?.publications?.find((publication) => publication.main);
    const kept = (task.review?.curated ?? []).filter((comment) => comment.decision === "keep").length;
    if (!main) {
      const confirmed = await confirmDialog({
        title: "Publish the review?",
        body: h(
          "div",
          {},
          h("p", {}, `Posts the review text and ${kept} comment(s) on the pull request as ${REVIEW_EVENT_LABELS[task.review?.event ?? "COMMENT"]}.`),
          h("p", { class: "muted small" }, "Later edits, drops and comments you add are applied to the pull request when you publish again."),
        ),
        confirmText: "Publish",
      });
      if (!confirmed) return;
    }
    await reviewRequest(
      () => post(`/api/tasks/${encodeURIComponent(task.id)}/review/publish`, {}),
      (result) => toast(result.message, result.ok ? "success" : "error"),
    );
  }

  async function copyReviewMarkdown() {
    try {
      const { markdown } = await get(`/api/tasks/${encodeURIComponent(task.id)}/review/markdown`);
      await copyText(markdown);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  /** The reviewers' discussion, round by round: independent findings, positions, final review and sign-off. */
  function renderDiscussion(force) {
    const review = task.review;
    const signature = JSON.stringify([task.status, task.phase, task.currentRound, review?.rounds, review?.comments]);
    if (!force && signatures.discussion === signature) return;
    signatures.discussion = signature;
    const rounds = review?.rounds ?? [];
    if (!rounds.length) {
      setContent(tabBody, h("div", { class: "empty card muted" }, ACTIVE.includes(task.status) ? spinner("The reviewers are starting…") : "No discussion was recorded."));
      return;
    }
    const running = ["running", "needs-input"].includes(task.status);
    const byId = new Map(review.comments.map((comment) => [comment.id, comment]));
    const reviewerComment = (comment) =>
      h(
        "div",
        { class: `comment sev-${comment.severity} ${comment.withdrawn ? "is-dropped" : ""}` },
        h(
          "div",
          { class: "comment-head" },
          h("span", { class: "mono comment-id" }, comment.id),
          chip(comment.severity, SEVERITY_CLASS[comment.severity] ?? "neutral"),
          comment.file ? h("span", { class: "mono small break" }, comment.line ? `${comment.file}:${comment.line}` : comment.file) : null,
          h("span", { class: "spacer" }),
          comment.withdrawn ? chip(`withdrawn in round ${comment.withdrawn.round}`, "neutral") : comment.revised ? chip(`revised in round ${comment.revised.round}`, "info") : null,
        ),
        renderMarkdown(comment.body),
        comment.withdrawn ? h("div", { class: "muted small" }, `Withdrawn: ${comment.withdrawn.note}`) : null,
        comment.revised ? h("div", { class: "muted small" }, `Revised: ${comment.revised.note}`) : null,
      );
    const entryBlock = (round, entry) => {
      const parts = [];
      if (round.phase === "findings") {
        parts.push(
          h("div", { class: "row wrap small" }, chip(entry.verdict === "approve" ? "approve" : "request changes", entry.verdict === "approve" ? "success" : "warning"), `${entry.comments?.length ?? 0} comment(s)`),
          entry.changeSummary ? h("details", { class: "sub-block" }, h("summary", { class: "label" }, "What the change does"), renderMarkdown(entry.changeSummary)) : null,
          renderMarkdown(entry.summary),
          (entry.comments ?? []).map((commentId) => byId.get(commentId)).filter(Boolean).map(reviewerComment),
        );
      } else if (round.phase === "positions") {
        parts.push(renderMarkdown(entry.summary));
        for (const position of entry.positions ?? []) {
          parts.push(
            h(
              "div",
              { class: "response" },
              h("span", { class: "mono comment-id" }, position.commentId),
              chip(position.position, POSITION_CLASS[position.position] ?? "neutral"),
              h("span", {}, position.note),
              position.suggestedSeverity ? chip(`→ ${position.suggestedSeverity}`, "outline") : null,
            ),
            position.suggestedBody ? h("details", { class: "sub-block" }, h("summary", { class: "label" }, `Suggested text for ${position.commentId}`), renderMarkdown(position.suggestedBody)) : null,
          );
        }
        for (const update of entry.updates ?? []) {
          parts.push(h("div", { class: "response" }, h("span", { class: "mono comment-id" }, update.commentId), chip(update.action === "withdraw" ? "withdrew own" : "revised own", "neutral"), h("span", {}, update.note)));
        }
        const added = (entry.comments ?? []).map((commentId) => byId.get(commentId)).filter(Boolean);
        if (added.length) parts.push(h("div", { class: "label sub-block" }, `New comments (${added.length})`), added.map(reviewerComment));
      } else if (round.phase === "final" && entry.final) {
        const final = entry.final;
        parts.push(
          h("div", { class: "row wrap small" }, chip(final.verdict === "approve" ? "approve" : "request changes", final.verdict === "approve" ? "success" : "warning"), `${final.comments.length} comment(s), ${final.dropped.length} dropped`, final.fallback ? chip("assembled by the hub", "warning") : null),
          renderMarkdown(final.assessment),
        );
        if (final.objectionResponses?.length) {
          parts.push(h("div", { class: "label sub-block" }, "Answers to the peer reviewer's objections"), final.objectionResponses.map((answer) => h("div", { class: "response" }, h("span", { class: "muted" }, answer.objection), h("span", {}, `→ ${answer.response}`))));
        }
        parts.push(
          final.comments.map((comment) =>
            h(
              "div",
              { class: `comment sev-${comment.severity}` },
              h(
                "div",
                { class: "comment-head" },
                h("span", { class: "mono comment-id" }, comment.id),
                chip(comment.severity, SEVERITY_CLASS[comment.severity] ?? "neutral"),
                comment.file ? h("span", { class: "mono small break" }, comment.line ? `${comment.file}:${comment.line}` : comment.file) : null,
                h("span", { class: "spacer" }),
                h("span", { class: "muted small" }, comment.sources.length ? `from ${comment.sources.join(", ")}` : "new"),
              ),
              renderMarkdown(comment.body),
            ),
          ),
          final.dropped.length
            ? h(
                "details",
                { class: "sub-block" },
                h("summary", { class: "label" }, `Dropped (${final.dropped.length})`),
                final.dropped.map((entryDropped) => h("div", { class: "response" }, h("span", { class: "mono comment-id" }, entryDropped.commentId), h("span", {}, entryDropped.reason))),
              )
            : null,
        );
      } else if (round.phase === "signoff" && entry.signoff) {
        const signoff = entry.signoff;
        parts.push(
          h("div", { class: "row wrap small" }, signoff.agreed ? chip("agrees", "success") : chip(signoff.fallback ? "no sign-off" : "objects", "warning")),
          renderMarkdown(signoff.summary),
          signoff.objections.map((objection) => h("div", { class: "response" }, objection.commentId ? h("span", { class: "mono comment-id" }, objection.commentId) : chip("whole review", "outline"), h("span", {}, objection.issue))),
        );
      }
      return h(
        "div",
        { class: "conv-block" },
        h("div", { class: "conv-block-head" }, roleTag(entry.role), h("span", { class: "muted small" }, clock(entry.at)), entry.fallback ? chip("no structured submission", "warning") : null),
        parts,
      );
    };
    setContent(
      tabBody,
      rounds.map((round) => {
        const expected = round.phase === "findings" || round.phase === "positions" ? ["lead-reviewer", "peer-reviewer"] : round.phase === "final" ? ["lead-reviewer"] : ["peer-reviewer"];
        const waiting = expected.filter((role) => !round.entries.some((entry) => entry.role === role));
        return h(
          "div",
          { class: `card round-card ${running && task.currentRound === round.n ? "current" : ""}` },
          h(
            "div",
            { class: "round-head" },
            h("strong", {}, `Round ${round.n} · ${REVIEW_PHASE_TITLES[round.phase]}`),
            round.attempt > 1 ? chip(`attempt ${round.attempt}`, "outline") : null,
            h("span", { class: "muted small" }, clock(round.startedAt)),
          ),
          round.entries.map((entry) => entryBlock(round, entry)),
          running && task.currentRound === round.n
            ? waiting.map((role) => h("div", { class: "conv-block" }, spinner(`${ROLE_LABELS[role]} is working…`)))
            : null,
        );
      }),
    );
  }

  function renderTimeline(force) {
    if (!force && signatures.timelineRendered) return;
    signatures.timelineRendered = true;
    toolRows.clear();
    const toggle = h("input", {
      type: "checkbox",
      checked: showTools,
      onchange: () => {
        showTools = toggle.checked;
        renderTimeline(true);
      },
    });
    setContent(timelineList, events.filter((event) => event.type !== "tool.done" && (showTools || event.type !== "tool.start")).map(eventRow));
    setContent(
      tabBody,
      h("div", { class: "row between" }, h("span", { class: "muted small" }, `${events.length} events`), h("label", { class: "row small" }, toggle, "Show tool calls")),
      h("div", { class: "card" }, timelineList),
    );
  }

  function eventRow(event) {
    let body;
    if (event.type === "agent.message") {
      const first = event.text.split("\n").find((line) => line.trim()) ?? "";
      body = h("details", { class: "ev-details" }, h("summary", {}, first.slice(0, 160)), renderMarkdown(event.text));
    } else if (event.type === "submission") {
      body = h("details", { class: "ev-details" }, h("summary", {}, "Submitted work for review"), renderMarkdown(event.text));
    } else if (event.type === "tool.start") {
      const statusEl = h("span", { class: "tool-status" });
      toolRows.set(event.data?.toolCallId, statusEl);
      body = h("span", { class: "ev-tool" }, statusEl, h("span", { class: "mono" }, event.text), event.data?.subAgent ? chip("sub-agent", "outline") : null);
    } else {
      body = h("span", { class: "ev-text" }, event.text);
    }
    const row = h(
      "div",
      { class: `ev ev-${event.type.replace(".", "-")}` },
      h("span", { class: "ev-time mono" }, clock(event.ts)),
      h("span", { class: "ev-icon", "aria-hidden": "true" }, EVENT_ICONS[event.type] ?? "·"),
      event.role ? roleTag(event.role) : null,
      body,
    );
    if (event.type === "tool.start") updateToolRow(event.data?.toolCallId);
    return row;
  }

  function updateToolRow(toolCallId) {
    const el = toolRows.get(toolCallId);
    if (!el) return;
    const status = toolStatus.get(toolCallId);
    el.className = `tool-status ${status ? (status.success ? "ok" : "fail") : "run"}`;
    el.textContent = status ? (status.success ? "✓" : "✕") : "…";
    el.title = status && !status.success ? status.error || "failed" : "";
  }

  /** The Documents tab: every document the task wrote (a list when there are several) and the selected one, version by version. */
  async function renderDocument(force) {
    const documents = documentsOfTask();
    const selectedDoc = documents.find((doc) => doc.path === docPath) ?? documents[0];
    const signature = JSON.stringify([documents.map((doc) => [doc.path, doc.versions, doc.stage.status]), selectedDoc?.path, docRound, docMode]);
    if (!force && signatures.document === signature) return;
    signatures.document = signature;
    docFrame = null;
    const firstStage = task.stages.find((candidate) => isDocStage(candidate.kind));
    const author = ROLE_LABELS[AUTHOR_ROLE[firstStage?.kind ?? "design"]].toLowerCase();
    if (!selectedDoc) {
      setContent(tabBody, h("div", { class: "empty card muted" }, ACTIVE.includes(task.status) ? spinner(`The ${author} is writing the first draft…`) : "No document was submitted."));
      return;
    }
    const stage = selectedDoc.stage;
    const versions = selectedDoc.versions;
    const selected = docRound && versions.includes(docRound) ? docRound : versions.at(-1);
    const latest = versions.at(-1);
    const final = stage.status === "approved" || stage.status === "not-approved";
    const format = selectedDoc.format;
    const query = `round=${selected}&path=${encodeURIComponent(selectedDoc.path)}`;
    const viewUrl = `/api/tasks/${encodeURIComponent(task.id)}/doc/view?${query}`;
    const modeButton = (mode, label) =>
      h(
        "button",
        {
          class: `seg-item ${docMode === mode ? "active" : ""}`,
          onclick: () => {
            docMode = mode;
            renderDocument(true);
          },
        },
        label,
      );
    const content = h("div", { class: `doc-host ${format === "html" && docMode === "rendered" ? "doc-host-frame" : "card doc"}` });
    const toolbar = h(
      "div",
      { class: "row between wrap doc-toolbar" },
      h(
        "div",
        { class: "row wrap" },
        h(
          "div",
          { class: "seg" },
          versions.map((n) =>
            h(
              "button",
              {
                class: `seg-item ${n === selected ? "active" : ""}`,
                title: `Version written in round ${n}`,
                onclick: () => {
                  docRound = n;
                  renderDocument(true);
                },
              },
              n === latest && final ? `v${n} · final` : `v${n}`,
            ),
          ),
        ),
        format === "html" ? h("div", { class: "seg" }, modeButton("rendered", "Rendered"), modeButton("source", "HTML source")) : null,
      ),
      h(
        "div",
        { class: "row" },
        h("span", { class: "mono small" }, selectedDoc.path),
        stage.status === "approved" && selected === latest ? chip("Approved", "success") : selected === latest && final ? chip("Final (not approved)", "warning") : chip("Draft", "neutral"),
        h("a", { class: "btn btn-xs", href: viewUrl, target: "_blank", rel: "noopener noreferrer", title: "Open the document in a new tab" }, "Open ↗"),
      ),
    );
    const list =
      documents.length > 1
        ? h(
            "nav",
            { class: "doc-list card", "aria-label": "Documents" },
            h("div", { class: "label" }, `Documents (${documents.length})`),
            documents.map((doc) =>
              h(
                "button",
                {
                  class: `doc-item ${doc === selectedDoc ? "active" : ""}`,
                  "aria-current": doc === selectedDoc ? "true" : undefined,
                  title: doc.path,
                  onclick: () => {
                    docPath = doc.path;
                    docRound = null;
                    renderDocument(true);
                  },
                },
                h("span", { class: "doc-item-name" }, doc.path.split("/").at(-1)),
                h("span", { class: "mono small muted doc-item-path" }, doc.path),
                h(
                  "span",
                  { class: "row small" },
                  chip(doc.stage.kind === "design" ? "Design" : "Document", "outline"),
                  doc.primary ? chip("main", "info") : null,
                  h("span", { class: "muted" }, `${doc.versions.length} version${doc.versions.length === 1 ? "" : "s"}`),
                ),
              ),
            ),
          )
        : null;
    setContent(tabBody, list ? h("div", { class: "doc-layout" }, list, h("div", { class: "doc-main" }, toolbar, content)) : [toolbar, content]);
    if (format === "html" && docMode === "rendered") {
      // Sandboxed (no same-origin): the document's scripts cannot reach the hub UI or its API.
      docFrame = h("iframe", {
        class: "doc-frame",
        sandbox: "allow-scripts allow-popups",
        referrerpolicy: "no-referrer",
        title: `${selectedDoc.path} (version ${selected})`,
        height: "720",
        src: viewUrl,
      });
      setContent(content, docFrame);
      return;
    }
    setContent(content, spinner("Loading document…"));
    try {
      const doc = await get(`/api/tasks/${encodeURIComponent(task.id)}/doc?${query}`);
      if (!doc.content) setContent(content, h("div", { class: "muted" }, "Document not available."));
      else if (format === "html") setContent(content, h("div", { class: "code-block" }, h("pre", { class: "doc-source" }, doc.content), copyButton(doc.content, "Copy HTML")));
      else setContent(content, renderMarkdown(doc.content));
    } catch (error) {
      setContent(content, h("div", { class: "callout callout-danger" }, error.message));
    }
  }

  async function renderChanges(force) {
    const ranges = [{ key: "all", label: isCodeReviewTask(task) ? "The change under review (merge-base → head)" : "All changes (base → branch)", from: "", to: "" }];
    for (const stage of task.stages) {
      for (const round of stage.rounds) {
        if (round.author?.commit) {
          ranges.push({
            key: round.author.commit,
            label: `${STAGE_LABELS[stage.kind]} round ${round.n} (${shortSha(round.author.commit)})`,
            from: round.author.prevCommit ?? "",
            to: round.author.commit,
          });
        }
      }
    }
    const signature = JSON.stringify([ranges.map((range) => range.key), diffSelection]);
    if (!force && signatures.changes === signature) return;
    signatures.changes = signature;
    if (!task.branch) {
      setContent(tabBody, h("div", { class: "empty card muted" }, "No changes yet."));
      return;
    }
    const selected = ranges.find((range) => range.key === diffSelection) ?? ranges[0];
    const select = h(
      "select",
      {
        class: "input input-inline",
        onchange: () => {
          diffSelection = select.value;
          renderChanges(true);
        },
      },
      ranges.map((range) => h("option", { value: range.key, selected: range.key === selected.key }, range.label)),
    );
    const content = h("div", {}, spinner("Loading diff…"));
    setContent(
      tabBody,
      h("div", { class: "row between wrap" }, select, h("button", { class: "btn btn-sm", onclick: () => renderChanges(true) }, "Refresh")),
      content,
    );
    try {
      const query = new URLSearchParams();
      if (selected.from) query.set("from", selected.from);
      if (selected.to) query.set("to", selected.to);
      const diff = await get(`/api/tasks/${encodeURIComponent(task.id)}/diff?${query}`);
      setContent(
        content,
        diff.stat ? h("pre", { class: "card stat" }, diff.stat) : h("div", { class: "empty card muted" }, "No differences."),
        diff.truncated ? h("div", { class: "callout callout-warning" }, "The diff is large and was truncated. Inspect the branch with git for the full change.") : null,
        diff.text ? h("div", { class: "card diff-card" }, renderDiff(diff.text)) : null,
      );
    } catch (error) {
      setContent(content, h("div", { class: "callout callout-danger" }, error.message));
    }
  }

  function renderResult(force) {
    const signature = JSON.stringify([task.status, task.result, task.changeRequests?.length]);
    if (!force && signatures.result === signature) return;
    signatures.result = signature;
    const result = task.result;
    if (!result) {
      setContent(tabBody, h("div", { class: "empty card muted" }, ACTIVE.includes(task.status) ? "The result appears here when the workflow finishes." : "This task has no result."));
      return;
    }
    const repo = state.repos.find((candidate) => candidate.id === task.repoId);
    const repoPath = repo?.path ?? "<repo>";
    const commands = [
      `git -C "${repoPath}" log --oneline ${shortSha(task.baseSha)}..${task.branch}`,
      `git -C "${repoPath}" diff ${shortSha(task.baseSha)}...${task.branch}`,
      `git -C "${repoPath}" merge --no-ff ${task.branch}`,
    ].join("\n");
    const testsLast = task.stages.at(-1)?.kind === "testing";
    setContent(
      tabBody,
      result.approved
        ? h(
            "div",
            { class: "callout callout-success" },
            h("strong", {}, testsLast ? "All tests pass. " : "Approved. "),
            testsLast ? "The test executor verified the final version." : "The reviewer approved the final version.",
          )
        : h(
            "div",
            { class: "callout callout-warning" },
            h("strong", {}, testsLast ? "Tests still failing. " : "Finished without approval. "),
            testsLast
              ? `${result.openComments} failure(s) remain. Use “Continue fixing” to run more fix-and-verify rounds.`
              : `${result.openComments} review comment(s) remain open. Use “Continue review loop” to run more rounds.`,
          ),
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "meta-grid" },
          meta("Branch", h("span", { class: "mono" }, task.branch ?? "—"), " ", task.branch ? copyButton(task.branch) : null),
          meta("Head commit", h("span", { class: "mono" }, shortSha(result.headSha))),
          meta("Commits", String(result.commits ?? 0)),
          meta("Changes", result.shortStat || "—"),
          result.tests ? meta("Tests", chip(...(TEST_STATUS[result.tests.status] ?? [result.tests.status, "neutral"])), " ", testCounts(result.tests)) : null,
          result.unitTests
            ? meta(
                "Unit tests",
                chip(...(UNIT_TEST_STATUS[result.unitTests.status] ?? [result.unitTests.status, "neutral"])),
                " ",
                h("span", { class: "mono small" }, result.unitTests.commands.join(", ")),
              )
            : null,
          (result.docPath ?? result.designDocPath) ? meta(task.kind === "document" ? "Document" : "Design document", h("span", { class: "mono" }, result.docPath ?? result.designDocPath)) : null,
        ),
        h("h3", {}, "Final summary"),
        result.summary ? renderMarkdown(result.summary) : h("p", { class: "muted" }, "No summary."),
        h("h3", {}, "Change requests"),
        task.changeRequests?.length
          ? h("div", { class: "change-requests" }, [...task.changeRequests].reverse().map(changeRequestRow))
          : h("p", { class: "muted small" }, "Want something adjusted? Request changes: the agents rework the result and review it again, round by round."),
        h("div", { class: "row" }, h("button", { class: "btn btn-sm", onclick: requestChanges }, "✎ Request changes")),
        h("h3", {}, "Remote & pull request"),
        deliveryResult,
        h("h3", {}, "Next steps"),
        h("p", { class: "muted small" }, "Review and merge the task branch: open a pull request above, or merge it into your checkout locally. The worktree is kept until you delete the task."),
        h("div", { class: "code-block" }, h("pre", {}, commands), copyButton(commands, "Copy commands")),
      ),
    );
    renderDelivery();
  }

  /** One change request: what the user asked for, its state and the agent's response. */
  function changeRequestRow(request) {
    const stage = task.stages.find((candidate) => candidate.kind === request.stage);
    const comment = stage?.rounds.find((round) => round.n === request.round)?.review?.comments.find((candidate) => candidate.id === request.id);
    const working = ACTIVE.includes(task.status) && task.attempt === request.attempt;
    const [label, cls] = working
      ? ["In progress", "running"]
      : comment?.status === "addressed"
        ? ["Done", "success"]
        : comment?.status === "declined"
          ? ["Declined", "warning"]
          : ["Open", "neutral"];
    const responder = stage?.rounds.find((round) => round.n === request.round + 1)?.author?.role;
    return h(
      "div",
      { class: "comment comment-user" },
      h(
        "div",
        { class: "comment-head" },
        h("span", { class: "mono comment-id" }, request.id),
        chip(`${STAGE_LABELS[request.stage]} stage`, "outline"),
        h("span", { class: "muted small" }, `requested ${relTime(request.requestedAt)}`),
        h("span", { class: "spacer" }),
        chip(label, cls),
      ),
      renderMarkdown(request.text),
      comment?.response ? h("div", { class: "comment-response" }, h("span", { class: "muted" }, `↳ ${responder ? ROLE_LABELS[responder] : "Agent"}: `), comment.response) : null,
    );
  }

  // ---- actions ---------------------------------------------------------------------------

  /** Asks the agents for further changes to the finished task (approved or not). */
  async function requestChanges() {
    if (!task || task.status !== "completed") return;
    const kinds = task.stages.map((stage) => stage.kind);
    const lastKind = kinds.at(-1);
    const nextId = `U${(task.changeRequests?.length ?? 0) + 1}`;
    const text = h("textarea", {
      class: "input",
      rows: "7",
      value: requestDraft,
      placeholder: "Describe the changes or adjustments you want, e.g. “Rename hello() to greet(), accept a name parameter and add a unit test for an empty name.”",
    });
    const stageSelect =
      kinds.length > 1
        ? h(
            "select",
            { class: "input" },
            kinds.map((kind) => h("option", { value: kind, selected: kind === lastKind }, `${STAGE_LABELS[kind]} stage`)),
          )
        : null;
    const teamNote = h("small", { class: "muted" });
    const updateNote = () => {
      const kind = stageSelect?.value ?? lastKind;
      const later = kinds.slice(kinds.indexOf(kind) + 1);
      teamNote.textContent =
        `${STAGE_LABELS[kind]} stage: ${CHANGE_TEAMS[kind] ?? "its agents make and verify the change"}.` +
        (later.length ? ` Then ${later.map((other) => (other === "testing" ? "the tests run again" : `the ${STAGE_LABELS[other]} stage updates to match`)).join(", then ")}.` : "");
    };
    stageSelect?.addEventListener("change", updateNote);
    updateNote();
    const rounds = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(task.maxRounds) });
    const pending = confirmDialog({
      title: `Request changes · ${task.id}`,
      body: h(
        "div",
        { class: "stack" },
        h(
          "p",
          { class: "muted small" },
          `This becomes change request ${nextId}. The agents make the change on their own branches and the reviewer verifies it, round by round, until it is approved or the rounds run out; then the task branch is pushed again.`,
        ),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "What should change?"), text),
        stageSelect ? h("label", { class: "field" }, h("span", { class: "field-label" }, "Apply to"), stageSelect, teamNote) : teamNote,
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Rounds (review rounds or test runs per stage)"), rounds),
      ),
      confirmText: "Request changes",
      wide: true,
    });
    text.focus();
    const ok = await pending;
    requestDraft = text.value;
    if (!ok) return;
    if (!text.value.trim()) {
      toast("Describe the changes you want first", "error");
      return;
    }
    try {
      await post(`/api/tasks/${encodeURIComponent(task.id)}/change-request`, {
        request: text.value,
        stage: stageSelect?.value,
        rounds: Number(rounds.value) || undefined,
      });
      requestDraft = "";
      toast(`Change request ${nextId} queued`, "success");
      selectTab("conversation", false);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function pushTaskBranch() {
    if (pushBusy) return;
    pushBusy = true;
    renderDelivery();
    try {
      const updated = await post(`/api/tasks/${encodeURIComponent(task.id)}/push`);
      const push = updated?.push;
      if (push?.status === "pushed") toast(`Pushed ${push.branch} to ${push.remote}`, "success");
      else if (push?.status === "failed") toast(`Push failed: ${push.reason ?? "unknown error"}`, "error");
      else if (push?.reason) toast(push.reason);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      pushBusy = false;
      renderDelivery();
    }
  }

  async function createPullRequest() {
    if (prBusy) return;
    // The host's create page opens in a tab that must be opened during the click, or popup blockers stop it.
    const popup = remoteInfo?.direct ? null : window.open("about:blank", "_blank");
    if (popup) {
      popup.opener = null;
      try {
        popup.document.title = "Opening pull request…";
        popup.document.body.textContent = "Pushing the branch and opening the pull request page…";
      } catch {
        // Cosmetic only.
      }
    }
    const navigate = (url) => {
      if (popup && !popup.closed) popup.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    };
    prBusy = true;
    renderDelivery();
    try {
      const outcome = await post(`/api/tasks/${encodeURIComponent(task.id)}/pull-request`);
      if (outcome.pullRequest) {
        if (popup) navigate(outcome.pullRequest.url);
        task.pullRequest = outcome.pullRequest;
        toast(outcome.message, "success");
      } else if (outcome.createUrl) {
        createPageUrl = outcome.createUrl;
        navigate(outcome.createUrl);
        toast(outcome.message);
      } else {
        popup?.close();
      }
    } catch (error) {
      popup?.close();
      toast(error.message, "error");
    } finally {
      prBusy = false;
      renderDelivery();
    }
  }

  async function cancelTask() {
    const ok = await confirmDialog({ title: `Cancel ${task.id}?`, body: h("p", {}, "Running agents are stopped. Work committed so far stays on the branch."), confirmText: "Cancel task", danger: true });
    if (!ok) return;
    try {
      await post(`/api/tasks/${encodeURIComponent(task.id)}/cancel`);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function retryTask(continuing) {
    const rounds = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(continuing ? 2 : task.maxRounds) });
    const ok = await confirmDialog({
      title: continuing ? "Continue the review loop" : `Retry ${task.id}`,
      body: h(
        "div",
        { class: "stack" },
        h("p", {}, continuing ? "The author addresses the open comments and the reviewer re-reviews, in fresh agent sessions." : "The task resumes from its last completed step in the existing worktree."),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Review rounds for this attempt"), rounds),
      ),
      confirmText: continuing ? "Continue" : "Retry",
    });
    if (!ok) return;
    try {
      await post(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { extraRounds: Number(rounds.value) || 1 });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function deleteTask() {
    const deleteBranch = h("input", { type: "checkbox" });
    const ok = await confirmDialog({
      title: `Delete ${task.id}?`,
      body: h(
        "div",
        { class: "stack" },
        h("p", {}, "Removes the task, its history and its worktree."),
        task.branch ? h("label", { class: "row small" }, deleteBranch, `Also delete branch ${task.branch} (unmerged work is lost)`) : null,
      ),
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/tasks/${encodeURIComponent(task.id)}`, { deleteBranch: deleteBranch.checked });
      toast(`Deleted ${task.id}`, "success");
      location.hash = "#/tasks";
    } catch (error) {
      toast(error.message, "error");
    }
  }

  return () => {
    disposed = true;
    clearInterval(ticker);
    clearInterval(heroTicker);
    clearTimeout(reconnectTimer);
    window.removeEventListener("message", onFrameMessage);
    stream?.close();
  };
}
