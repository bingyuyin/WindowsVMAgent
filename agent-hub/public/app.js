import { get, setUiBuild } from "./lib/api.js";
import { clear, h, setContent, spinner } from "./lib/dom.js";
import { mergeComm, needsModels, notify, state, subscribe } from "./lib/store.js";
import { agentsView } from "./views/agents.js";
import { loginView } from "./views/login.js";
import { modelsView, resetModelsCache } from "./views/models.js";
import { newTaskView } from "./views/newTask.js";
import { reposView } from "./views/repos.js";
import { settingsView } from "./views/settings.js";
import { taskDetailView } from "./views/taskDetail.js";
import { tasksView } from "./views/tasks.js";

const app = document.getElementById("app");
const nav = document.getElementById("nav");
const account = document.getElementById("account");

const ROUTES = [
  { pattern: /^#\/login$/, view: loginView, public: true },
  { pattern: /^#\/models$/, view: modelsView },
  { pattern: /^#\/tasks\/new$/, view: newTaskView, nav: "tasks" },
  { pattern: /^#\/tasks\/([\w-]+)$/, view: taskDetailView, nav: "tasks" },
  { pattern: /^#\/tasks$/, view: tasksView, nav: "tasks" },
  { pattern: /^#\/agents$/, view: agentsView, nav: "agents", wide: true },
  { pattern: /^#\/repos$/, view: reposView, nav: "repos" },
  { pattern: /^#\/settings$/, view: settingsView, nav: "settings" },
];

let current = { key: null, dispose: null };

function route() {
  const hash = location.hash || "#/tasks";
  const auth = state.auth;
  if (!auth || !state.settings) {
    show("splash", () => setContent(app, h("div", { class: "splash" }, spinner("Connecting to Agent Hub…"))));
    return;
  }
  if (!auth.authenticated) {
    if (hash !== "#/login") return location.replace("#/login");
  } else if (hash === "#/login") {
    return location.replace(needsModels() ? "#/models" : "#/tasks");
  } else if (needsModels() && hash !== "#/models" && hash !== "#/settings") {
    return location.replace("#/models");
  }
  const match = ROUTES.map((candidate) => ({ candidate, result: candidate.pattern.exec(hash) })).find((entry) => entry.result);
  if (!match) return location.replace("#/tasks");
  for (const link of nav.querySelectorAll("a")) link.classList.toggle("active", link.dataset.nav === match.candidate.nav);
  nav.hidden = !auth.authenticated;
  app.classList.toggle("container-wide", Boolean(match.candidate.wide));
  show(hash, () => match.candidate.view(app, { params: match.result.slice(1) }));
}

function show(key, render) {
  if (current.key === key) return;
  current.dispose?.();
  clear(app);
  window.scrollTo(0, 0);
  const result = render();
  current = { key, dispose: typeof result === "function" ? result : null };
}

function renderAccount() {
  const auth = state.auth;
  const connection = h("span", {
    class: `dot ${state.connected ? "dot-success" : "dot-danger"}`,
    title: state.connected ? "Live updates connected" : "Live updates disconnected – reconnecting…",
  });
  if (!auth?.authenticated) {
    setContent(account, connection);
    return;
  }
  const model = state.settings?.authorModel;
  setContent(
    account,
    connection,
    model ? h("a", { class: "account-model mono", href: "#/settings", title: "Default models" }, model) : null,
    h("a", { class: "account-user", href: "#/settings", title: `Signed in to ${auth.host ?? "GitHub"}` }, h("span", { class: "avatar", "aria-hidden": "true" }, (auth.login ?? "?").slice(0, 1).toUpperCase()), auth.login ?? "signed in"),
  );
}

async function refreshData() {
  const [tasks, repos, overview] = await Promise.all([get("/api/tasks"), get("/api/repos"), get("/api/agents/overview?limit=400")]);
  state.tasks = new Map(tasks.map((task) => [task.id, task]));
  state.repos = repos;
  state.comm = [];
  mergeComm(overview.comm);
  state.manager = { monitorIntervalSec: overview.monitorIntervalSec, lastCheckAt: overview.lastCheckAt, startedAt: overview.startedAt };
  notify("tasks");
  notify("repos");
  notify("comm");
  notify("manager");
}

function connect() {
  let hellos = 0;
  const stream = new EventSource("/api/stream");
  stream.onopen = () => {
    state.connected = true;
    notify("connection");
  };
  stream.onerror = () => {
    state.connected = false;
    notify("connection");
  };
  stream.onmessage = (message) => {
    const data = JSON.parse(message.data);
    switch (data.type) {
      case "hello":
        state.auth = data.auth;
        state.settings = data.settings;
        // The hub restarted with other UI files (it was updated): this page still runs the previous version.
        if (data.build?.ui && state.build?.ui && data.build.ui !== state.build.ui) showUpdateBanner(data.build);
        // After a reconnect, re-sync everything that may have changed while we were offline.
        if (hellos++ > 0) refreshData().catch(() => undefined);
        notify("auth");
        notify("settings");
        break;
      case "auth": {
        const wasAuthenticated = state.auth?.authenticated;
        state.auth = data.auth;
        if (wasAuthenticated !== data.auth.authenticated) {
          resetModelsCache();
          if (data.auth.authenticated) refreshData().catch(() => undefined);
        }
        notify("auth");
        break;
      }
      case "settings":
        state.settings = data.settings;
        notify("settings");
        break;
      case "task":
        state.tasks.set(data.task.id, data.task);
        notify("tasks");
        break;
      case "task-removed":
        state.tasks.delete(data.id);
        state.comm = state.comm.filter((entry) => entry.taskId !== data.id);
        notify("tasks");
        break;
      case "repos":
        state.repos = data.repos;
        notify("repos");
        break;
      case "comm":
        if (mergeComm([data.entry]).length) notify("comm", data.entry);
        break;
      case "manager":
        state.manager = { ...state.manager, lastCheckAt: data.lastCheckAt };
        notify("manager");
        break;
    }
  };
}

subscribe((kind) => {
  if (kind === "auth" || kind === "settings" || kind === "connection") renderAccount();
  if (kind === "auth" || kind === "settings") route();
});

const describeBuild = (build) => (build ? `v${build.version}${build.commit ? ` (${build.commit})` : ""}` : "");

/** The hub now serves newer UI files than this page runs: everything this page shows or sends may be out of date. */
function showUpdateBanner(build) {
  if (document.getElementById("update-banner")) return;
  const from = describeBuild(state.build);
  const to = describeBuild(build);
  document.body.prepend(
    h(
      "div",
      { id: "update-banner", class: "update-banner", role: "alert" },
      h("strong", {}, "Agent Hub was updated."),
      h(
        "span",
        {},
        ` This page still runs the previous version${from && to && from !== to ? ` (${from}; the hub now runs ${to})` : ""}, so new features are missing and results may show wrongly. Reload to use the new version.`,
      ),
      h("button", { class: "btn btn-sm btn-primary", onclick: () => location.reload() }, "Reload now"),
    ),
  );
}

async function boot() {
  route();
  try {
    const [auth, settings, build] = await Promise.all([get("/api/auth"), get("/api/settings"), get("/api/health")]);
    state.auth = auth;
    state.settings = settings;
    state.build = build;
    setUiBuild(build.ui, () => showUpdateBanner(null));
    document.querySelector(".brand")?.setAttribute("title", `Copilot Agent Hub ${describeBuild(build)}`);
    await refreshData();
  } catch (error) {
    setContent(app, h("div", { class: "callout callout-danger" }, `Could not reach the hub: ${error.message}`));
    return;
  }
  window.addEventListener("hashchange", route);
  connect();
  renderAccount();
  route();
}

boot();
