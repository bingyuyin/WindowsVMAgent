import { del, get, post } from "../lib/api.js";
import {
  agentStatusInfo,
  chip,
  clock,
  compactNumber,
  confirmDialog,
  copyButton,
  duration,
  h,
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
/** "12 tests · 11 passed · 1 failed · 2 skipped" */
const testCounts = (run) =>
  [
    run.total !== undefined ? `${run.total} test${run.total === 1 ? "" : "s"}` : null,
    run.passed !== undefined ? `${run.passed} passed` : null,
    run.failed ? `${run.failed} failed` : null,
    run.skipped ? `${run.skipped} skipped` : null,
  ]
    .filter(Boolean)
    .join(" · ") || "no counts reported";

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
    const signature = JSON.stringify([task.kind, task.plan, task.status, task.phase]);
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
          plan.fallback ? chip("derived from keywords", "warning", "The planner did not submit a plan; the hub chose stages from the request") : null,
          h("span", { class: "spacer" }),
          h("span", { class: "muted small" }, plan.plannedAt ? `planned ${clock(plan.plannedAt)}` : ""),
        ),
        h(
          "div",
          { class: "plan-flow" },
          plan.stages.map((stage, index) => [
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
        plan.briefing
          ? h("details", { class: "plan-assignments" }, h("summary", {}, "Briefing on the repository the manager gave every sub-agent"), h("div", { class: "plan-assignment" }, renderMarkdown(plan.briefing)))
          : null,
        plan.stages.some((stage) => plan.instructions?.[stage])
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
    const actions = [];
    if (ACTIVE.includes(task.status)) actions.push(h("button", { class: "btn btn-danger-outline", onclick: cancelTask }, "Cancel"));
    if (["failed", "cancelled", "interrupted"].includes(task.status)) actions.push(h("button", { class: "btn btn-primary", onclick: () => retryTask(false) }, "Retry"));
    if (task.status === "completed" && task.result && !task.result.approved) {
      actions.push(h("button", { class: "btn btn-primary", onclick: () => retryTask(true) }, task.stages.at(-1)?.kind === "testing" ? "Continue fixing" : "Continue review loop"));
    }
    if (task.status === "completed" && task.result) actions.push(h("button", { class: "btn", onclick: requestChanges }, "✎ Request changes"));
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
        `${compactNumber(usage.premiumRequests)} premium req · ${compactNumber((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))} tokens · ${usage.modelCalls ?? 0} calls`,
      ),
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
    if (status === "completed" && task.result) {
      const result = task.result;
      const lastStage = task.stages.at(-1);
      const testsLast = lastStage?.kind === "testing";
      // The latest approval (a change request adds rounds after the first one).
      const approvedRound = lastStage?.rounds.findLast((round) => round.review?.verdict === "approve");
      const reviewer = lastStage ? ROLE_LABELS[REVIEWER_ROLE[lastStage.kind]] : "reviewer";
      const docPath = result.docPath ?? result.designDocPath;
      const docStage = task.stages.find((stage) => isDocStage(stage.kind));
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
            docStage ? h("button", { class: "btn btn-sm btn-primary", onclick: () => selectTab("document") }, docStage.kind === "document" ? "View document" : "View design") : null,
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

  /** Where the task branch stands on the remote, plus the push and pull request actions (hero and Result tab). */
  function renderDelivery() {
    if (!task || task.status !== "completed" || !task.result) return;
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
    const tabs = [
      ["conversation", roundsTabLabel(task)],
      ["timeline", "Timeline"],
      docStage ? ["document", docStage.kind === "document" ? "Document" : "Design doc"] : null,
      ["changes", "Changes"],
      ["context", "Context"],
      ["result", "Result"],
    ].filter(Boolean);
    if (!tabs.some(([tabId]) => tabId === activeTab)) activeTab = "conversation";
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
      ),
      check.reason ? h("p", { class: "small" }, check.reason) : null,
      check.commands?.length ? h("pre", { class: "pre-wrap test-commands" }, check.commands.join("\n")) : null,
      check.logExcerpt ? h("details", {}, h("summary", { class: "label" }, "Output of the failing run"), h("pre", { class: "pre-wrap" }, check.logExcerpt)) : null,
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

  async function renderDocument(force) {
    const stage = task.stages.find((candidate) => isDocStage(candidate.kind));
    const versions = (stage?.rounds ?? []).filter((round) => round.author?.docSnapshot).map((round) => round.n);
    const signature = JSON.stringify([versions, stage?.status, docRound, docMode]);
    if (!force && signatures.document === signature) return;
    signatures.document = signature;
    docFrame = null;
    const author = ROLE_LABELS[AUTHOR_ROLE[stage?.kind ?? "design"]].toLowerCase();
    if (!versions.length) {
      setContent(tabBody, h("div", { class: "empty card muted" }, ACTIVE.includes(task.status) ? spinner(`The ${author} is writing the first draft…`) : "No document was submitted."));
      return;
    }
    const selected = docRound && versions.includes(docRound) ? docRound : versions.at(-1);
    const latest = versions.at(-1);
    const final = stage.status === "approved" || stage.status === "not-approved";
    const format = stage.docFormat ?? (/\.html?$/i.test(stage.docPath ?? "") ? "html" : "markdown");
    const viewUrl = `/api/tasks/${encodeURIComponent(task.id)}/doc/view?round=${selected}`;
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
    setContent(
      tabBody,
      h(
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
                  title: `Version written in review round ${n}`,
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
          h("span", { class: "mono small" }, stage.docPath ?? ""),
          stage.status === "approved" && selected === latest ? chip("Approved", "success") : selected === latest && final ? chip("Final (not approved)", "warning") : chip("Draft", "neutral"),
          h("a", { class: "btn btn-xs", href: viewUrl, target: "_blank", rel: "noopener noreferrer", title: "Open the document in a new tab" }, "Open ↗"),
        ),
      ),
      content,
    );
    if (format === "html" && docMode === "rendered") {
      // Sandboxed (no same-origin): the document's scripts cannot reach the hub UI or its API.
      docFrame = h("iframe", {
        class: "doc-frame",
        sandbox: "allow-scripts allow-popups",
        referrerpolicy: "no-referrer",
        title: `${stage.docPath ?? "Document"} (version ${selected})`,
        height: "720",
        src: viewUrl,
      });
      setContent(content, docFrame);
      return;
    }
    setContent(content, spinner("Loading document…"));
    try {
      const doc = await get(`/api/tasks/${encodeURIComponent(task.id)}/doc?round=${selected}`);
      if (!doc.content) setContent(content, h("div", { class: "muted" }, "Document not available."));
      else if (format === "html") setContent(content, h("div", { class: "code-block" }, h("pre", { class: "doc-source" }, doc.content), copyButton(doc.content, "Copy HTML")));
      else setContent(content, renderMarkdown(doc.content));
    } catch (error) {
      setContent(content, h("div", { class: "callout callout-danger" }, error.message));
    }
  }

  async function renderChanges(force) {
    const ranges = [{ key: "all", label: "All changes (base → branch)", from: "", to: "" }];
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
