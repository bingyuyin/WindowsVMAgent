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
  KIND_LABELS,
  phaseLabel,
  ROLE_DESCRIPTIONS,
  ROLE_ICONS,
  ROLE_LABELS,
  ROLE_SKILLS,
  roleTag,
  rolesFor,
  setContent,
  shortSha,
  spinner,
  STAGE_LABELS,
  statusInfo,
  toast,
} from "../lib/dom.js";
import { renderDiff, renderMarkdown } from "../lib/markdown.js";
import { state } from "../lib/store.js";

const ACTIVE = ["queued", "running", "needs-input"];
const REVIEWER_ROLE = { design: "design-reviewer", coding: "code-reviewer" };
const STAGE_STATUS = {
  pending: ["Pending", "neutral"],
  running: ["In progress", "running"],
  approved: ["Approved", "success"],
  "not-approved": ["Not approved", "warning"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};
const SEVERITY_CLASS = { blocker: "danger", major: "warning", minor: "info", nit: "neutral" };
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
  let designRound = null;
  let diffSelection = null;
  let renderedInputId = null;
  const signatures = {};
  const toolRows = new Map();
  const toolStatus = new Map();
  const live = { role: null, messageId: null, text: "" };

  const titleBox = h("div", { class: "detail-title-row" });
  const metaBox = h("div", { class: "meta-grid" });
  const requestBox = h("details", { class: "request card" });
  const heroBox = h("div");
  const heroElapsed = h("span", { class: "muted small mono" });
  const inputBox = h("div");
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
    renderAgents();
    renderPipeline();
    renderLive();
    renderTabs();
    renderActiveTab(false);
  }

  function renderTitle() {
    const status = statusInfo(task);
    const actions = [];
    if (ACTIVE.includes(task.status)) actions.push(h("button", { class: "btn btn-danger-outline", onclick: cancelTask }, "Cancel"));
    if (["failed", "cancelled", "interrupted"].includes(task.status)) actions.push(h("button", { class: "btn btn-primary", onclick: () => retryTask(false) }, "Retry"));
    if (task.status === "completed" && task.result && !task.result.approved) {
      actions.push(h("button", { class: "btn btn-primary", onclick: () => retryTask(true) }, "Continue review loop"));
    }
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
    const resolver = task.kind !== "design" && task.resolverModel && task.resolverModel !== task.authorModel ? ` · resolver ${task.resolverModel}` : "";
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
      meta("Models", h("span", { class: "mono small" }, `author ${task.authorModel}${resolver} · reviewer ${task.reviewerModel}`)),
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
    if (status === "queued") {
      setContent(
        heroBox,
        h("div", { class: "card hero" }, h("div", { class: "hero-kicker" }, "QUEUED"), h("div", { class: "hero-title" }, "Waiting for a free slot"), h("div", { class: "muted" }, `Up to ${state.settings?.maxConcurrency ?? 2} tasks run in parallel; this one starts automatically.`)),
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
                  : role
                    ? `${ROLE_LABELS[role]}: ${working?.assignment ?? phaseLabel(task.currentStage, task.phase)}`
                    : phaseLabel(task.currentStage, task.phase),
              ),
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
      const approvedRound = lastStage?.rounds.find((round) => round.review?.verdict === "approve");
      const reviewer = lastStage ? ROLE_LABELS[REVIEWER_ROLE[lastStage.kind]] : "reviewer";
      setContent(
        heroBox,
        h(
          "div",
          { class: `card hero hero-result ${result.approved ? "hero-ok" : "hero-warn"}` },
          h("div", { class: "hero-top" }, h("span", { class: "hero-kicker" }, "RESULT"), h("span", { class: "spacer" }), h("span", { class: "muted small" }, `took ${duration(task.startedAt, task.finishedAt)}`)),
          h(
            "div",
            { class: "hero-title" },
            result.approved
              ? `✓ Approved by the ${reviewer.toLowerCase()}${approvedRound ? ` in round ${approvedRound.n}` : ""}`
              : `Finished without approval — ${result.openComments} review comment(s) still open`,
          ),
          h(
            "div",
            { class: "result-stats" },
            h("span", {}, h("strong", {}, String(result.commits ?? 0)), " commit(s)"),
            result.shortStat ? h("span", {}, result.shortStat) : null,
            result.designDocPath ? h("span", {}, "design ", h("span", { class: "mono" }, result.designDocPath)) : null,
            task.branch ? h("span", {}, "branch ", h("span", { class: "mono" }, task.branch), " ", copyButton(task.branch)) : null,
          ),
          result.summary ? h("div", { class: "hero-summary" }, renderMarkdown(result.summary)) : null,
          h(
            "div",
            { class: "row wrap" },
            h("button", { class: "btn btn-sm", onclick: () => selectTab("changes") }, "View changes"),
            h("button", { class: "btn btn-sm", onclick: () => selectTab("conversation") }, "Review rounds"),
            h("button", { class: "btn btn-sm", onclick: () => selectTab("result") }, "Merge instructions"),
            !result.approved ? h("button", { class: "btn btn-sm btn-primary", onclick: () => retryTask(true) }, "Continue review loop") : null,
          ),
        ),
      );
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

  /** One card per sub-agent: role, model, status, own branch/workspace, current assignment and activity. */
  function renderAgents() {
    const byRole = new Map((task.agents ?? []).map((agent) => [agent.role, agent]));
    const signature = JSON.stringify([task.status, task.agents, task.activity?.text]);
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
      h(
        "div",
        { class: "agent-grid" },
        rolesFor(task.kind).map((role) => {
          const agent = byRole.get(role);
          const notNeeded = !agent && !ACTIVE.includes(task.status) && task.status === "completed";
          const info = notNeeded ? { label: "Not needed", cls: "neutral" } : agentStatusInfo(agent);
          const reviewer = role === "code-reviewer" || role === "design-reviewer";
          const tokens = agent ? (agent.usage?.inputTokens ?? 0) + (agent.usage?.outputTokens ?? 0) : 0;
          const workspace = agent?.workspace
            ? agent.workspaceRemoved
              ? h("span", { class: "muted small" }, "worktree removed after completion")
              : [h("span", { class: "mono small break" }, agent.workspace), " ", copyButton(agent.workspace)]
            : h("span", { class: "muted small" }, "—");
          const branch = reviewer
            ? h("span", { class: "muted small" }, "detached at the reviewed commit (read-only)")
            : agent?.branch
              ? [h("span", { class: "mono small break" }, agent.branch), " ", copyButton(agent.branch)]
              : h("span", { class: "muted small" }, notNeeded ? "—" : "created when the agent starts");
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
              h("dt", {}, reviewer ? "Checkout" : "Branch"),
              h("dd", {}, branch),
              h("dt", {}, "Worktree"),
              h("dd", {}, workspace),
              h("dt", {}, "Progress"),
              h(
                "dd",
                { class: "small" },
                agent
                  ? `${agent.rounds.length ? `round${agent.rounds.length > 1 ? "s" : ""} ${agent.rounds.join(", ")} · ` : ""}${agent.turns} turn(s) · ${compactNumber(tokens)} tokens`
                  : notNeeded
                    ? role === "resolver"
                      ? "approved without review comments to resolve"
                      : "not used by this run"
                    : "not started",
              ),
              h("dt", {}, "Skills"),
              h("dd", { class: "small" }, ROLE_SKILLS[role].map((skill) => h("span", { class: "skill-chip" }, skill))),
            ),
          );
        }),
      ),
    );
  }

  function modelForRole(role) {
    if (role === "code-reviewer" || role === "design-reviewer") return task.reviewerModel;
    if (role === "resolver") return task.resolverModel || task.authorModel;
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
    setContent(
      pipelineBox,
      h(
        "div",
        { class: "card pipeline" },
        task.stages.map((stage, index) => {
          const [label, cls] = STAGE_STATUS[stage.status] ?? [stage.status, "neutral"];
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
                      const current = running && task.currentStage === stage.kind && task.currentRound === round.n;
                      const authorState = round.author ? "done" : current ? "active" : "pending";
                      const reviewState = round.review ? (round.review.verdict === "approve" ? "approved" : "changes") : current && task.phase === "reviewing" ? "active" : "pending";
                      const reviewLabel = round.review
                        ? round.review.verdict === "approve"
                          ? "✓ Approved"
                          : `✕ ${round.review.comments.length} comment${round.review.comments.length === 1 ? "" : "s"}`
                        : reviewState === "active"
                          ? "Reviewing…"
                          : "Review";
                      return h(
                        "div",
                        { class: `round-node ${current ? "current" : ""}` },
                        h("div", { class: "rn-title" }, `Round ${round.n}`),
                        h(
                          "div",
                          { class: "rn-steps" },
                          h("span", { class: `rn-step rn-${authorState}` }, authorState === "active" ? `${stage.kind === "design" ? "Writing" : "Coding"}…` : stage.kind === "design" ? "✎ Draft" : "✎ Code"),
                          h("span", { class: "rn-sep" }, "→"),
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
    const hasDesign = task.stages.some((stage) => stage.kind === "design");
    const tabs = [
      ["conversation", "Review rounds"],
      ["timeline", "Timeline"],
      hasDesign ? ["design", "Design doc"] : null,
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
      design: renderDesign,
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
    const roles = rolesFor(task.kind);
    const hubSkills = h(
      "div",
      { class: "context-section" },
      h("h3", {}, "Hub best-practice skills"),
      h("p", { class: "muted small" }, "Each agent loads its role's skill; repository instructions and skills take precedence where they differ."),
      h(
        "ul",
        { class: "context-list" },
        roles.map((role) => h("li", {}, roleTag(role), " ", ROLE_SKILLS[role].map((skill) => h("span", { class: "skill-chip" }, skill)))),
      ),
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
        files("Instruction files", context.instructions, "Loaded automatically by the Copilot runtime from each agent's worktree."),
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
      setContent(tabBody, h("div", { class: "empty card muted" }, ACTIVE.includes(task.status) ? spinner("Agents are starting…") : "No rounds were recorded."));
      return;
    }
    setContent(
      tabBody,
      stages.map((stage) =>
        h(
          "section",
          { class: "conv-stage" },
          h("h2", { class: "section-title" }, `${STAGE_LABELS[stage.kind]} stage`, " ", chip(...(STAGE_STATUS[stage.status] ?? [stage.status]))),
          stage.rounds.map((round) => roundCard(stage, round)),
        ),
      ),
    );
  }

  function roundCard(stage, round) {
    const current = ["running", "needs-input"].includes(task.status) && task.currentStage === stage.kind && task.currentRound === round.n;
    const author = round.author;
    const review = round.review;
    const authorRole = author?.role ?? (stage.kind === "design" ? "designer" : round.n > 1 || (current && task.phase === "revising") ? "resolver" : "coder");
    const reviewerRole = REVIEWER_ROLE[stage.kind];
    return h(
      "div",
      { class: `card round-card ${current ? "current" : ""}` },
      h(
        "div",
        { class: "round-head" },
        h("strong", {}, `Round ${round.n}`),
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
            author.responses?.length
              ? h(
                  "div",
                  { class: "sub-block" },
                  h("div", { class: "label" }, "Responses to review comments"),
                  author.responses.map((response) =>
                    h(
                      "div",
                      { class: "response" },
                      h("span", { class: "mono comment-id" }, response.commentId),
                      chip(response.status, response.status === "addressed" ? "success" : "warning"),
                      h("span", {}, response.note),
                    ),
                  ),
                )
              : null,
          )
        : current
          ? h("div", { class: "conv-block" }, spinner(`${ROLE_LABELS[authorRole]} is working…`))
          : null,
      review
        ? h(
            "div",
            { class: "conv-block review" },
            h(
              "div",
              { class: "conv-block-head" },
              roleTag(reviewerRole),
              review.verdict === "approve" ? chip("Approved", "success") : chip("Changes requested", "warning"),
              review.reviewedSha ? h("span", { class: "mono small muted" }, `reviewed ${shortSha(review.reviewedSha)}`) : null,
              review.fallback ? chip("no structured review", "warning") : null,
            ),
            renderMarkdown(review.summary),
            review.comments.map(commentCard),
          )
        : author && current
          ? h("div", { class: "conv-block review" }, spinner(`${ROLE_LABELS[reviewerRole]} is reviewing…`))
          : null,
    );
  }

  function commentCard(comment) {
    const statusChip =
      comment.status === "addressed" ? chip("Addressed", "success") : comment.status === "declined" ? chip("Declined", "warning") : chip("Open", "neutral");
    return h(
      "div",
      { class: `comment sev-${comment.severity}` },
      h(
        "div",
        { class: "comment-head" },
        h("span", { class: "mono comment-id" }, comment.id),
        chip(comment.severity, SEVERITY_CLASS[comment.severity] ?? "neutral"),
        comment.file ? h("span", { class: "mono small" }, comment.line ? `${comment.file}:${comment.line}` : comment.file) : null,
        h("span", { class: "spacer" }),
        statusChip,
      ),
      renderMarkdown(comment.body),
      comment.response ? h("div", { class: "comment-response" }, h("span", { class: "muted" }, "↳ Resolution: "), comment.response) : null,
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

  async function renderDesign(force) {
    const stage = task.stages.find((candidate) => candidate.kind === "design");
    const versions = (stage?.rounds ?? []).filter((round) => round.author?.docSnapshot).map((round) => round.n);
    const signature = JSON.stringify([versions, stage?.status, designRound]);
    if (!force && signatures.design === signature) return;
    signatures.design = signature;
    if (!versions.length) {
      setContent(tabBody, h("div", { class: "empty card muted" }, ACTIVE.includes(task.status) ? spinner("The designer is writing the first draft…") : "No design document was submitted."));
      return;
    }
    const selected = designRound && versions.includes(designRound) ? designRound : versions.at(-1);
    const latest = versions.at(-1);
    const final = stage.status === "approved" || stage.status === "not-approved";
    const content = h("div", { class: "card doc" }, spinner("Loading document…"));
    setContent(
      tabBody,
      h(
        "div",
        { class: "row between wrap" },
        h(
          "div",
          { class: "seg" },
          versions.map((n) =>
            h(
              "button",
              {
                class: `seg-item ${n === selected ? "active" : ""}`,
                onclick: () => {
                  designRound = n;
                  renderDesign(true);
                },
              },
              n === latest && final ? `v${n} · final` : `v${n}`,
            ),
          ),
        ),
        h(
          "div",
          { class: "row" },
          h("span", { class: "mono small" }, stage.docPath ?? ""),
          stage.status === "approved" && selected === latest ? chip("Approved", "success") : selected === latest && final ? chip("Final (not approved)", "warning") : chip("Draft", "neutral"),
        ),
      ),
      content,
    );
    try {
      const doc = await get(`/api/tasks/${encodeURIComponent(task.id)}/design?round=${selected}`);
      setContent(content, doc.content ? renderMarkdown(doc.content) : h("div", { class: "muted" }, "Document not available."));
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
    const signature = JSON.stringify([task.status, task.result]);
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
    setContent(
      tabBody,
      result.approved
        ? h("div", { class: "callout callout-success" }, h("strong", {}, "Approved. "), "The reviewer approved the final version.")
        : h(
            "div",
            { class: "callout callout-warning" },
            h("strong", {}, "Finished without approval. "),
            `${result.openComments} review comment(s) remain open. Use “Continue review loop” to run more rounds.`,
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
          result.designDocPath ? meta("Design document", h("span", { class: "mono" }, result.designDocPath)) : null,
        ),
        h("h3", {}, "Final summary"),
        result.summary ? renderMarkdown(result.summary) : h("p", { class: "muted" }, "No summary."),
        h("h3", {}, "Next steps"),
        h("p", { class: "muted small" }, "Review and merge the task branch into your checkout. The worktree is kept until you delete the task."),
        h("div", { class: "code-block" }, h("pre", {}, commands), copyButton(commands, "Copy commands")),
      ),
    );
  }

  // ---- actions ---------------------------------------------------------------------------

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
    stream?.close();
  };
}
