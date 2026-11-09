import { get, post, put } from "../lib/api.js";
import { confirmDialog, copyButton, h, setContent, spinner, toast } from "../lib/dom.js";
import { notify, state, subscribe } from "../lib/store.js";
import { loadModels, modelOptions, resetModelsCache } from "./models.js";

export function settingsView(root) {
  const account = h("div", { class: "card" });
  const storage = h("div", { class: "card" }, spinner("Loading…"));
  const authorSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const reviewerSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const resolverSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const managerSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const peerSelect = h("select", { class: "input" }, h("option", {}, "Loading…"));
  const settings = state.settings ?? {};
  const isolation = h(
    "select",
    { class: "input" },
    h("option", { value: "branch", selected: (settings.isolation ?? "branch") === "branch" }, "Own branch per agent (authors share a worktree; reviewers get their own)"),
    h("option", { value: "worktree", selected: settings.isolation === "worktree" }, "Own worktree and branch per agent (most isolation, more disk)"),
  );
  const cleanup = h("input", { type: "checkbox", checked: settings.cleanupWorktrees ?? true });
  const pushOnComplete = h("input", { type: "checkbox", checked: settings.pushOnComplete ?? true });
  const resume = h("input", { type: "checkbox", checked: settings.resumeInterruptedTasks ?? true });
  const rounds = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(settings.maxRounds ?? 3) });
  const concurrency = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(settings.maxConcurrency ?? 10) });
  const docFormat = h(
    "select",
    { class: "input" },
    h("option", { value: "html", selected: (settings.docFormat ?? "html") === "html" }, "HTML – light-themed page with diagrams (recommended)"),
    h("option", { value: "markdown", selected: settings.docFormat === "markdown" }, "Markdown"),
  );
  const docDir = h("input", { class: "input", type: "text", value: settings.designDocDir ?? "docs/designs", spellcheck: "false" });
  const documentDir = h("input", { class: "input", type: "text", value: settings.documentDir ?? "docs", spellcheck: "false" });
  const turnTimeout = h("input", { class: "input", type: "number", min: "5", max: "600", value: String(settings.turnTimeoutMinutes ?? 90) });
  const stuckAfter = h("input", { class: "input", type: "number", min: "3", max: "240", value: String(settings.stuckAgentMinutes ?? 15) });
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
        { class: "grid-2" },
        field("Manager model", managerSelect, "Plans Auto tasks: reads the request and repository and decides which sub-agents to create. Defaults to the author model."),
        field("Author model (designer, writer, coder)", authorSelect),
        field("Comment resolver / test fixer model", resolverSelect, "Resolves code review comments and fixes test failures; defaults to the author model."),
        field("Reviewer / test executor model", reviewerSelect, "Reviews and verifies the authors' work. A different model gives a second opinion. Also the lead reviewer of Code review tasks."),
        field("Peer reviewer model (Code review tasks)", peerSelect, "Reviews alongside the lead reviewer and discusses the findings with it; defaults to the author model. Pick a model other than the reviewer model for a real second opinion."),
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
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "Push"),
          h("span", { class: "row small" }, pushOnComplete, "Push each task's branch to the repository's remote when the task completes"),
          h(
            "small",
            { class: "muted" },
            "Uses your git credentials (never force-pushes). Finished tasks get a Create pull request button: it opens the PR directly when the GitHub CLI is signed in (gh auth login), otherwise the host's create page.",
          ),
        ),
      ),
      h("h2", { class: "section-title" }, "Workflow"),
      h(
        "div",
        { class: "grid-3" },
        field("Max review rounds / test runs", rounds, "Default per task: author/review iterations (or test runs) before stopping."),
        field("Parallel tasks", concurrency, "How many tasks run at the same time (1-10). Tasks beyond this wait in the queue and start as soon as a slot frees up."),
        field("Agent turn timeout (minutes)", turnTimeout, "A turn that runs longer than this is interrupted and recovered like a stuck one."),
        field(
          "Recover a stuck agent after (minutes)",
          stuckAfter,
          "With no sign of activity for this long, the manager interrupts the agent's turn and has it continue; if it is still stuck, it kills the session and restarts the agent with its full assignment.",
        ),
        field("Question timeout (minutes)", inputTimeout, "When an agent asks you something and you don't answer in time, it proceeds on its own."),
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, "After a restart"),
          h("span", { class: "row small" }, resume, "Resume tasks that were running when the hub stopped"),
          h("small", { class: "muted" }, "They continue from their last completed step once the hub is signed in."),
        ),
      ),
      h("h2", { class: "section-title" }, "Documents"),
      h(
        "div",
        { class: "grid-3" },
        field("Format for design and document tasks", docFormat, "HTML documents start from the hub's light-themed template and render Mermaid diagrams."),
        field("Design document folder", docDir, "Relative to the repository root."),
        field("Document folder", documentDir, "Where Document tasks write, relative to the repository root."),
      ),
      h("div", { class: "row end" }, saveButton),
    ),
    h("h2", { class: "section-title" }, "Storage"),
    storage,
    h("h2", { class: "section-title" }, "About"),
    h(
      "div",
      { class: "card" },
      h(
        "dl",
        { class: "storage-list" },
        h("dt", {}, "Version"),
        h("dd", { class: "mono small" }, state.build ? `v${state.build.version}` : "unknown"),
        h("dt", {}, "Commit"),
        h(
          "dd",
          {},
          h("span", { class: "mono small" }, state.build?.commit ?? "not a git checkout"),
          h("div", { class: "muted small" }, "The hub's code; +changes means its files differ from that commit. Each task's timeline shows the version it started on."),
        ),
        h("dt", {}, "UI build"),
        h(
          "dd",
          {},
          h("span", { class: "mono small" }, state.build?.ui ?? "unknown"),
          h("div", { class: "muted small" }, "When the hub is updated while this page is open, a banner asks you to reload it."),
        ),
      ),
    ),
  );

  async function renderStorage() {
    try {
      const info = await get("/api/storage");
      setContent(
        storage,
        h("p", { class: "muted small" }, `Everything the hub knows is saved on this machine under ${info.dataDir}: ${info.repos} repositories, ${info.tasks} tasks, ${info.todos ?? 0} to-dos and ${info.commEntries} manager messages. Tasks keep their last state across restarts.`),
        h(
          "dl",
          { class: "storage-list" },
          info.files.map((file) => [
            h("dt", {}, file.label),
            h("dd", {}, h("span", { class: "mono small break" }, file.path), " ", copyButton(file.path), h("div", { class: "muted small" }, file.description)),
          ]),
        ),
      );
    } catch (error) {
      setContent(storage, h("div", { class: "callout callout-danger" }, error.message));
    }
  }

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
      setContent(managerSelect, h("option", { value: "" }, "Same as author model"), modelOptions(models, state.settings?.managerModel));
      setContent(peerSelect, h("option", { value: "" }, "Same as author model"), modelOptions(models, state.settings?.peerReviewerModel));
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
        managerModel: managerSelect.value || null,
        peerReviewerModel: peerSelect.value || null,
        isolation: isolation.value,
        cleanupWorktrees: cleanup.checked,
        pushOnComplete: pushOnComplete.checked,
        resumeInterruptedTasks: resume.checked,
        maxRounds: Number(rounds.value),
        maxConcurrency: Number(concurrency.value),
        docFormat: docFormat.value,
        designDocDir: docDir.value,
        documentDir: documentDir.value,
        turnTimeoutMinutes: Number(turnTimeout.value),
        stuckAgentMinutes: Number(stuckAfter.value),
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
  renderStorage();
  fillModels(false);
  return subscribe((kind) => {
    if (kind === "auth") renderAccount();
    // Parallel tasks can be changed live from the Tasks and Agents pages (or another tab).
    if (kind === "settings" && document.activeElement !== concurrency && state.settings?.maxConcurrency) concurrency.value = String(state.settings.maxConcurrency);
  });
}
