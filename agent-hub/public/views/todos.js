import { del, get, patch, post } from "../lib/api.js";
import { chip, confirmDialog, h, isActive, relTime, setContent, statusInfo, toast } from "../lib/dom.js";
import { renderMarkdown } from "../lib/markdown.js";
import { dropTodo, notify, state, subscribe, upsertTodo } from "../lib/store.js";

const LAST_REPO_KEY = "agent-hub.todo-repo";

const FILTERS = [
  { id: "open", label: "To do", test: (todo) => todo.status === "open" },
  { id: "active", label: "With the manager", test: (todo) => todo.status === "sent" && taskActive(todo) },
  { id: "finished", label: "Finished", test: (todo) => todo.status === "sent" && !taskActive(todo) },
  { id: "all", label: "All", test: () => true },
];

let currentFilter = "open";

const taskOf = (todo) => (todo.taskId ? state.tasks.get(todo.taskId) : undefined);
const repoOf = (todo) => (todo.repoId ? state.repos.find((repo) => repo.id === todo.repoId) : undefined);
const taskActive = (todo) => {
  const task = taskOf(todo);
  return Boolean(task && isActive(task));
};
/** An open to-do whose repository is registered: it can be sent to the manager. */
const ready = (todo) => todo.status === "open" && Boolean(repoOf(todo));
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function headline(todo) {
  if (todo.title) return todo.title;
  const line = (todo.description.split("\n").find((candidate) => candidate.trim()) ?? "").trim().replace(/^#+\s*/, "");
  return line.length > 120 ? `${line.slice(0, 119)}…` : line || todo.id;
}

/** Open to-dos first (newest first), then the sent ones (most recently sent first). */
function ordered(todos) {
  const open = todos.filter((todo) => todo.status === "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sent = todos.filter((todo) => todo.status !== "open").sort((a, b) => (b.sentAt ?? b.updatedAt).localeCompare(a.sentAt ?? a.updatedAt));
  return [...open, ...sent];
}

export function todosView(root) {
  /** Branch lists per repository (promises), shared by the add form and the editors. */
  const branchCache = new Map();
  /** Rendered cards by to-do id: { el, sig, checkbox, when } or, while editing, { el, editor: true, focus }. */
  const cards = new Map();
  const editing = new Set();
  const selected = new Set();
  /** Sent to-dos whose request is expanded (kept when their card is rebuilt). */
  const expanded = new Set();
  /** To-dos with a request in flight, and which one ("send", "reopen" or "delete"). */
  const busy = new Map();

  // ---- add form ------------------------------------------------------------------------------
  const description = h("textarea", {
    class: "input",
    rows: "4",
    required: true,
    placeholder: "What should the agents do? e.g. \"Add retry support to the uploader and make sure the unit tests pass\", \"Write an onboarding guide for the deployment scripts\" or \"Review pull request #42\"…",
  });
  const titleInput = h("input", { class: "input", type: "text", maxlength: "200", placeholder: "Optional – defaults to the first line" });
  const addLocation = locationFields(branchCache, { repoId: defaultRepo() });
  const addButton = h("button", { class: "btn btn-primary", type: "submit" }, "Add to-do");
  const repoNote = h(
    "div",
    { class: "callout callout-warning", hidden: true },
    "No repository is registered yet. You can note to-dos down now; register a repository to send them to the manager. ",
    h("a", { href: "#/repos" }, "Go to Repositories →"),
  );
  const addForm = h(
    "form",
    { class: "card form todo-form", onsubmit: add },
    repoNote,
    h("label", { class: "field" }, h("span", { class: "field-label" }, "New to-do"), description),
    h(
      "div",
      { class: "grid-3" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Title"), titleInput),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Repository"), addLocation.repoSelect),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Base branch"), addLocation.branchSelect),
    ),
    h(
      "div",
      { class: "row end todo-form-actions" },
      h("span", { class: "muted small grow" }, "Ctrl+Enter adds it. The repository can be chosen later, before sending."),
      addButton,
    ),
  );
  description.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      addForm.requestSubmit();
    }
  });

  // ---- list ----------------------------------------------------------------------------------
  const filterBar = h("div", { class: "filters todo-filters", role: "tablist" });
  const selectAll = h("input", { type: "checkbox", "aria-label": "Select all to-dos that can be sent", onchange: toggleAll });
  const selectAllLabel = h("label", { class: "todo-select-all" }, selectAll, "Select all");
  const sendButton = h("button", { class: "btn btn-primary btn-sm", type: "button", onclick: sendMany }, "Send to manager");
  const bulkBar = h("div", { class: "todo-bulk" }, selectAllLabel, sendButton);
  const list = h("div", { class: "todo-list" });

  root.append(
    h(
      "div",
      { class: "page-header" },
      h(
        "div",
        {},
        h("h1", {}, "To-do"),
        h(
          "p",
          { class: "muted" },
          "Note down work for the agents and refine it until it is ready. Send to manager hands a to-do to the manager agent as an Auto task: it reads the request and the repository, decides which sub-agents to create (designers, coders and reviewers, test executors and fixers, writers; pull request reviews go straight to the two reviewers) and runs it. Sent to-dos link to their task.",
        ),
      ),
    ),
    addForm,
    h("div", { class: "todo-toolbar" }, filterBar, bulkBar),
    list,
  );

  function defaultRepo() {
    const last = localStorage.getItem(LAST_REPO_KEY);
    return state.repos.some((repo) => repo.id === last) ? last : (state.repos[0]?.id ?? "");
  }

  async function add(event) {
    event.preventDefault();
    if (!description.value.trim()) {
      toast("Describe the work first", "error");
      description.focus();
      return;
    }
    addButton.disabled = true;
    try {
      const { repoId, baseRef } = addLocation.value();
      const todo = await post("/api/todos", {
        description: description.value,
        title: titleInput.value.trim() || undefined,
        repoId: repoId ?? undefined,
        baseRef: baseRef ?? undefined,
      });
      if (repoId) localStorage.setItem(LAST_REPO_KEY, repoId);
      description.value = "";
      titleInput.value = "";
      if (currentFilter !== "open" && currentFilter !== "all") currentFilter = "open";
      upsertTodo(todo);
      toast(`Added ${todo.id}`, "success");
      description.focus();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      addButton.disabled = false;
    }
  }

  // ---- rendering -----------------------------------------------------------------------------
  function render() {
    for (const id of [...selected]) {
      const todo = state.todos.find((candidate) => candidate.id === id);
      if (!todo || !ready(todo)) selected.delete(id);
    }
    for (const id of [...editing]) {
      if (state.todos.find((candidate) => candidate.id === id)?.status !== "open") editing.delete(id);
    }
    for (const id of [...cards.keys()]) {
      if (!state.todos.some((todo) => todo.id === id)) cards.delete(id);
    }
    repoNote.hidden = state.repos.length > 0;

    const todos = ordered(state.todos);
    setContent(
      filterBar,
      FILTERS.map((filter) =>
        h(
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
          h("span", { class: "count" }, String(todos.filter(filter.test).length)),
        ),
      ),
    );
    renderBulk();

    const filter = FILTERS.find((candidate) => candidate.id === currentFilter) ?? FILTERS[0];
    const visible = todos.filter(filter.test);
    if (!visible.length) {
      setContent(
        list,
        h(
          "div",
          { class: "empty muted" },
          !state.todos.length
            ? "Nothing on the list yet. Add the work you want the agents to do, then send each to-do to the manager when it is ready."
            : currentFilter === "open"
              ? "Everything has been sent to the manager. Add a new to-do above."
              : "No to-dos match this filter.",
        ),
      );
      return;
    }
    // Keyed update: unchanged cards (and open editors) stay in place, so live task updates never reset input or focus.
    const wanted = visible.map(cardFor);
    const keep = new Set(wanted);
    for (const child of [...list.children]) if (!keep.has(child)) child.remove();
    wanted.forEach((el, index) => {
      if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null);
    });
  }

  /**
   * The bulk send acts on the selected to-dos, or on every to-do that can be sent when none is selected - oldest
   * first, so the manager gets them (and queued tasks start) in the order they were noted down.
   */
  function bulkTargets() {
    return state.todos
      .filter((todo) => ready(todo) && !busy.has(todo.id) && (!selected.size || selected.has(todo.id)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function renderBulk() {
    bulkBar.hidden = currentFilter !== "open" && currentFilter !== "all";
    const sendable = state.todos.filter((todo) => ready(todo) && !busy.has(todo.id));
    const targets = bulkTargets();
    sendButton.disabled = targets.length === 0;
    sendButton.textContent = selected.size ? `Send selected to manager (${targets.length})` : `Send all to manager (${targets.length})`;
    sendButton.title = targets.length ? `Send ${plural(targets.length, "to-do")} to the manager agent` : "Nothing to send: add a to-do and choose its repository";
    selectAll.disabled = sendable.length === 0;
    selectAll.checked = sendable.length > 0 && sendable.every((todo) => selected.has(todo.id));
    selectAll.indeterminate = selected.size > 0 && !selectAll.checked;
  }

  function toggleAll() {
    const sendable = state.todos.filter((todo) => ready(todo) && !busy.has(todo.id));
    selected.clear();
    if (selectAll.checked) for (const todo of sendable) selected.add(todo.id);
    for (const [id, card] of cards) if (card.checkbox) card.checkbox.checked = selected.has(id);
    renderBulk();
  }

  function cardFor(todo) {
    const cached = cards.get(todo.id);
    if (editing.has(todo.id)) {
      if (cached?.editor) return cached.el;
      const editor = editorCard(todo);
      cards.set(todo.id, editor);
      return editor.el;
    }
    const sig = signature(todo);
    if (cached && !cached.editor && cached.sig === sig) {
      cached.when.textContent = whenLabel(todo);
      return cached.el;
    }
    const card = todoCard(todo);
    cards.set(todo.id, { ...card, sig });
    return card.el;
  }

  function signature(todo) {
    const task = taskOf(todo);
    const repo = repoOf(todo);
    return JSON.stringify([
      todo.updatedAt,
      todo.status,
      todo.taskId,
      task ? [task.status, statusInfo(task).label, task.title] : null,
      repo ? [repo.name, repo.path] : null,
      busy.get(todo.id) ?? null,
    ]);
  }

  const whenLabel = (todo) => (todo.status === "open" ? `added ${relTime(todo.createdAt)}` : `sent ${relTime(todo.sentAt)}`);

  function todoCard(todo) {
    const task = taskOf(todo);
    const repo = repoOf(todo);
    const open = todo.status === "open";
    const working = busy.get(todo.id);
    const active = Boolean(task && isActive(task));
    const status = open ? { label: "To do", cls: "info" } : task ? statusInfo(task) : { label: "Task deleted", cls: "neutral" };
    const checkbox = open
      ? h("input", {
          type: "checkbox",
          class: "todo-check",
          checked: selected.has(todo.id),
          disabled: !repo || Boolean(working),
          "aria-label": `Select ${todo.id}`,
          title: repo ? `Select ${todo.id} to send it together with others` : "Choose the repository first (Edit)",
          onchange: (event) => {
            if (event.target.checked) selected.add(todo.id);
            else selected.delete(todo.id);
            renderBulk();
          },
        })
      : null;
    const where = todo.repoId
      ? chip(
          `${repo?.name ?? todo.repoId}${todo.baseRef ? ` @ ${todo.baseRef}` : ""}${repo ? "" : " (removed)"}`,
          repo ? "outline" : "warning",
          repo ? `${repo.path}${todo.baseRef ? "" : " · starts from the branch checked out when it is sent"}` : `Repository ${todo.repoId} is no longer registered; edit the to-do to choose another`,
        )
      : chip("No repository yet", "warning", "Choose the repository before sending the to-do to the manager");

    const taskLine = todo.taskId
      ? h(
          "div",
          { class: "todo-task small" },
          open ? "Last sent to the manager as " : "Sent to the manager as ",
          task ? h("a", { href: `#/tasks/${todo.taskId}` }, todo.taskId) : h("span", { class: "mono" }, todo.taskId),
          task ? h("span", { class: "muted" }, ` · ${task.title}${open ? ` · ${statusInfo(task).label}` : ""}`) : h("span", { class: "muted" }, " (the task was deleted)"),
        )
      : null;

    const actions = open
      ? [
          h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              type: "button",
              disabled: !repo || Boolean(working),
              title: repo ? "The manager agent plans it as an Auto task, creates the sub-agents and runs it" : "Choose the repository first (Edit)",
              onclick: () => sendOne(todo.id),
            },
            working === "send" ? "Sending…" : "▶ Send to manager",
          ),
          h("button", { class: "btn btn-sm", type: "button", disabled: Boolean(working), onclick: () => startEdit(todo.id) }, "✎ Edit"),
          h("button", { class: "btn btn-sm btn-ghost-danger", type: "button", disabled: Boolean(working), onclick: () => remove(todo.id) }, working === "delete" ? "Deleting…" : "Delete"),
        ]
      : [
          task ? h("a", { class: "btn btn-sm", href: `#/tasks/${task.id}` }, `Open ${task.id} →`) : null,
          h(
            "button",
            {
              class: "btn btn-sm",
              type: "button",
              disabled: active || Boolean(working),
              title: active ? `${task.id} is still ${task.status === "queued" ? "queued" : "running"}; cancel it or let it finish first` : "Put the to-do back on the list to change it and send it again",
              onclick: () => reopen(todo.id),
            },
            working === "reopen" ? "Reopening…" : "↺ Reopen",
          ),
          h("button", { class: "btn btn-sm btn-ghost-danger", type: "button", disabled: Boolean(working), onclick: () => remove(todo.id) }, working === "delete" ? "Deleting…" : "Delete"),
        ];

    const when = h("span", { class: "muted small todo-when", title: new Date(open ? todo.createdAt : todo.sentAt).toLocaleString() }, whenLabel(todo));
    const el = h(
      "div",
      { class: `todo-card todo-${open ? "open" : active ? "active" : "done"} status-${status.cls}`, dataset: { todo: todo.id } },
      h("div", { class: "todo-head" }, checkbox, h("span", { class: "task-id mono" }, todo.id), chip(status.label, status.cls), where, when),
      h("div", { class: "todo-title" }, headline(todo)),
      taskLine,
      open
        ? h("div", { class: "todo-body" }, renderMarkdown(todo.description))
        : h(
            "details",
            {
              class: "todo-request",
              open: expanded.has(todo.id),
              ontoggle: (event) => (event.target.open ? expanded.add(todo.id) : expanded.delete(todo.id)),
            },
            h("summary", {}, "Request"),
            h("div", { class: "todo-body" }, renderMarkdown(todo.description)),
          ),
      h("div", { class: "todo-actions" }, actions),
    );
    return { el, checkbox, when };
  }

  function editorCard(todo) {
    const descriptionInput = h("textarea", { class: "input", rows: "6", value: todo.description, "aria-label": "Description" });
    const editTitle = h("input", { class: "input", type: "text", maxlength: "200", value: todo.title, placeholder: "Optional – defaults to the first line" });
    const known = Boolean(repoOf(todo));
    const location = locationFields(branchCache, { repoId: known ? todo.repoId : "", baseRef: known ? todo.baseRef : undefined });
    const saveButton = h("button", { class: "btn btn-primary btn-sm", type: "submit" }, "Save");
    const cancel = () => {
      editing.delete(todo.id);
      cards.delete(todo.id);
      render();
    };
    const save = async (event) => {
      event.preventDefault();
      if (!descriptionInput.value.trim()) {
        toast("The description cannot be empty; delete the to-do instead", "error");
        descriptionInput.focus();
        return;
      }
      saveButton.disabled = true;
      try {
        const updated = await patch(`/api/todos/${encodeURIComponent(todo.id)}`, {
          description: descriptionInput.value,
          title: editTitle.value.trim() || null,
          ...location.value(),
        });
        if (updated.repoId) localStorage.setItem(LAST_REPO_KEY, updated.repoId);
        editing.delete(todo.id);
        cards.delete(todo.id);
        upsertTodo(updated);
        toast(`Saved ${todo.id}`, "success");
      } catch (error) {
        toast(error.message, "error");
        saveButton.disabled = false;
      }
    };
    const el = h(
      "form",
      {
        class: "todo-card todo-editing",
        dataset: { todo: todo.id },
        onsubmit: save,
        onkeydown: (event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            el.requestSubmit();
          }
        },
      },
      h("div", { class: "todo-head" }, h("span", { class: "task-id mono" }, todo.id), chip("Editing", "info"), h("span", { class: "muted small todo-when" }, "Ctrl+Enter saves · Esc cancels")),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Description"), descriptionInput),
      h(
        "div",
        { class: "grid-3" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Title"), editTitle),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Repository"), location.repoSelect),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Base branch"), location.branchSelect),
      ),
      h("div", { class: "row end" }, h("button", { class: "btn btn-sm", type: "button", onclick: cancel }, "Cancel"), saveButton),
    );
    return { el, editor: true, focus: () => descriptionInput.focus() };
  }

  // ---- actions -------------------------------------------------------------------------------
  function startEdit(id) {
    editing.add(id);
    render();
    cards.get(id)?.focus?.();
  }

  /** Records what the hub returned for a sent to-do (the task's live summary may already be newer). */
  function accept(todo, task) {
    if (!state.tasks.has(task.id)) {
      state.tasks.set(task.id, task);
      notify("tasks");
    }
    upsertTodo(todo);
  }

  async function sendOne(id) {
    busy.set(id, "send");
    render();
    try {
      const { todo, task } = await post(`/api/todos/${encodeURIComponent(id)}/send`);
      accept(todo, task);
      toast(`Sent ${id} to the manager as ${task.id}`, "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      busy.delete(id);
      render();
    }
  }

  async function sendMany() {
    const targets = bulkTargets();
    if (!targets.length) return;
    const waiting = state.todos.filter((todo) => todo.status === "open" && !repoOf(todo) && (!selected.size || selected.has(todo.id)));
    const limit = state.settings?.maxConcurrency;
    const confirmed = await confirmDialog({
      title: `Send ${plural(targets.length, "to-do")} to the manager?`,
      body: h(
        "div",
        {},
        h(
          "p",
          {},
          `Each to-do becomes an Auto task: the manager agent reads it, decides which sub-agents to create and runs it.${limit ? ` Up to ${limit} tasks run at the same time; the others wait in the queue.` : ""}`,
        ),
        h(
          "ul",
          { class: "todo-confirm-list" },
          targets.map((todo) => h("li", {}, h("span", { class: "mono" }, todo.id), ` ${headline(todo)}`, h("span", { class: "muted" }, ` · ${repoOf(todo)?.name ?? todo.repoId}${todo.baseRef ? ` @ ${todo.baseRef}` : ""}`))),
        ),
        waiting.length ? h("p", { class: "muted small" }, `${waiting.map((todo) => todo.id).join(", ")} ${waiting.length === 1 ? "has" : "have"} no repository yet and stay${waiting.length === 1 ? "s" : ""} on the list.`) : null,
      ),
      confirmText: `Send ${targets.length}`,
      wide: true,
    });
    if (!confirmed) return;
    for (const todo of targets) busy.set(todo.id, "send");
    render();
    const sent = [];
    let failed = 0;
    for (const target of targets) {
      try {
        const { todo, task } = await post(`/api/todos/${encodeURIComponent(target.id)}/send`);
        accept(todo, task);
        sent.push(`${target.id} → ${task.id}`);
      } catch (error) {
        failed++;
        toast(`${target.id}: ${error.message}`, "error");
      } finally {
        busy.delete(target.id);
        render();
      }
    }
    if (sent.length) toast(`Sent ${plural(sent.length, "to-do")} to the manager: ${sent.join(", ")}`, "success");
    if (failed && sent.length) toast(`${plural(failed, "to-do")} could not be sent and stay${failed === 1 ? "s" : ""} on the list`, "error");
  }

  async function reopen(id) {
    busy.set(id, "reopen");
    render();
    try {
      upsertTodo(await post(`/api/todos/${encodeURIComponent(id)}/reopen`));
      if (currentFilter !== "all") currentFilter = "open";
      toast(`${id} is back on the list: change it if needed and send it again`, "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      busy.delete(id);
      render();
    }
  }

  async function remove(id) {
    const todo = state.todos.find((candidate) => candidate.id === id);
    if (!todo) return;
    const confirmed = await confirmDialog({
      title: `Delete ${todo.id}?`,
      body: h("p", {}, `"${headline(todo)}" is removed from the to-do list.`, todo.taskId ? ` Its task ${todo.taskId} is kept.` : " This cannot be undone."),
      confirmText: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    busy.set(id, "delete");
    render();
    try {
      await del(`/api/todos/${encodeURIComponent(id)}`);
      selected.delete(id);
      dropTodo(id);
      toast(`Deleted ${id}`, "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      busy.delete(id);
      render();
    }
  }

  const unsubscribe = subscribe((kind) => {
    if (kind === "repos") addLocation.refreshRepos();
    if (kind === "todos" || kind === "tasks" || kind === "repos") render();
  });
  const ticker = setInterval(render, 30_000);
  render();
  return () => {
    unsubscribe();
    clearInterval(ticker);
  };
}

/** Repository and base-branch pickers; the branch list follows the chosen repository. */
function locationFields(branchCache, { repoId, baseRef }) {
  const repoSelect = h("select", { class: "input" });
  const branchSelect = h("select", { class: "input" });
  /** The branch to keep while the branch list is loading (a save meanwhile must not drop it). */
  let pending = baseRef;
  let loading = false;
  let initialized = false;

  /** Rebuilds the repository options (repositories were added or removed), keeping the choice when it still exists. */
  function refreshRepos() {
    const current = initialized ? repoSelect.value : (repoId ?? "");
    setContent(
      repoSelect,
      h("option", { value: "" }, state.repos.length ? "Choose later" : "No repositories registered"),
      state.repos.map((repo) => h("option", { value: repo.id, title: repo.path }, repo.name)),
    );
    repoSelect.value = state.repos.some((repo) => repo.id === current) ? current : "";
    if (initialized && repoSelect.value !== current) loadBranches();
    initialized = true;
  }

  async function loadBranches(preferred) {
    const id = repoSelect.value;
    pending = preferred;
    if (!id) {
      loading = false;
      setContent(branchSelect, h("option", { value: "" }, "Choose the repository first"));
      branchSelect.disabled = true;
      return;
    }
    loading = true;
    branchSelect.disabled = true;
    setContent(branchSelect, h("option", { value: "" }, "Loading…"));
    try {
      if (!branchCache.has(id)) branchCache.set(id, get(`/api/repos/${encodeURIComponent(id)}/branches`));
      const { branches, current } = await branchCache.get(id);
      if (repoSelect.value !== id) return;
      setContent(
        branchSelect,
        h("option", { value: "", title: "The branch checked out in the repository when the to-do is sent" }, current ? `Checked-out branch (now ${current})` : "Checked-out branch"),
        preferred && !branches.includes(preferred) ? h("option", { value: preferred }, `${preferred} (not found)`) : null,
        branches.map((branch) => h("option", { value: branch }, branch)),
      );
      branchSelect.value = preferred ?? "";
    } catch (error) {
      branchCache.delete(id);
      if (repoSelect.value !== id) return;
      setContent(branchSelect, h("option", { value: "" }, "Checked-out branch"), preferred ? h("option", { value: preferred }, preferred) : null);
      branchSelect.value = preferred ?? "";
      toast(`Could not list the branches: ${error.message}`, "error");
    }
    if (repoSelect.value === id) {
      loading = false;
      pending = undefined;
      branchSelect.disabled = false;
    }
  }

  repoSelect.addEventListener("change", () => loadBranches());
  refreshRepos();
  loadBranches(repoSelect.value ? baseRef : undefined);
  return {
    repoSelect,
    branchSelect,
    refreshRepos,
    /** null clears the field on the hub. */
    value: () => {
      const repo = repoSelect.value || null;
      const branch = repo ? (loading ? pending : branchSelect.value) || null : null;
      return { repoId: repo, baseRef: branch };
    },
  };
}
