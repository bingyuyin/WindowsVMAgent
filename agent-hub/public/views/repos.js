import { del, post } from "../lib/api.js";
import { confirmDialog, h, relTime, setContent, toast } from "../lib/dom.js";
import { notify, state, subscribe } from "../lib/store.js";

export function reposView(root) {
  let mode = "path";
  const list = h("div", { class: "card" });
  const pathInput = h("input", { class: "input", type: "text", placeholder: "C:\\src\\my-repo  or  /home/me/src/my-repo", spellcheck: "false" });
  const urlInput = h("input", { class: "input", type: "text", placeholder: "https://github.com/owner/repo.git", spellcheck: "false" });
  const destInput = h("input", { class: "input", type: "text", placeholder: "Optional – defaults to the hub's data/repos folder", spellcheck: "false" });
  const nameInput = h("input", { class: "input", type: "text", placeholder: "Optional display name" });
  const submitButton = h("button", { class: "btn btn-primary", type: "submit" }, "Register");
  const modeBar = h("div", { class: "seg" });
  const fields = h("div", { class: "stack" });

  root.append(
    h(
      "div",
      { class: "page-header" },
      h("div", {}, h("h1", {}, "Repositories"), h("p", { class: "muted" }, "Register the git repositories agents may work on. Tasks run in isolated worktrees; your checkout is never modified.")),
    ),
    h("form", { class: "card form", onsubmit: submit }, h("h2", { class: "section-title" }, "Register a repository"), modeBar, fields, h("div", { class: "row end" }, submitButton)),
    h("h2", { class: "section-title" }, "Registered repositories"),
    list,
  );

  function renderForm() {
    setContent(
      modeBar,
      [
        ["path", "Local path"],
        ["clone", "Clone from URL"],
      ].map(([id, label]) =>
        h(
          "button",
          {
            type: "button",
            class: `seg-item ${mode === id ? "active" : ""}`,
            onclick: () => {
              mode = id;
              renderForm();
            },
          },
          label,
        ),
      ),
    );
    setContent(
      fields,
      mode === "path"
        ? h("label", { class: "field" }, h("span", { class: "field-label" }, "Local repository path"), pathInput)
        : [
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Clone URL (https or ssh)"), urlInput),
            h("label", { class: "field" }, h("span", { class: "field-label" }, "Destination folder"), destInput),
          ],
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Name"), nameInput),
    );
    submitButton.textContent = mode === "path" ? "Register" : "Clone and register";
  }

  async function submit(event) {
    event.preventDefault();
    const body = mode === "path" ? { path: pathInput.value.trim() } : { cloneUrl: urlInput.value.trim(), path: destInput.value.trim() || undefined };
    if (!body.path && !body.cloneUrl) {
      toast(mode === "path" ? "Enter a repository path" : "Enter a clone URL", "error");
      return;
    }
    body.name = nameInput.value.trim() || undefined;
    submitButton.disabled = true;
    const label = submitButton.textContent;
    submitButton.textContent = mode === "path" ? "Registering…" : "Cloning…";
    try {
      const repo = await post("/api/repos", body);
      if (!state.repos.some((candidate) => candidate.id === repo.id)) state.repos = [...state.repos, repo];
      notify("repos");
      toast(`Registered ${repo.name}`, "success");
      pathInput.value = urlInput.value = destInput.value = nameInput.value = "";
    } catch (error) {
      toast(error.message, "error");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = label;
    }
  }

  async function remove(repo) {
    const ok = await confirmDialog({
      title: `Unregister ${repo.name}?`,
      body: h("p", {}, "The repository files are not touched; it is only removed from the hub."),
      confirmText: "Unregister",
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/api/repos/${encodeURIComponent(repo.id)}`);
      state.repos = state.repos.filter((candidate) => candidate.id !== repo.id);
      notify("repos");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function renderList() {
    if (!state.repos.length) {
      setContent(list, h("div", { class: "empty muted" }, "No repositories registered yet."));
      return;
    }
    const taskCounts = new Map();
    for (const task of state.tasks.values()) taskCounts.set(task.repoId, (taskCounts.get(task.repoId) ?? 0) + 1);
    setContent(
      list,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Path"), h("th", {}, "Default branch"), h("th", {}, "Remote"), h("th", { class: "num" }, "Tasks"), h("th", {}))),
          h(
            "tbody",
            {},
            state.repos.map((repo) =>
              h(
                "tr",
                {},
                h("td", {}, h("strong", {}, repo.name), h("div", { class: "muted small" }, `added ${relTime(repo.addedAt)}`)),
                h("td", { class: "mono small break" }, repo.path),
                h("td", { class: "mono small" }, repo.defaultBranch),
                h("td", { class: "mono small break" }, repo.remoteUrl ?? "—"),
                h("td", { class: "num" }, String(taskCounts.get(repo.id) ?? 0)),
                h("td", { class: "right" }, h("button", { class: "btn btn-sm btn-ghost-danger", onclick: () => remove(repo) }, "Unregister")),
              ),
            ),
          ),
        ),
      ),
    );
  }

  renderForm();
  renderList();
  return subscribe((kind) => (kind === "repos" || kind === "tasks") && renderList());
}
