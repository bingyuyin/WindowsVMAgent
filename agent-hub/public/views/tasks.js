import {
  agentStatusInfo,
  chip,
  h,
  isCodeReviewTask,
  KIND_LABELS,
  phaseLabel,
  relTime,
  ROLE_LABELS,
  roleTag,
  rolesForTask,
  setContent,
  STAGE_LABELS,
  statusInfo,
} from "../lib/dom.js";
import { state, subscribe } from "../lib/store.js";
import { parallelControl } from "../lib/parallel.js";

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "active", label: "Active", test: (task) => ["queued", "running", "needs-input"].includes(task.status) },
  { id: "input", label: "Needs input", test: (task) => task.status === "needs-input" },
  { id: "done", label: "Completed", test: (task) => task.status === "completed" },
  { id: "problems", label: "Failed / stopped", test: (task) => ["failed", "cancelled", "interrupted"].includes(task.status) },
];

let currentFilter = "all";

/** Compact stage/round pipeline: one pill per stage, one dot per review round (or test run). */
export function pipelineMini(task) {
  if (isCodeReviewTask(task)) {
    const running = ["running", "needs-input"].includes(task.status);
    const review = task.review;
    const label = running
      ? `Code review · ${task.phase === "reviewing" ? "reviewing independently" : task.phase === "discussing" ? "discussing" : task.phase === "consolidating" ? "agreeing on the final review" : "starting"}`
      : review && task.status === "completed"
        ? `Code review · ${review.published ? "published" : "ready for you"}`
        : "Code review";
    return h(
      "div",
      { class: "pipeline-mini" },
      h("span", { class: `pm-stage pm-${task.status === "completed" ? "approved" : running ? "running" : "pending"}` }, h("span", { class: "pm-label" }, label), review?.target ? h("span", { class: "muted small" }, ` ${review.target}`) : null),
    );
  }
  if (!task.stages.length && task.kind === "auto") {
    const planning = ["running", "needs-input"].includes(task.status);
    return h("div", { class: "pipeline-mini" }, h("span", { class: "pm-stage pm-running" }, h("span", { class: "pm-label" }, planning ? "Manager is planning…" : "Not planned yet")));
  }
  return h(
    "div",
    { class: "pipeline-mini" },
    task.stages.map((stage, index) =>
      h(
        "span",
        { class: `pm-stage pm-${stage.status}` },
        index > 0 ? h("span", { class: "pm-arrow", "aria-hidden": "true" }, "→") : null,
        h("span", { class: "pm-label" }, STAGE_LABELS[stage.kind]),
        stage.rounds.length === 0
          ? h("span", { class: "pm-dot pm-pending", title: "Not started" })
          : stage.rounds.map((round) => {
              if (round.byUser) return h("span", { class: "pm-dot pm-user", title: `Round ${round.n}: your change request` }, "✎");
              const live = task.currentStage === stage.kind && task.currentRound === round.n && ["running", "needs-input"].includes(task.status);
              const cls = round.verdict === "approve" ? "pm-approved" : round.verdict === "request_changes" ? "pm-changes" : live ? "pm-live" : "pm-pending";
              const noun = stage.kind === "testing" ? "failure" : "comment";
              const title =
                round.verdict === "approve"
                  ? `Round ${round.n}: ${stage.kind === "testing" ? "tests passed" : "approved"}`
                  : round.verdict === "request_changes"
                    ? `Round ${round.n}: ${round.testStatus === "blocked" ? "blocked" : `${round.comments} ${noun}(s)`}`
                    : `Round ${round.n}: in progress`;
              return h("span", { class: `pm-dot ${cls}`, title }, round.verdict === "request_changes" ? String(round.comments) : round.verdict === "approve" ? "✓" : "");
            }),
      ),
    ),
  );
}

export function tasksView(root) {
  const filterBar = h("div", { class: "filters", role: "tablist" });
  const list = h("div", { class: "task-list" });
  const parallel = parallelControl();
  const load = h("span", { class: "muted small" });
  root.append(
    h(
      "div",
      { class: "page-header" },
      h(
        "div",
        {},
        h("h1", {}, "Tasks"),
        h("p", { class: "muted" }, "Pick a task type, or choose Auto and the manager agent reads your request and decides which sub-agents to create: designers, coders, reviewers, test executors and fixers, technical writers. Each agent works on its own branch."),
      ),
      h("div", { class: "page-actions" }, h("div", { class: "parallel-box" }, parallel.el, load), h("a", { class: "btn btn-primary", href: "#/tasks/new" }, "+ New task")),
    ),
    filterBar,
    list,
  );

  function renderLoad() {
    const tasks = [...state.tasks.values()];
    const running = tasks.filter((task) => task.status === "running" || task.status === "needs-input").length;
    const queued = tasks.filter((task) => task.status === "queued").length;
    load.textContent = `${running} running · ${queued} queued`;
  }

  function render() {
    renderLoad();
    const tasks = [...state.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    setContent(
      filterBar,
      FILTERS.map((filter) => {
        const count = tasks.filter(filter.test).length;
        return h(
          "button",
          {
            class: `filter ${currentFilter === filter.id ? "active" : ""}`,
            role: "tab",
            "aria-selected": String(currentFilter === filter.id),
            onclick: () => {
              currentFilter = filter.id;
              render();
            },
          },
          filter.label,
          h("span", { class: "count" }, String(count)),
        );
      }),
    );

    if (!tasks.length) {
      setContent(
        list,
        h(
          "div",
          { class: "empty card" },
          h("h2", {}, "No tasks yet"),
          h("p", { class: "muted" }, state.repos.length ? "Create your first task to start an agent workflow." : "Register a repository, then create a task."),
          h(
            "div",
            { class: "row center" },
            state.repos.length ? null : h("a", { class: "btn", href: "#/repos" }, "Register a repository"),
            h("a", { class: "btn btn-primary", href: "#/tasks/new" }, "New task"),
          ),
        ),
      );
      return;
    }
    const filter = FILTERS.find((candidate) => candidate.id === currentFilter) ?? FILTERS[0];
    const visible = tasks.filter(filter.test);
    if (!visible.length) {
      setContent(list, h("div", { class: "empty muted" }, "No tasks match this filter."));
      return;
    }
    setContent(list, visible.map(taskCard));
  }

  const unsubscribe = subscribe((kind) => {
    if (kind === "tasks" || kind === "repos") render();
    if (kind === "settings") parallel.update();
  });
  const ticker = setInterval(render, 30_000);
  render();
  return () => {
    unsubscribe();
    clearInterval(ticker);
  };
}

function taskCard(task) {
  const status = statusInfo(task);
  const running = task.status === "running" || task.status === "needs-input";
  const budget = task.roundsBudget ?? task.maxRounds;
  return h(
    "a",
    { class: `task-card status-${status.cls}`, href: `#/tasks/${task.id}` },
    h(
      "div",
      { class: "task-card-main" },
      h(
        "div",
        { class: "task-card-top" },
        chip(status.label, status.cls),
        h("span", { class: "task-id mono" }, task.id),
        h("span", { class: "muted" }, `${KIND_LABELS[task.kind]} · ${task.repoName}${task.todoId ? ` · from to-do ${task.todoId}` : ""}`),
      ),
      h("div", { class: "task-title" }, task.title),
      pipelineMini(task),
      agentStrip(task),
      running ? liveLine(task) : resultLine(task),
    ),
    h(
      "div",
      { class: "task-card-side" },
      running && task.currentRound
        ? h("div", { class: "phase" }, `${phaseLabel(task.currentStage, task.phase)} · round ${task.currentRound}/${task.currentRound > budget ? task.currentRound : budget}`)
        : null,
      h("div", { class: "muted small" }, relTime(task.updatedAt)),
    ),
  );
}

/** One pill per sub-agent of the task, colored by its live status. */
export function agentStrip(task) {
  const finished = !["queued", "running", "needs-input"].includes(task.status);
  // Tasks that ran before per-agent tracking have no agent records to show.
  if (finished && !(task.agents ?? []).length) return null;
  const byRole = new Map((task.agents ?? []).map((agent) => [agent.role, agent]));
  return h(
    "div",
    { class: "agent-strip" },
    rolesForTask(task).map((role) => {
      const agent = byRole.get(role);
      const label = !agent && task.status === "completed" ? "Not needed" : agentStatusInfo(agent).label;
      return h(
        "span",
        {
          class: `agent-pill agent-${agent?.status ?? (task.status === "completed" ? "unused" : "pending")}`,
          title: `${ROLE_LABELS[role]}: ${label}${agent?.model ? ` · ${agent.model}` : ""}`,
        },
        h("span", { class: "agent-dot", "aria-hidden": "true" }),
        ROLE_LABELS[role],
      );
    }),
  );
}

function liveLine(task) {
  if (task.status === "needs-input") return h("div", { class: "task-activity attention-text" }, "An agent is waiting for your answer");
  const active = (task.agents ?? []).find((agent) => agent.status === "working");
  if (!active && !task.activity) return null;
  const role = active?.role ?? task.activity?.role;
  const now = task.activity?.role === role ? task.activity.text : active?.lastActivity;
  return h(
    "div",
    { class: "task-activity" },
    roleTag(role),
    h("span", { class: "ellipsis" }, [active?.assignment, now ? `now: ${now}` : null].filter(Boolean).join(" — ")),
  );
}

function resultLine(task) {
  if (task.status === "completed" && isCodeReviewTask(task)) {
    const review = task.review;
    return h(
      "div",
      { class: `task-result ${review?.agreed === false ? "warn" : "ok"}` },
      review?.published ? "✓ Review published" : "✓ Review ready",
      review ? h("span", { class: "muted" }, ` · keeping ${review.kept} of ${review.comments} comment(s)`) : null,
      review?.agreed === true ? h("span", { class: "muted" }, " · both reviewers agree") : review?.agreed === false ? h("span", { class: "muted" }, " · the reviewers disagree on some items") : null,
      review?.pullRequest ? h("span", { class: "result-badge pr", title: review.pullRequest.url ?? "" }, `PR #${review.pullRequest.number}`) : null,
    );
  }
  if (task.status === "completed") {
    const tests = task.tests;
    const testsLast = (task.plan?.stages ?? task.stages.map((stage) => stage.kind)).at(-1) === "testing";
    const testText = tests
      ? ` · tests ${tests.status}${tests.total !== undefined ? ` (${tests.passed ?? tests.total - (tests.failed ?? 0)}/${tests.total})` : ""}`
      : "";
    const push = task.push;
    return h(
      "div",
      { class: `task-result ${task.approved ? "ok" : "warn"}` },
      testsLast ? (task.approved ? "✓ Tests pass" : "Tests failing") : task.approved ? "✓ Approved" : "Not approved",
      task.shortStat ? h("span", { class: "muted" }, ` · ${task.shortStat}`) : null,
      testText ? h("span", { class: "muted" }, testText) : null,
      !task.approved && task.openComments ? h("span", { class: "muted" }, ` · ${task.openComments} ${testsLast ? "failure" : "open comment"}(s)`) : null,
      push?.status === "pushed" ? h("span", { class: "result-badge ok", title: `Pushed to ${push.remote}/${push.branch}` }, "↑ pushed") : null,
      push?.status === "pushing" ? h("span", { class: "result-badge" }, "pushing…") : null,
      push?.status === "failed" ? h("span", { class: "result-badge danger", title: push.reason ?? "" }, "push failed") : null,
      task.pullRequest ? h("span", { class: "result-badge pr", title: task.pullRequest.url }, `PR ${task.pullRequest.number ? `#${task.pullRequest.number}` : "open"}${task.pullRequest.draft ? " (draft)" : ""}`) : null,
    );
  }
  return task.error ? h("div", { class: "task-activity danger ellipsis" }, task.error) : null;
}
