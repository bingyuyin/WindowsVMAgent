import {
  chip,
  clock,
  h,
  KIND_LABELS,
  phaseLabel,
  relTime,
  ROLE_DESCRIPTIONS,
  ROLE_ICONS,
  ROLE_LABELS,
  roleTag,
  rolesForTask,
  s,
  setContent,
  STAGE_LABELS,
  stageOfRole,
  statusInfo,
} from "../lib/dom.js";
import { state, subscribe } from "../lib/store.js";
import { parallelControl } from "../lib/parallel.js";

const ACTIVE = ["queued", "running", "needs-input"];
const PREFS_KEY = "agent-hub.agents-view";
const AUTHOR = { design: "designer", document: "writer", coding: "coder", testing: "fixer" };
const REVIEWER = { design: "design-reviewer", document: "doc-reviewer", coding: "code-reviewer", testing: "executor" };
const RESOLVER = { design: "designer", document: "writer", coding: "resolver", testing: "fixer" };
const ROLE_ORDER = ["planner", "designer", "design-reviewer", "coder", "code-reviewer", "resolver", "executor", "fixer", "writer", "doc-reviewer", "lead-reviewer", "peer-reviewer"];
const COMM_KINDS = {
  lifecycle: "status",
  plan: "plan",
  spawn: "start session",
  assign: "assign",
  submit: "submit",
  relay: "review request",
  verdict: "verdict",
  nudge: "nudge",
  monitor: "check-in",
  recover: "recovery",
  question: "question",
  answer: "answer",
  release: "release",
};
const MAX_FINISHED = 6;
const FEED_LIMIT = 200;
const STALE_MS = 2 * 60_000;
const XLINK = "http://www.w3.org/1999/xlink";
/** Diagram geometry (SVG user units). */
const G = {
  pad: 20,
  managerX: 20,
  managerW: 230,
  managerH: 120,
  userW: 170,
  userH: 50,
  userGap: 36,
  taskX: 330,
  taskW: 280,
  taskH: 88,
  agentX: 680,
  agentW: 340,
  agentH: 92,
  agentGap: 14,
  groupGap: 30,
};

const clip = (text, max) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const safeId = (text) => String(text).replace(/[^\w-]/g, "_");
const partyLabel = (party) => (party === "manager" ? "Manager" : party === "user" ? "You" : (ROLE_LABELS[party] ?? party));

function loadPrefs() {
  try {
    return { mode: "hierarchy", finished: false, feedTask: "", ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { mode: "hierarchy", finished: false, feedTask: "" };
  }
}

/** Status of one sub-agent role inside a task, including roles that have not started (yet). */
function agentState(task, role) {
  const agent = (task.agents ?? []).find((candidate) => candidate.role === role) ?? null;
  if (!agent) {
    if (ACTIVE.includes(task.status)) return { key: "pending", label: "Not started", cls: "neutral", agent };
    // Tasks from before per-agent tracking have no agent records: infer from their review rounds.
    if (!(task.agents ?? []).length && role !== "resolver") {
      const stage = task.stages.find((candidate) => candidate.kind === stageOfRole(role));
      const rounds = stage?.rounds ?? [];
      const worked = REVIEWER[stageOfRole(role)] === role ? rounds.some((round) => round.verdict && !round.byUser) : rounds.some((round) => round.authored);
      if (worked) return { key: "done", label: "Done", cls: "success", agent };
    }
    return { key: "unused", label: "Not needed", cls: "neutral", agent };
  }
  switch (agent.status) {
    case "working":
      return { key: "working", label: "Working", cls: "running", agent };
    case "idle":
      return { key: "idle", label: "Waiting", cls: "info-soft", agent };
    case "done":
      return { key: "done", label: "Done", cls: "success", agent };
    case "failed":
      return { key: "failed", label: "Failed", cls: "danger", agent };
    default:
      return { key: "stopped", label: "Stopped", cls: "neutral", agent };
  }
}

function pendingHint(task, role) {
  if (!ACTIVE.includes(task.status)) {
    return role === "resolver" ? "approved without comments to resolve" : role === "fixer" ? "tests passed without failures to fix" : "not used by this run";
  }
  if (role === "planner") return "plans the task first";
  if (role === "lead-reviewer" || role === "peer-reviewer") return "reviews the change when the task starts";
  if (role === "resolver") return "joins if the reviewer requests changes";
  if (role === "fixer") return "joins if a test run fails";
  if (role === "executor") return "runs the tests when the stage starts";
  if (REVIEWER[stageOfRole(role)] === role) return "starts after the first submission";
  if (task.kind === "design-coding" && stageOfRole(role) === "coding") return "starts after the design is final";
  if (task.kind === "auto") return "starts when its stage begins";
  return "starts when the task begins";
}

function modelForRole(task, role) {
  if (role === "planner") return task.managerModel || task.authorModel;
  if (role === "lead-reviewer") return task.reviewerModel;
  if (role === "peer-reviewer") return task.peerReviewerModel || task.authorModel;
  if (REVIEWER[stageOfRole(role)] === role) return task.reviewerModel;
  if (role === "resolver" || role === "fixer") return task.resolverModel || task.authorModel;
  return task.authorModel;
}

function taskLine(task) {
  if (task.status === "queued") return "Queued: waiting for a free slot";
  if (task.status === "needs-input") return "Waiting for your answer";
  if (task.status === "running") {
    if (task.phase === "planning") return "Manager is planning the sub-agents";
    if (task.kind === "review") return `${task.phase === "reviewing" ? "Reviewing the change independently" : phaseLabel(task.currentStage, task.phase)}${task.currentRound ? ` · round ${task.currentRound}` : ""}`;
    const budget = task.roundsBudget ?? task.maxRounds;
    return `${phaseLabel(task.currentStage, task.phase)}${task.currentRound ? ` · round ${task.currentRound}/${Math.max(budget, task.currentRound)}` : ""}`;
  }
  if (task.status === "completed") {
    if (task.kind === "review") {
      const review = task.review;
      return review ? `${review.published ? "Review published" : "Review ready"}: keeping ${review.kept} of ${review.comments} comment(s)` : "Review ready";
    }
    const rounds = task.stages.at(-1)?.rounds.length ?? 0;
    const testsLast = task.stages.at(-1)?.kind === "testing";
    if (testsLast) return task.approved ? `Tests pass after ${rounds} run${rounds === 1 ? "" : "s"}` : `Tests failing (${task.openComments ?? 0} failure(s))`;
    return task.approved ? `Approved after ${rounds} round${rounds === 1 ? "" : "s"}` : `Finished without approval (${task.openComments ?? 0} open)`;
  }
  return statusInfo(task).label;
}

export function agentsView(root) {
  const prefs = loadPrefs();
  const savePrefs = () => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Storage may be unavailable; preferences then last for this page only.
    }
  };

  const statsBox = h("div", { class: "agents-stats" });
  const parallel = parallelControl({ label: "Limit" });
  const statCards = {
    manager: makeStat("Manager agent"),
    tasks: makeStat("Tasks running"),
    agents: makeStat("Sub-agents working"),
    messages: makeStat("Messages (10 min)"),
  };
  statCards.tasks.extra.append(parallel.el);
  statsBox.append(...Object.values(statCards).map((stat) => stat.card));
  const modeBar = h("div", { class: "seg", role: "tablist", "aria-label": "Diagram style" });
  const finishedToggle = h("input", {
    type: "checkbox",
    checked: prefs.finished,
    onchange: () => {
      prefs.finished = finishedToggle.checked;
      savePrefs();
      render(true);
    },
  });
  const diagramBox = h("div", { class: "diagram-box" });
  const legendBox = h("div", { class: "diagram-legend muted small" });
  const rosterBox = h("div", { class: "roster" });
  const feedFilter = h("select", {
    class: "input input-sm",
    "aria-label": "Filter messages by task",
    onchange: () => {
      prefs.feedTask = feedFilter.value;
      savePrefs();
      renderFeed();
    },
  });
  const feedList = h("ol", { class: "feed", "aria-live": "polite" });

  root.append(
    h(
      "div",
      { class: "page-header" },
      h(
        "div",
        {},
        h("h1", {}, "Agents"),
        h("p", { class: "muted" }, "The manager agent assigns work to sub-agents, relays results between them and monitors their progress. Everything below updates live."),
      ),
      h("div", { class: "row wrap" }, modeBar, h("label", { class: "row small toggle" }, finishedToggle, "Show finished tasks")),
    ),
    statsBox,
    h(
      "div",
      { class: "agents-layout" },
      h("section", { class: "card diagram-card" }, diagramBox, legendBox),
      h(
        "section",
        { class: "card feed-card" },
        h("div", { class: "row between feed-head" }, h("h2", { class: "section-title" }, "Manager ↔ agents"), feedFilter),
        h("p", { class: "muted small" }, "Assignments, submissions, review verdicts, check-ins, recoveries and questions, newest first."),
        feedList,
      ),
    ),
    h("h2", { class: "section-title" }, "Sub-agents by role"),
    rosterBox,
  );

  let svgRoot = null;
  let pulseLayer = null;
  let structure = "";
  let updaters = [];
  let timer = null;
  const talkTimers = new Map();

  function renderModeBar() {
    setContent(
      modeBar,
      [
        ["hierarchy", "Hierarchy"],
        ["pipeline", "Pipeline"],
      ].map(([mode, label]) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(prefs.mode === mode),
            class: `seg-item ${prefs.mode === mode ? "active" : ""}`,
            onclick: () => {
              prefs.mode = mode;
              savePrefs();
              renderModeBar();
              render(true);
            },
          },
          label,
        ),
      ),
    );
  }

  function visibleTasks() {
    const all = [...state.tasks.values()];
    const active = all.filter((task) => ACTIVE.includes(task.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!prefs.finished) return active;
    const finished = all
      .filter((task) => !ACTIVE.includes(task.status))
      .sort((a, b) => (b.finishedAt ?? b.updatedAt).localeCompare(a.finishedAt ?? a.updatedAt))
      .slice(0, MAX_FINISHED);
    return [...active, ...finished];
  }

  /** Latest message between the manager and a task's agent (or the task itself when role is null). */
  function lastComm(taskId, role) {
    for (let index = state.comm.length - 1; index >= 0; index--) {
      const entry = state.comm[index];
      if (entry.taskId !== taskId) continue;
      if (!role || entry.from === role || entry.to === role) return entry;
    }
    return null;
  }

  function commLine(entry, role) {
    if (!entry) return "";
    const arrow = entry.from === role ? "↑" : "↓";
    return `${arrow} ${COMM_KINDS[entry.kind] ?? entry.kind}: ${entry.text} · ${relTime(entry.ts)}`;
  }

  // ---- stats -------------------------------------------------------------------------------

  function renderStats() {
    const tasks = [...state.tasks.values()];
    const running = tasks.filter((task) => task.status === "running" || task.status === "needs-input").length;
    const queued = tasks.filter((task) => task.status === "queued").length;
    const needsInput = tasks.filter((task) => task.status === "needs-input").length;
    const agents = tasks.filter((task) => ACTIVE.includes(task.status)).flatMap((task) => task.agents ?? []);
    const working = agents.filter((agent) => agent.status === "working").length;
    const waiting = agents.filter((agent) => agent.status === "idle").length;
    const capacity = state.settings?.maxConcurrency ?? 10;
    const online = Boolean(state.auth?.authenticated);
    const interval = state.manager?.monitorIntervalSec ?? 60;
    const lastCheck = state.manager?.lastCheckAt;
    const recent = state.comm.filter((entry) => Date.now() - Date.parse(entry.ts) < 10 * 60_000).length;
    const latest = state.comm.at(-1);
    setStat(
      statCards.manager,
      [h("span", { class: `dot ${online ? "dot-success" : "dot-danger"}` }), online ? " Online" : " Signed out"],
      `checks on agents every ${interval}s${lastCheck ? ` · last ${relTime(lastCheck)}` : ""}`,
      online ? "stat-ok" : "stat-bad",
    );
    setStat(
      statCards.tasks,
      `${running} / ${capacity}`,
      running > capacity
        ? `limit lowered: running tasks finish first · ${queued} queued`
        : `${queued} queued · ${needsInput} waiting for you`,
      needsInput ? "stat-attention" : "",
    );
    setStat(statCards.agents, String(working), `${waiting} waiting for their turn · ${agents.length} in active tasks`);
    setStat(statCards.messages, String(recent), latest ? `last: ${partyLabel(latest.from)} → ${partyLabel(latest.to)} ${relTime(latest.ts)}` : "no messages yet");
  }

  /** Stat cards are built once and updated in place, so the parallel-tasks control inside keeps working between refreshes. */
  function makeStat(label) {
    const value = h("div", { class: "agents-stat-value" });
    const sub = h("div", { class: "muted small" });
    const extra = h("div", { class: "agents-stat-extra" });
    const card = h("div", { class: "card agents-stat" }, h("div", { class: "agents-stat-label" }, label), value, sub, extra);
    return { card, value, sub, extra };
  }

  function setStat(stat, value, sub, cls = "") {
    stat.card.className = `card agents-stat ${cls}`;
    setContent(stat.value, value);
    stat.sub.textContent = sub;
  }

  // ---- hierarchy (SVG) -----------------------------------------------------------------------

  function structureOf(tasks) {
    return JSON.stringify([
      prefs.mode,
      Boolean(state.auth?.authenticated),
      tasks.map((task) => [
        task.id,
        task.status,
        task.kind,
        task.approved,
        task.plan?.stages,
        (task.agents ?? []).map((agent) => [agent.role, agent.status, agent.model]),
      ]),
    ]);
  }

  function renderHierarchy(tasks) {
    updaters = [];
    const groups = [];
    let top = G.pad;
    for (const task of tasks) {
      const roles = rolesForTask(task);
      const height = roles.length * G.agentH + (roles.length - 1) * G.agentGap;
      groups.push({ task, roles, top, height });
      top += height + G.groupGap;
    }
    const contentBottom = groups.length ? top - G.groupGap : G.pad + G.taskH;
    const minManagerY = G.pad + G.userH + G.userGap;
    const managerY = Math.max(minManagerY, (G.pad + contentBottom) / 2 - G.managerH / 2);
    const height = Math.max(contentBottom, managerY + G.managerH) + G.pad;
    const width = G.agentX + G.agentW + G.pad;
    const userX = G.managerX + (G.managerW - G.userW) / 2;
    const userY = managerY - G.userGap - G.userH;
    const managerRight = G.managerX + G.managerW;
    const managerMid = managerY + G.managerH / 2;

    const edges = s("g", { class: "edges" });
    const nodes = s("g", { class: "nodes" });
    pulseLayer = s("g", { class: "pulses" });
    svgRoot = s(
      "svg",
      { class: "org", viewBox: `0 0 ${width} ${height}`, width, height, role: "img", "aria-label": "Manager agent, tasks and sub-agents" },
      s(
        "defs",
        {},
        s("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, s("path", { class: "arrow-head", d: "M0,0 L10,5 L0,10 z" })),
      ),
      edges,
      nodes,
      pulseLayer,
    );

    // You -> manager
    edges.append(s("path", { id: "e-user", class: "edge user-edge", d: `M${userX + G.userW / 2},${userY + G.userH} L${userX + G.userW / 2},${managerY}`, "marker-end": "url(#arrow)" }));
    nodes.append(userNode(userX, userY));
    nodes.append(managerNode(managerY));

    if (!groups.length) {
      const y = managerMid - G.taskH / 2;
      edges.append(s("path", { class: "edge ghost", d: curve(managerRight, managerMid, G.taskX, y + G.taskH / 2) }));
      const ghost = s(
        "g",
        { class: "node ghost-node", transform: `translate(${G.taskX},${y})`, tabindex: 0, onclick: () => (location.hash = "#/tasks/new") },
        s("rect", { class: "node-box", width: G.taskW, height: G.taskH, rx: 12 }),
        s("text", { class: "node-title", x: 16, y: 36 }, "No tasks in progress"),
        s("text", { class: "node-line", x: 16, y: 58 }, prefs.finished ? "Submit a task to put agents to work" : "Submit a task, or show finished tasks"),
      );
      nodes.append(ghost);
    }

    for (const group of groups) {
      const { task, roles } = group;
      const taskY = group.top + (group.height - G.taskH) / 2;
      const taskMid = taskY + G.taskH / 2;
      const tid = safeId(task.id);
      const st = statusInfo(task);
      edges.append(
        s("path", {
          id: `e-m-${tid}`,
          class: `edge task-edge ${task.status === "running" || task.status === "needs-input" ? "live" : task.status === "queued" ? "queued" : "done"}`,
          d: curve(managerRight, managerMid, G.taskX, taskMid),
          "marker-end": "url(#arrow)",
        }),
      );
      nodes.append(taskNode(task, taskY, st));
      roles.forEach((role, index) => {
        const y = group.top + index * (G.agentH + G.agentGap);
        const agent = agentState(task, role);
        edges.append(
          s("path", {
            id: `e-${tid}-${role}`,
            class: `edge agent-edge st-${agent.key}`,
            d: curve(G.taskX + G.taskW, taskMid, G.agentX, y + G.agentH / 2),
            "marker-end": "url(#arrow)",
          }),
        );
        nodes.append(agentNode(task, role, agent, y));
      });
    }
    setContent(diagramBox, h("div", { class: "org-scroll" }, svgRoot));
  }

  function curve(x1, y1, x2, y2) {
    const dx = Math.max(30, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function pill(x, y, label, cls) {
    const width = Math.round(label.length * 6.6 + 18);
    return s(
      "g",
      { class: `pill pill-${cls}`, transform: `translate(${x - width},${y})` },
      s("rect", { width, height: 20, rx: 10 }),
      s("text", { x: width / 2, y: 14, "text-anchor": "middle" }, label),
    );
  }

  function userNode(x, y) {
    return s(
      "g",
      { class: "node user-node", transform: `translate(${x},${y})` },
      s("title", {}, "You submit tasks, answer agent questions and review the results"),
      s("rect", { class: "node-box", width: G.userW, height: G.userH, rx: 25 }),
      s("text", { class: "node-title", x: G.userW / 2, y: 22, "text-anchor": "middle" }, `You (${state.auth?.login ?? "user"})`),
      s("text", { class: "node-line", x: G.userW / 2, y: 38, "text-anchor": "middle" }, "tasks · answers · results"),
    );
  }

  function managerNode(y) {
    const online = Boolean(state.auth?.authenticated);
    const slots = s("text", { class: "node-line", x: 18, y: 76 });
    const check = s("text", { class: "node-line muted", x: 18, y: 96 });
    const update = () => {
      const tasks = [...state.tasks.values()];
      const running = tasks.filter((task) => task.status === "running" || task.status === "needs-input").length;
      const queued = tasks.filter((task) => task.status === "queued").length;
      slots.textContent = `${running}/${state.settings?.maxConcurrency ?? 10} slots busy · ${queued} queued`;
      const last = state.manager?.lastCheckAt;
      check.textContent = `monitors every ${state.manager?.monitorIntervalSec ?? 60}s${last ? ` · ${relTime(last)}` : ""}`;
    };
    update();
    updaters.push(update);
    return s(
      "g",
      { class: `node manager-node ${online ? "online" : "offline"}`, transform: `translate(${G.managerX},${y})` },
      s("title", {}, "The manager queues tasks, starts sub-agent sessions, assigns each round, relays submissions to reviewers and review comments back to authors, checks on silent agents and recovers stuck ones (interrupts the turn, then restarts the session)."),
      s("rect", { class: "node-box", width: G.managerW, height: G.managerH, rx: 14 }),
      s("circle", { class: "manager-badge", cx: 30, cy: 30, r: 16 }),
      s("text", { class: "manager-badge-text", x: 30, y: 36, "text-anchor": "middle" }, "◆"),
      s("text", { class: "node-title", x: 56, y: 27 }, "Manager agent"),
      s("text", { class: "node-sub", x: 56, y: 44 }, online ? "online · orchestrating" : "signed out · paused"),
      s("circle", { class: `status-dot ${online ? "ok" : "bad"}`, cx: G.managerW - 18, cy: 22, r: 5 }),
      slots,
      check,
    );
  }

  function taskNode(task, y, st) {
    const line = s("text", { class: "node-line", x: 18, y: 72 });
    const update = () => {
      const current = state.tasks.get(task.id) ?? task;
      line.textContent = clip(taskLine(current), 40);
    };
    update();
    updaters.push(update);
    return s(
      "g",
      { class: `node task-node st-${st.cls}`, transform: `translate(${G.taskX},${y})`, tabindex: 0, onclick: () => (location.hash = `#/tasks/${task.id}`) },
      s("title", {}, `${task.id}: ${task.title}\n${KIND_LABELS[task.kind]} on ${task.repoName}\nClick to open the task`),
      s("rect", { class: "node-box", width: G.taskW, height: G.taskH, rx: 12 }),
      s("rect", { class: "node-stripe", x: 0, y: 10, width: 4, height: G.taskH - 20, rx: 2 }),
      s("text", { class: "node-kicker", x: 18, y: 24 }, `${task.id} · ${KIND_LABELS[task.kind]}`),
      pill(G.taskW - 12, 10, st.label, st.cls),
      s("text", { class: "node-title", x: 18, y: 48 }, clip(task.title, 34)),
      line,
    );
  }

  function agentNode(task, role, info, y) {
    const activity = s("text", { class: "node-line", x: 16, y: 64 });
    const message = s("text", { class: "node-line muted", x: 16, y: 82 });
    const heartbeat = s("text", { class: "node-heartbeat", x: G.agentW - 12, y: 46, "text-anchor": "end" });
    const tooltip = s("title", {});
    const group = s(
      "g",
      { class: `node agent-node st-${info.key}`, transform: `translate(${G.agentX},${y})`, tabindex: 0, onclick: () => (location.hash = `#/tasks/${task.id}`) },
      tooltip,
      s("rect", { class: "node-box", width: G.agentW, height: G.agentH, rx: 12 }),
      s("circle", { class: `node-icon role-${role}`, cx: 28, cy: 26, r: 15 }),
      s("text", { class: `node-icon-text role-${role}`, x: 28, y: 31, "text-anchor": "middle" }, ROLE_ICONS[role]),
      s("text", { class: "node-title", x: 52, y: 23 }, ROLE_LABELS[role]),
      s("text", { class: "node-sub mono", x: 52, y: 40 }, clip(info.agent?.model ?? modelForRole(task, role), 26)),
      pill(G.agentW - 12, 8, info.label, info.cls),
      heartbeat,
      activity,
      message,
    );
    const update = () => {
      const current = state.tasks.get(task.id) ?? task;
      const agent = (current.agents ?? []).find((candidate) => candidate.role === role);
      const key = agentState(current, role).key;
      const doing =
        key === "working"
          ? `› ${agent?.lastActivity || agent?.assignment || "working"}`
          : key === "idle"
            ? `waiting · ${agent?.assignment ?? "next turn"}`
            : agent
              ? `${agent.rounds?.length ? `round${agent.rounds.length > 1 ? "s" : ""} ${agent.rounds.join(", ")} · ` : ""}${agent.turns ?? 0} turn(s)`
              : pendingHint(current, role);
      activity.textContent = clip(doing, 50);
      const comm = lastComm(task.id, role);
      message.textContent = clip(commLine(comm, role), 52);
      const silentMs = agent?.updatedAt ? Date.now() - Date.parse(agent.updatedAt) : 0;
      heartbeat.textContent = key === "working" && agent?.updatedAt ? `♥ ${relTime(agent.updatedAt)}` : "";
      heartbeat.setAttribute("class", `node-heartbeat ${key === "working" && silentMs > STALE_MS ? "stale" : ""}`);
      tooltip.textContent = [
        `${ROLE_LABELS[role]} (${task.id}) - ${ROLE_DESCRIPTIONS[role]}`,
        agent?.model ? `Model: ${agent.model}` : null,
        agent?.branch
          ? `Branch: ${agent.branch}`
          : role === "executor"
            ? "Own checkout pinned to the commit under test (runs commands, cannot edit files)"
            : role === "planner"
              ? "Read-only checkout at the base commit"
              : role.endsWith("reviewer")
                ? "Read-only worktree pinned to the reviewed commit"
                : null,
        agent?.assignment ? `Assignment: ${agent.assignment}` : null,
        agent?.lastActivity ? `Last activity: ${agent.lastActivity}` : null,
        comm ? `Last message (${partyLabel(comm.from)} → ${partyLabel(comm.to)}): ${comm.text}` : null,
        "Click to open the task",
      ]
        .filter(Boolean)
        .join("\n");
    };
    update();
    updaters.push(update);
    return group;
  }

  /** Animates a message travelling along the diagram edges (manager -> task -> agent, or back). */
  function pulse(entry) {
    if (prefs.mode !== "hierarchy" || !svgRoot?.isConnected) return;
    const tid = safeId(entry.taskId);
    const hops = [];
    if (entry.from === "user" || entry.to === "user") {
      hops.push({ id: "e-user", forward: entry.from === "user" });
      if (entry.from === "user") hops.push({ id: `e-m-${tid}`, forward: true });
      else hops.unshift({ id: `e-m-${tid}`, forward: false });
    } else if (entry.from === "manager" && entry.to === "manager") {
      hops.push({ id: `e-m-${tid}`, forward: true });
    } else {
      const toAgent = entry.from === "manager";
      const role = toAgent ? entry.to : entry.from;
      if (toAgent) hops.push({ id: `e-m-${tid}`, forward: true }, { id: `e-${tid}-${role}`, forward: true });
      else hops.push({ id: `e-${tid}-${role}`, forward: false }, { id: `e-m-${tid}`, forward: false });
    }
    hops.forEach((hop, index) => setTimeout(() => travel(hop, entry.kind), index * 650));
  }

  function travel(hop, kind) {
    const path = svgRoot?.querySelector(`#${CSS.escape(hop.id)}`);
    if (!path || !pulseLayer) return;
    const mpath = s("mpath", { href: `#${hop.id}` });
    mpath.setAttributeNS(XLINK, "xlink:href", `#${hop.id}`);
    const motion = s("animateMotion", { dur: "0.7s", begin: "indefinite", fill: "freeze", keyPoints: hop.forward ? "0;1" : "1;0", keyTimes: "0;1", calcMode: "linear" }, mpath);
    const dot = s("circle", { class: `msg-dot k-${kind}`, r: 6, cx: 0, cy: 0 }, motion);
    pulseLayer.append(dot);
    motion.beginElement?.();
    setTimeout(() => dot.remove(), 900);
    path.classList.add("talking");
    clearTimeout(talkTimers.get(hop.id));
    talkTimers.set(
      hop.id,
      setTimeout(() => path.classList.remove("talking"), 2500),
    );
  }

  // ---- pipeline (HTML) -----------------------------------------------------------------------

  function renderPipeline(tasks) {
    svgRoot = null;
    pulseLayer = null;
    updaters = [];
    if (!tasks.length) {
      setContent(diagramBox, h("div", { class: "empty muted" }, "No tasks in progress. ", h("a", { href: "#/tasks/new" }, "Submit a task"), prefs.finished ? "" : " or show finished tasks."));
      return;
    }
    setContent(
      diagramBox,
      h(
        "div",
        { class: "pipes" },
        tasks.map((task) => {
          const st = statusInfo(task);
          return h(
            "div",
            { class: `pipe-row st-${st.cls}` },
            h(
              "a",
              { class: "pipe-task", href: `#/tasks/${task.id}` },
              h("div", { class: "row" }, chip(st.label, st.cls), h("span", { class: "mono small muted" }, task.id)),
              h("div", { class: "pipe-task-title" }, task.title),
              h("div", { class: "muted small" }, `${KIND_LABELS[task.kind]} · ${task.repoName}`),
              h("div", { class: "small pipe-task-line" }, taskLine(task)),
            ),
            h(
              "div",
              { class: "pipe-flow" },
              h(
                "div",
                { class: `pipe-step pipe-manager ${state.auth?.authenticated ? "st-working" : "st-stopped"}`, title: "The manager plans Auto tasks, assigns each round, relays results between the agents and monitors them" },
                h("span", { class: "pipe-icon" }, "◆"),
                h(
                  "div",
                  {},
                  h("div", { class: "pipe-role" }, "Manager"),
                  h("div", { class: "pipe-sub" }, task.kind === "auto" ? (task.plan ? "planned · assigns" : task.phase === "planning" ? "planning…" : "plans first") : "assigns · relays"),
                ),
              ),
              !task.stages.length && task.kind !== "review"
                ? [h("span", { class: "pipe-arrow pipe-arrow-stage" }, "→"), h("div", { class: "pipe-lane current" }, h("div", { class: "pipe-lane-head" }, h("span", {}, "Planning"), h("span", { class: "muted small" }, "agents are created from the plan")))]
                : null,
              task.kind === "review" ? [h("span", { class: "pipe-arrow pipe-arrow-stage" }, "→"), reviewLane(task)] : null,
              task.stages.map((stage, index) => [h("span", { class: "pipe-arrow pipe-arrow-stage" }, index ? "⇒" : "→"), stageLane(task, stage)]),
            ),
          );
        }),
      ),
    );
  }

  /** Code review tasks: the two reviewers work side by side, discuss, then the lead finalizes and the peer signs off. */
  function reviewLane(task) {
    const current = ACTIVE.includes(task.status);
    const phase = !current
      ? task.status === "completed"
        ? task.review?.published
          ? "published"
          : "ready for you"
        : task.status
      : task.phase === "discussing"
        ? "discussing"
        : task.phase === "consolidating"
          ? "agreeing on the final review"
          : task.phase === "reviewing"
            ? "reviewing independently"
            : "starting";
    return h(
      "div",
      { class: `pipe-lane ${current ? "current" : ""} lane-${task.status === "completed" ? "approved" : current ? "running" : "pending"}` },
      h("div", { class: "pipe-lane-head" }, h("span", {}, "Code review"), h("span", { class: "muted small" }, phase)),
      h("div", { class: "pipe-steps" }, pipeStep(task, "lead-reviewer"), h("span", { class: "pipe-arrow" }, "⇄"), pipeStep(task, "peer-reviewer")),
      task.review && task.status === "completed"
        ? h("div", { class: "pipe-loop" }, h("span", { class: "muted small" }, `keeping ${task.review.kept} of ${task.review.comments} comment(s)${task.review.agreed === false ? " · disputed" : ""}`))
        : null,
    );
  }

  function stageLane(task, stage) {
    const testing = stage.kind === "testing";
    const author = AUTHOR[stage.kind];
    const reviewer = REVIEWER[stage.kind];
    const resolver = RESOLVER[stage.kind];
    // Testing starts with a run; the fixer loops back into the next run.
    const roles = testing ? [reviewer, author] : resolver === author ? [author, reviewer] : [author, reviewer, resolver];
    const current = ACTIVE.includes(task.status) && task.currentStage === stage.kind;
    const budget = task.roundsBudget ?? task.maxRounds;
    const rounds = stage.rounds ?? [];
    // The user's change requests are rounds of their own; they don't count against the agents' rounds.
    const agentRounds = rounds.filter((round) => !round.byUser).length;
    const noun = testing ? "run" : "round";
    return h(
      "div",
      { class: `pipe-lane ${current ? "current" : ""} lane-${stage.status}` },
      h(
        "div",
        { class: "pipe-lane-head" },
        h("span", {}, `${STAGE_LABELS[stage.kind]} stage`),
        h(
          "span",
          { class: "muted small" },
          stage.status === "pending"
            ? "pending"
            : testing && stage.status === "approved"
              ? "tests pass"
              : testing && stage.status === "not-approved"
                ? "tests failing"
                : stage.status.replace("-", " "),
        ),
      ),
      h(
        "div",
        { class: "pipe-steps" },
        roles.map((role, index) => [index ? h("span", { class: "pipe-arrow" }, index === 2 || testing ? "↺" : "→") : null, pipeStep(task, role)]),
      ),
      h(
        "div",
        { class: "pipe-loop" },
        h("span", { class: "muted small" }, agentRounds ? `${noun} ${agentRounds} of ${Math.max(budget, agentRounds)}` : `up to ${budget} ${noun}${budget === 1 ? "" : "s"}`),
        rounds.map((round) =>
          round.byUser
            ? h("span", { class: "round-dot user", title: `Round ${round.n}: your change request` }, "✎")
            : h(
                "span",
                {
                  class: `round-dot ${round.verdict === "approve" ? "ok" : round.verdict === "request_changes" ? "changes" : "open"}`,
                  title: `Round ${round.n}: ${
                    round.verdict === "approve"
                      ? testing
                        ? "tests passed"
                        : "approved"
                      : round.verdict === "request_changes"
                        ? testing
                          ? round.testStatus === "blocked"
                            ? "blocked"
                            : `${round.comments} failure(s)`
                          : `${round.comments} comment(s)`
                        : "in progress"
                  }`,
                },
                round.verdict === "approve" ? "✓" : round.verdict === "request_changes" ? String(round.comments) : "…",
              ),
        ),
      ),
    );
  }

  function pipeStep(task, role) {
    const info = agentState(task, role);
    const agent = info.agent;
    const comm = lastComm(task.id, role);
    return h(
      "div",
      { class: `pipe-step st-${info.key}`, title: [ROLE_DESCRIPTIONS[role], agent?.model ? `Model: ${agent.model}` : null, comm ? `Last message: ${comm.text}` : null].filter(Boolean).join("\n") },
      h("span", { class: `pipe-icon role-${role}` }, ROLE_ICONS[role]),
      h(
        "div",
        { class: "pipe-step-body" },
        h("div", { class: "pipe-role" }, ROLE_LABELS[role]),
        h("div", { class: "pipe-sub" }, info.label),
        info.key === "working" ? h("div", { class: "pipe-act mono", title: agent?.lastActivity ?? "" }, clip(agent?.lastActivity || agent?.assignment, 34)) : null,
      ),
    );
  }

  // ---- roster & feed -------------------------------------------------------------------------

  function renderRoster(tasks) {
    const rows = ROLE_ORDER.map((role) => {
      const entries = tasks.filter((task) => rolesForTask(task).includes(role)).map((task) => ({ task, info: agentState(task, role) }));
      return { role, entries };
    }).filter((row) => row.entries.length);
    if (!rows.length) {
      setContent(rosterBox, h("div", { class: "card muted small" }, "No sub-agents are assigned right now."));
      return;
    }
    setContent(
      rosterBox,
      h(
        "div",
        { class: "card roster-card" },
        h(
          "table",
          { class: "roster-table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Role"), h("th", {}, "Working"), h("th", {}, "Waiting"), h("th", {}, "Done"), h("th", {}, "Handling"))),
          h(
            "tbody",
            {},
            rows.map(({ role, entries }) =>
              h(
                "tr",
                {},
                h("td", {}, h("span", { class: `roster-icon role-${role}` }, ROLE_ICONS[role]), " ", roleTag(role)),
                h("td", { class: "num" }, String(entries.filter((entry) => entry.info.key === "working").length)),
                h("td", { class: "num" }, String(entries.filter((entry) => entry.info.key === "idle").length)),
                h("td", { class: "num" }, String(entries.filter((entry) => entry.info.key === "done").length)),
                h(
                  "td",
                  {},
                  h(
                    "div",
                    { class: "roster-tasks" },
                    entries.map(({ task, info }) =>
                      h(
                        "a",
                        { class: `roster-task st-${info.key}`, href: `#/tasks/${task.id}`, title: `${task.title}\n${info.agent?.assignment ?? info.label}` },
                        h("span", { class: "mono" }, task.id),
                        " ",
                        info.key === "working" ? clip(info.agent?.assignment ?? "working", 38) : info.label.toLowerCase(),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderFeedFilter() {
    const ids = new Map();
    for (const task of visibleTasks()) ids.set(task.id, task.title);
    for (const entry of state.comm) if (!ids.has(entry.taskId)) ids.set(entry.taskId, entry.taskTitle);
    const signature = JSON.stringify([...ids.keys(), prefs.feedTask]);
    if (feedFilter.dataset.signature === signature) return;
    feedFilter.dataset.signature = signature;
    setContent(
      feedFilter,
      h("option", { value: "", selected: !prefs.feedTask }, "All tasks"),
      [...ids].map(([id, title]) => h("option", { value: id, selected: prefs.feedTask === id }, `${id} · ${clip(title, 40)}`)),
    );
  }

  function feedItem(entry) {
    const internal = entry.from === entry.to;
    return h(
      "li",
      { class: `feed-item k-${entry.kind}` },
      h(
        "div",
        { class: "feed-top" },
        h("span", { class: "feed-time mono" }, clock(entry.ts)),
        partyTag(entry.from),
        internal ? null : h("span", { class: "feed-arrow" }, "→"),
        internal ? null : partyTag(entry.to),
        h("span", { class: `feed-kind k-${entry.kind}` }, COMM_KINDS[entry.kind] ?? entry.kind),
        h("a", { class: "feed-task mono", href: `#/tasks/${entry.taskId}`, title: entry.taskTitle }, entry.taskId),
      ),
      h("div", { class: "feed-text" }, entry.text),
    );
  }

  function partyTag(party) {
    if (party === "manager") return h("span", { class: "role-tag role-manager" }, "◆ Manager");
    if (party === "user") return h("span", { class: "role-tag role-user" }, "You");
    return roleTag(party);
  }

  function renderFeed() {
    renderFeedFilter();
    const entries = state.comm.filter((entry) => !prefs.feedTask || entry.taskId === prefs.feedTask).slice(-FEED_LIMIT).reverse();
    setContent(feedList, entries.length ? entries.map(feedItem) : h("li", { class: "muted small feed-empty" }, "No messages yet. They appear here as soon as the manager assigns work."));
  }

  function addFeedEntry(entry) {
    if (prefs.feedTask && entry.taskId !== prefs.feedTask) return;
    feedList.querySelector(".feed-empty")?.remove();
    const item = feedItem(entry);
    item.classList.add("fresh");
    feedList.prepend(item);
    while (feedList.children.length > FEED_LIMIT) feedList.lastElementChild.remove();
  }

  // ---- rendering ---------------------------------------------------------------------------

  function render(force = false) {
    clearTimeout(timer);
    timer = null;
    const tasks = visibleTasks();
    renderStats();
    if (prefs.mode === "pipeline") {
      structure = "";
      renderPipeline(tasks);
    } else {
      const next = structureOf(tasks);
      if (force || next !== structure || !svgRoot?.isConnected) {
        structure = next;
        renderHierarchy(tasks);
      } else {
        for (const update of updaters) update();
      }
    }
    setContent(
      legendBox,
      prefs.mode === "hierarchy"
        ? [
            h("span", { class: "legend-item" }, h("span", { class: "legend-line live" }), "active link"),
            h("span", { class: "legend-item" }, h("span", { class: "legend-dot k-assign" }), "manager → agent"),
            h("span", { class: "legend-item" }, h("span", { class: "legend-dot k-submit" }), "agent → manager"),
            h("span", { class: "legend-item" }, h("span", { class: "legend-dot k-verdict" }), "review verdict"),
            h("span", { class: "legend-item" }, "♥ last sign of life · ↓ last instruction · ↑ last report"),
          ]
        : [h("span", { class: "legend-item" }, "Each stage: author → reviewer ↺ comment resolver, round by round until the reviewer approves.")],
    );
    renderRoster(tasks);
    renderFeedFilter();
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(() => render(), 300);
  };

  renderModeBar();
  render(true);
  renderFeed();

  const ticker = setInterval(() => {
    renderStats();
    for (const update of updaters) update();
  }, 1000);

  const unsubscribe = subscribe((kind, payload) => {
    if (kind === "comm") {
      if (payload) {
        addFeedEntry(payload);
        pulse(payload);
        schedule();
      } else {
        renderFeed();
        schedule();
      }
    } else if (kind === "tasks" || kind === "settings" || kind === "auth" || kind === "manager") {
      if (kind === "settings") parallel.update();
      schedule();
    }
  });

  return () => {
    unsubscribe();
    clearInterval(ticker);
    clearTimeout(timer);
    for (const handle of talkTimers.values()) clearTimeout(handle);
  };
}
