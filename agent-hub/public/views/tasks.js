import { chip, h, KIND_LABELS, phaseLabel, relTime, ROLE_LABELS, setContent, STAGE_LABELS, statusInfo } from "../lib/dom.js";
import { state, subscribe } from "../lib/store.js";

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "active", label: "Active", test: (task) => ["queued", "running", "needs-input"].includes(task.status) },
  { id: "input", label: "Needs input", test: (task) => task.status === "needs-input" },
  { id: "done", label: "Completed", test: (task) => task.status === "completed" },
  { id: "problems", label: "Failed / stopped", test: (task) => ["failed", "cancelled", "interrupted"].includes(task.status) },
];

let currentFilter = "all";

/** Compact stage/round pipeline: one pill per stage, one dot per review round. */
export function pipelineMini(task) {
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
              const live = task.currentStage === stage.kind && task.currentRound === round.n && ["running", "needs-input"].includes(task.status);
              const cls = round.verdict === "approve" ? "pm-approved" : round.verdict === "request_changes" ? "pm-changes" : live ? "pm-live" : "pm-pending";
              const title =
                round.verdict === "approve"
                  ? `Round ${round.n}: approved`
                  : round.verdict === "request_changes"
                    ? `Round ${round.n}: ${round.comments} comment(s)`
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
  root.append(
    h(
      "div",
      { class: "page-header" },
      h("div", {}, h("h1", {}, "Tasks"), h("p", { class: "muted" }, "Each task runs an author agent and a reviewer agent that iterate until the reviewer approves.")),
      h("a", { class: "btn btn-primary", href: "#/tasks/new" }, "+ New task"),
    ),
    filterBar,
    list,
  );

  function render() {
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

  const unsubscribe = subscribe((kind) => (kind === "tasks" || kind === "repos") && render());
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
        h("span", { class: "muted" }, `${KIND_LABELS[task.kind]} · ${task.repoName}`),
      ),
      h("div", { class: "task-title" }, task.title),
      pipelineMini(task),
      running && task.activity
        ? h("div", { class: "task-activity" }, h("span", { class: "role-tag" }, ROLE_LABELS[task.activity.role]), h("span", { class: "ellipsis" }, task.activity.text))
        : task.error
          ? h("div", { class: "task-activity danger ellipsis" }, task.error)
          : null,
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
