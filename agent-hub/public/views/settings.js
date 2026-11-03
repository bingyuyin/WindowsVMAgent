import { post, put } from "../lib/api.js";
import { confirmDialog, h, setContent, spinner, toast } from "../lib/dom.js";
import { notify, state, subscribe } from "../lib/store.js";
import { loadModels, modelOptions, resetModelsCache } from "./models.js";

export function settingsView(root) {
  const account = h("div", { class: "card" });
  const authorSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const reviewerSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const resolverSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const settings = state.settings ?? {};
  const isolation = h(
    "select",
    { class: "input" },
    h("option", { value: "branch", selected: (settings.isolation ?? "branch") === "branch" }, "Own branch per agent (authors share a worktree; reviewers get their own)"),
    h("option", { value: "worktree", selected: settings.isolation === "worktree" }, "Own worktree and branch per agent (most isolation, more disk)"),
  );
  const cleanup = h("input", { type: "checkbox", checked: settings.cleanupWorktrees ?? true });
  const rounds = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(settings.maxRounds ?? 3) });
  const concurrency = h("input", { class: "input", type: "number", min: "1", max: "8", value: String(settings.maxConcurrency ?? 2) });
  const docDir = h("input", { class: "input", type: "text", value: settings.designDocDir ?? "docs/designs", spellcheck: "false" });
  const turnTimeout = h("input", { class: "input", type: "number", min: "5", max: "600", value: String(settings.turnTimeoutMinutes ?? 90) });
  const inputTimeout = h("input", { class: "input", type: "number", min: "1", max: "1440", value: String(settings.inputTimeoutMinutes ?? 30) });
  const saveButton = h("button", { class: "btn btn-primary", type: "submit" }, "Save settings");
  const refreshButton = h("button", { class: "btn btn-sm", type: "button", onclick: () => fillModels(true) }, "Refresh model list");

  const field = (label, input, help) => h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, help ? h("small", { class: "muted" }, help) : null);

  root.append(
    h("div", { class: "page-header" }, h("div", {}, h("h1", {}, "Settings"))),
    h("h2", { class: "section-title" }, "Account"),
    account,
    h(
      "form",
      { class: "card form", onsubmit: save },
      h("div", { class: "row between" }, h("h2", { class: "section-title" }, "Models"), refreshButton),
      h(
        "div",
        { class: "grid-3" },
        field("Author model (designer, coder)", authorSelect),
        field("Comment resolver model", resolverSelect, "Resolves code review comments; defaults to the author model."),
        field("Reviewer model (design and code reviewers)", reviewerSelect, "A different model for reviews gives a second opinion."),
      ),
      h("h2", { class: "section-title" }, "Workspaces"),
      h(
        "div",
        { class: "grid-2" },
        field("Agent isolation", isolation, "Every sub-agent works on its own branch; tasks on the same repository never share a worktree."),
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Cleanup"),
          h("span", { class: "row small" }, cleanup, "Remove agent worktrees when a task completes (branches are kept)"),
          h("small", { class: "muted" }, "Failed or cancelled tasks keep their worktrees so you can inspect or retry them."),
        ),
      ),
      h("h2", { class: "section-title" }, "Workflow"),
      h(
        "div",
        { class: "grid-3" },
        field("Max review rounds", rounds, "Default per task: author/review iterations before stopping."),
        field("Parallel tasks", concurrency, "How many tasks run at the same time."),
        field("Design document folder", docDir, "Relative to the repository root."),
        field("Agent turn timeout (minutes)", turnTimeout, "Fails a turn that runs longer than this."),
        field("Question timeout (minutes)", inputTimeout, "When an agent asks you something and you don't answer in time, it proceeds on its own."),
      ),
      h("div", { class: "row end" }, saveButton),
    ),
  );

  function renderAccount() {
    const auth = state.auth ?? {};
    setContent(
      account,
      h(
        "div",
        { class: "row between wrap" },
        h(
          "div",
          {},
          h("div", {}, auth.authenticated ? ["Signed in as ", h("strong", {}, auth.login ?? "unknown")] : "Not signed in"),
          h("div", { class: "muted small" }, [auth.host, auth.authType ? `auth: ${auth.authType}` : null, auth.runtimeVersion ? `Copilot runtime ${auth.runtimeVersion}` : null].filter(Boolean).join(" · ")),
        ),
        auth.authenticated ? h("button", { class: "btn btn-danger-outline", type: "button", onclick: signOut }, "Sign out") : h("a", { class: "btn btn-primary", href: "#/login" }, "Sign in"),
      ),
    );
  }

  async function fillModels(force) {
    refreshButton.disabled = true;
    try {
      const models = await loadModels(force);
      setContent(authorSelect, modelOptions(models, state.settings?.authorModel));
      setContent(reviewerSelect, modelOptions(models, state.settings?.reviewerModel));
      setContent(resolverSelect, h("option", { value: "" }, "Same as author model"), modelOptions(models, state.settings?.resolverModel));
      if (force) toast("Model list refreshed", "success");
    } catch (error) {
      toast(`Could not load models: ${error.message}`, "error");
    } finally {
      refreshButton.disabled = false;
    }
  }

  async function save(event) {
    event.preventDefault();
    saveButton.disabled = true;
    try {
      state.settings = await put("/api/settings", {
        authorModel: authorSelect.value,
        reviewerModel: reviewerSelect.value,
        resolverModel: resolverSelect.value || null,
        isolation: isolation.value,
        cleanupWorktrees: cleanup.checked,
        maxRounds: Number(rounds.value),
        maxConcurrency: Number(concurrency.value),
        designDocDir: docDir.value,
        turnTimeoutMinutes: Number(turnTimeout.value),
        inputTimeoutMinutes: Number(inputTimeout.value),
      });
      notify("settings");
      toast("Settings saved", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      saveButton.disabled = false;
    }
  }

  async function signOut() {
    const ok = await confirmDialog({
      title: "Sign out?",
      body: h("p", {}, "This removes the stored GitHub credential for this account from the hub's Copilot runtime. Running tasks must be finished or cancelled first."),
      confirmText: "Sign out",
      danger: true,
    });
    if (!ok) return;
    setContent(account, spinner("Signing out…"));
    try {
      await post("/api/auth/logout");
      resetModelsCache();
    } catch (error) {
      toast(error.message, "error");
      renderAccount();
    }
  }

  renderAccount();
  fillModels(false);
  return subscribe((kind) => kind === "auth" && renderAccount());
}
