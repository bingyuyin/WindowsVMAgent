import { get, post } from "../lib/api.js";
import { confirmDialog, h, setContent, spinner, toast } from "../lib/dom.js";
import { state, subscribe } from "../lib/store.js";

const REPO_KEY = "agent-hub.sync-repo";
/** The branch name this browser last pushed to: pushing there again needs no confirmation. */
const NAME_KEY = "agent-hub.sync-name";

const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const withoutCredentials = (url) => String(url ?? "").replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1");

/** What loading does with the tasks (or to-dos) of a branch, in words. */
function describeCounts(counts, noun) {
  const parts = [
    counts.added ? `${plural(counts.added, noun)} added${counts.renumbered ? ` (${counts.renumbered} under new ids, theirs are taken here)` : ""}` : null,
    counts.updated ? `${plural(counts.updated, noun)} updated (newer on the branch)` : null,
    counts.unchanged ? `${plural(counts.unchanged, noun)} already up to date` : null,
    counts.keptNewer ? `${plural(counts.keptNewer, noun)} newer here, kept` : null,
    counts.keptBusy ? `${plural(counts.keptBusy, noun)} in progress here, kept` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `no ${noun}s`;
}

/**
 * Settings → Data sync: pushes the hub's tasks, to-dos and manager log to a task_data/<name> branch on a repository's
 * remote, and loads such a branch (merge or replace).
 */
export function dataSyncSection() {
  let prefix = "task_data/";
  let branchesShown = false;
  let current = null;

  const repoSelect = h("select", { class: "input", "aria-label": "Repository" });
  const remoteNote = h("small", { class: "muted" });
  const prefixLabel = h("span", { class: "branch-prefix mono" }, prefix);
  const nameInput = h("input", { class: "input mono", type: "text", spellcheck: "false", maxlength: "100", placeholder: "devbox", "aria-label": "Branch name" });
  const pushNote = h("small", { class: "muted" });
  const pushButton = h("button", { class: "btn btn-primary", type: "submit" }, "Push data");
  const pushResult = h("div", { hidden: true });
  const listButton = h("button", { class: "btn", type: "button", onclick: listBranches }, "List branches");
  const branchList = h("div", { class: "sync-branches" });
  const previewBox = h("div", { class: "sync-preview", hidden: true });
  const loadResult = h("div", { hidden: true });
  const noRepos = h(
    "div",
    { class: "callout callout-warning small", hidden: true },
    "Data branches live on a repository's remote. Register a repository that has a remote first. ",
    h("a", { href: "#/repos" }, "Go to Repositories →"),
  );

  const el = h(
    "div",
    { class: "card sync-card" },
    h(
      "p",
      { class: "muted small" },
      "Push this hub's tasks (state, timeline and document snapshots), to-dos and manager log to a branch on a repository's remote, then load them on another machine, or keep the branch as a backup. Settings, repositories and agent worktrees stay on each machine.",
    ),
    h(
      "div",
      { class: "callout callout-warning small" },
      "Anyone who can read the repository can read the pushed data: task requests, agent conversations, diffs and test output. Use a private repository.",
    ),
    noRepos,
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Repository"), repoSelect, remoteNote),
    h(
      "div",
      { class: "grid-2 sync-panes" },
      h(
        "form",
        { class: "sync-pane", onsubmit: push },
        h("h3", {}, "Push to a branch"),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Branch"), h("div", { class: "branch-input" }, prefixLabel, nameInput), pushNote),
        h("div", { class: "row end" }, pushButton),
        pushResult,
      ),
      h(
        "div",
        { class: "sync-pane" },
        h("h3", {}, "Load from a branch"),
        h(
          "p",
          { class: "muted small" },
          h("strong", {}, "Merge"),
          " adds the branch's new tasks and to-dos and updates those that are newer there; tasks in progress here are kept. ",
          h("strong", {}, "Replace"),
          " backs this hub's data up, deletes its tasks and loads the branch's.",
        ),
        h("div", { class: "row" }, listButton),
        branchList,
        previewBox,
        loadResult,
      ),
    ),
  );

  const repo = () => state.repos.find((candidate) => candidate.id === repoSelect.value);

  function renderRepos() {
    const chosen = repoSelect.value || localStorage.getItem(REPO_KEY);
    const repos = state.repos;
    noRepos.hidden = repos.length > 0;
    for (const control of [repoSelect, nameInput, pushButton, listButton]) control.disabled = repos.length === 0;
    if (!repos.length) {
      setContent(repoSelect, h("option", { value: "" }, "No repositories registered"));
      remoteNote.textContent = "";
      return;
    }
    setContent(
      repoSelect,
      repos.map((candidate) => h("option", { value: candidate.id }, candidate.remoteUrl ? candidate.name : `${candidate.name} (no remote known)`)),
    );
    const fallback = repos.find((candidate) => candidate.remoteUrl) ?? repos[0];
    repoSelect.value = repos.some((candidate) => candidate.id === chosen) ? chosen : fallback.id;
    renderRemote();
  }

  function renderRemote(remote) {
    const url = remote?.url ?? repo()?.remoteUrl;
    remoteNote.textContent = url ? `Data branches live on its remote${remote ? ` ${remote.name}` : ""}: ${withoutCredentials(url)}` : "Data branches live on its remote (origin, or its only remote).";
  }

  function renderCounts() {
    pushNote.textContent = `Pushes ${plural(state.tasks.size, "task")} and ${plural(state.todos.length, "to-do")}. Pushing again adds a commit on top: the branch keeps the earlier versions.`;
  }

  function reset() {
    branchesShown = false;
    current = null;
    setContent(branchList);
    previewBox.hidden = true;
    loadResult.hidden = true;
    pushResult.hidden = true;
  }

  function showResult(box, kind, text, link) {
    box.hidden = false;
    box.className = `callout callout-${kind} small sync-result`;
    setContent(box, text, link ? [" ", h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "View the branch ↗")] : null);
  }

  async function push(event) {
    event.preventDefault();
    const name = nameInput.value.trim().replace(/^task_data\//, "");
    if (!name) {
      toast("Enter a name for the branch, for example this machine's name", "error");
      nameInput.focus();
      return;
    }
    pushButton.disabled = true;
    pushButton.textContent = "Checking…";
    try {
      // Pushing to a branch another machine pushed to puts this hub's data on top of it: say so first.
      if (name !== localStorage.getItem(NAME_KEY)) {
        const { branches } = await get(`/api/sync/branches?repoId=${encodeURIComponent(repoSelect.value)}`);
        const existing = branches.find((branch) => branch.name === name);
        if (existing) {
          const ok = await confirmDialog({
            title: `Push to the existing branch ${existing.branch}?`,
            body: h(
              "div",
              {},
              h("p", {}, "The branch will then hold this hub's data. The data it holds now stays in its history."),
              h("p", { class: "muted small" }, "To combine both, load the branch with Merge first, then push."),
            ),
            confirmText: "Push",
          });
          if (!ok) return;
        }
      }
      pushButton.textContent = "Pushing…";
      const result = await post("/api/sync/push", { repoId: repoSelect.value, name });
      localStorage.setItem(NAME_KEY, name);
      localStorage.setItem(REPO_KEY, repoSelect.value);
      showResult(pushResult, result.unchanged ? "info" : "success", `${result.summary}.`, result.webUrl);
      toast(result.unchanged ? "The branch already has this data" : `Pushed to ${result.branch}`, "success");
      if (branchesShown) listBranches();
    } catch (error) {
      showResult(pushResult, "danger", error.message);
    } finally {
      pushButton.disabled = false;
      pushButton.textContent = "Push data";
    }
  }

  async function listBranches() {
    listButton.disabled = true;
    previewBox.hidden = true;
    loadResult.hidden = true;
    current = null;
    setContent(branchList, spinner("Listing the data branches…"));
    try {
      const { remote, branches } = await get(`/api/sync/branches?repoId=${encodeURIComponent(repoSelect.value)}`);
      branchesShown = true;
      localStorage.setItem(REPO_KEY, repoSelect.value);
      renderRemote(remote);
      if (!branches.length) {
        setContent(branchList, h("div", { class: "muted small sync-empty" }, `No ${prefix} branches on ${remote.name} yet. Push this hub's data to create one.`));
        return;
      }
      setContent(
        branchList,
        h(
          "ul",
          { class: "sync-branch-list" },
          branches.map((branch) =>
            h(
              "li",
              { dataset: { branch: branch.branch } },
              h("span", { class: "mono sync-branch-name" }, branch.branch),
              h("span", { class: "mono muted small" }, branch.sha.slice(0, 10)),
              branch.webUrl ? h("a", { class: "small", href: branch.webUrl, target: "_blank", rel: "noopener noreferrer" }, "view ↗") : null,
              h("button", { class: "btn btn-sm", type: "button", onclick: () => preview(branch) }, "Load…"),
            ),
          ),
        ),
      );
    } catch (error) {
      setContent(branchList, h("div", { class: "callout callout-danger small" }, error.message));
    } finally {
      listButton.disabled = false;
    }
  }

  async function preview(branch) {
    loadResult.hidden = true;
    previewBox.hidden = false;
    current = null;
    setContent(previewBox, spinner(`Reading ${branch.branch}…`));
    try {
      current = await get(`/api/sync/preview?repoId=${encodeURIComponent(repoSelect.value)}&name=${encodeURIComponent(branch.name)}`);
      renderPreview();
    } catch (error) {
      setContent(previewBox, h("div", { class: "callout callout-danger small" }, error.message));
    }
  }

  function renderPreview(busy) {
    const p = current;
    if (!p) return;
    const m = p.manifest;
    const blocked = p.replace.blockedBy;
    const unknown = p.repositories.filter((entry) => !entry.localId);
    const renamed = p.repositories.filter((entry) => entry.localId && entry.localId !== entry.id);
    const pushed = p.pushedAt ? ` on ${new Date(p.pushedAt).toLocaleString()}` : "";
    setContent(
      previewBox,
      h("div", { class: "sync-preview-head" }, h("strong", { class: "mono" }, p.branch), " ", h("span", { class: "mono muted small" }, p.sha.slice(0, 10))),
      h(
        "div",
        { class: "muted small" },
        `Pushed from ${m.host}${pushed} by hub v${m.hub.version}${m.hub.commit ? ` (${m.hub.commit})` : ""}: ${plural(p.replace.tasks, "task")}, ${plural(p.replace.todos, "to-do")}, ${plural(p.replace.managerMessages, "manager message")}.`,
      ),
      p.skipped ? h("div", { class: "callout callout-warning small" }, `${plural(p.skipped, "record")} on the branch ${p.skipped === 1 ? "is" : "are"} not valid and will be left out.`) : null,
      h(
        "dl",
        { class: "storage-list sync-plan" },
        h("dt", {}, "Merge"),
        h("dd", {}, `${describeCounts(p.merge.tasks, "task")}; ${describeCounts(p.merge.todos, "to-do")}; ${plural(p.merge.managerMessages, "manager message")} added.`),
        h("dt", {}, "Replace"),
        h(
          "dd",
          {},
          `This hub's ${plural(p.replace.removes.tasks, "task")} and ${plural(p.replace.removes.todos, "to-do")} are backed up and deleted (task branches stay in the repositories); the branch's ${plural(p.replace.tasks, "task")} and ${plural(p.replace.todos, "to-do")} are loaded.`,
          blocked.length ? h("div", { class: "attention-text small" }, `Not possible while ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} in progress: cancel ${blocked.length === 1 ? "it" : "them"} or let ${blocked.length === 1 ? "it" : "them"} finish.`) : null,
        ),
        renamed.length || unknown.length ? h("dt", {}, "Repositories") : null,
        renamed.length || unknown.length
          ? h(
              "dd",
              {},
              renamed.map((entry) => h("div", { class: "small" }, `${entry.name} is ${entry.localId} here`)),
              unknown.map((entry) =>
                h(
                  "div",
                  { class: "small attention-text" },
                  `${entry.name} is not registered here (${[entry.tasks ? plural(entry.tasks, "task") : null, entry.todos ? plural(entry.todos, "to-do") : null].filter(Boolean).join(", ")}): its tasks load as records; register it to work on them again.`,
                ),
              ),
            )
          : null,
      ),
      h(
        "div",
        { class: "row end" },
        h("button", { class: "btn", type: "button", disabled: Boolean(busy), onclick: close }, "Close"),
        h(
          "button",
          { class: "btn btn-danger-outline", type: "button", disabled: Boolean(busy) || blocked.length > 0, onclick: () => load("replace") },
          busy === "replace" ? "Replacing…" : "Replace this hub's data…",
        ),
        h("button", { class: "btn btn-primary", type: "button", disabled: Boolean(busy), onclick: () => load("merge") }, busy === "merge" ? "Merging…" : "Merge into this hub"),
      ),
    );
  }

  function close() {
    current = null;
    previewBox.hidden = true;
  }

  async function load(mode) {
    const p = current;
    if (!p) return;
    if (mode === "replace") {
      const ok = await confirmDialog({
        title: `Replace this hub's data with ${p.branch}?`,
        body: h(
          "div",
          {},
          h("p", {}, `This hub's ${plural(p.replace.removes.tasks, "task")}, ${plural(p.replace.removes.todos, "to-do")} and manager log are replaced by the branch's ${plural(p.replace.tasks, "task")} and ${plural(p.replace.todos, "to-do")}.`),
          h("p", {}, "The current data is backed up first (Settings → Storage → Backups). The tasks here are deleted like with Delete: their worktrees and agent branches are removed, their task branches stay in the repositories."),
        ),
        confirmText: "Replace data",
        danger: true,
      });
      if (!ok) return;
    }
    renderPreview(mode);
    try {
      const result = await post("/api/sync/load", { repoId: repoSelect.value, name: p.branch, mode, sha: p.sha });
      current = null;
      previewBox.hidden = true;
      const unknown = result.repositories.filter((entry) => !entry.localId).map((entry) => entry.name);
      showResult(
        loadResult,
        "success",
        [
          `${result.summary}.`,
          result.backup ? ` The previous data is backed up in ${result.backup}.` : "",
          unknown.length ? ` Not registered here: ${unknown.join(", ")}; register ${unknown.length === 1 ? "it" : "them"} to work on ${unknown.length === 1 ? "its" : "their"} tasks again.` : "",
        ].join(""),
      );
    } catch (error) {
      if (error.status === 409 && /changed .* since it was previewed/.test(error.message)) {
        toast(error.message, "error");
        preview({ name: p.branch.slice(prefix.length), branch: p.branch });
        return;
      }
      renderPreview();
      showResult(loadResult, "danger", error.message);
    }
  }

  repoSelect.addEventListener("change", () => {
    localStorage.setItem(REPO_KEY, repoSelect.value);
    reset();
    renderRemote();
  });
  renderRepos();
  renderCounts();
  get("/api/sync")
    .then((info) => {
      prefix = info.prefix;
      prefixLabel.textContent = info.prefix;
      if (!nameInput.value) nameInput.value = localStorage.getItem(NAME_KEY) || info.suggestedName;
      nameInput.placeholder = info.suggestedName || nameInput.placeholder;
    })
    .catch(() => undefined);
  const unsubscribe = subscribe((kind) => {
    if (kind === "repos") renderRepos();
    if (kind === "tasks" || kind === "todos") renderCounts();
  });
  return { el, dispose: unsubscribe };
}
