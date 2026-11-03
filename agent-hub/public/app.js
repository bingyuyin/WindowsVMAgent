import { get } from "./lib/api.js";
import { clear, h, setContent, spinner } from "./lib/dom.js";
import { needsModels, notify, state, subscribe } from "./lib/store.js";
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
  const [tasks, repos] = await Promise.all([get("/api/tasks"), get("/api/repos")]);
  state.tasks = new Map(tasks.map((task) => [task.id, task]));
  state.repos = repos;
  notify("tasks");
  notify("repos");
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
        notify("tasks");
        break;
      case "repos":
        state.repos = data.repos;
        notify("repos");
        break;
    }
  };
}

subscribe((kind) => {
  if (kind === "auth" || kind === "settings" || kind === "connection") renderAccount();
  if (kind === "auth" || kind === "settings") route();
});

async function boot() {
  route();
  try {
    const [auth, settings] = await Promise.all([get("/api/auth"), get("/api/settings")]);
    state.auth = auth;
    state.settings = settings;
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
