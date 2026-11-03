import { get, post } from "../lib/api.js";
import { h, setContent, toast } from "../lib/dom.js";
import { state } from "../lib/store.js";
import { loadModels, modelOptions } from "./models.js";

const TYPES = [
  {
    id: "coding",
    title: "Coding",
    text: "Agents: a coder implements the request, a code reviewer reviews each commit, and a comment resolver fixes review comments, round by round until approval.",
    placeholder: "Describe the change: what to build or fix, acceptance criteria, constraints, files or areas involved…",
  },
  {
    id: "design",
    title: "Design",
    text: "Agents: a designer writes the design document and revises it; a design reviewer critiques it until a finalized version is approved.",
    placeholder: "Describe the problem to design for: goals, requirements, constraints, open questions…",
  },
  {
    id: "design-coding",
    title: "Design → Coding",
    text: "Agents: designer and design reviewer finalize a design first; then coder, code reviewer and comment resolver implement it.",
    placeholder: "Describe the feature: goals, requirements and acceptance criteria. The design is written first, then implemented…",
  },
];

export function newTaskView(root) {
  let kind = "coding";
  const typeButtons = h("div", { class: "seg", role: "radiogroup", "aria-label": "Task type" });
  const typeHelp = h("p", { class: "muted small" });
  const repoSelect = h("select", { class: "input", required: true });
  const branchSelect = h("select", { class: "input" });
  const titleInput = h("input", { class: "input", type: "text", maxlength: "100", placeholder: "Optional – defaults to the first line of the description" });
  const description = h("textarea", { class: "input", rows: "10", required: true });
  const authorSelect = h("select", { class: "input" });
  const reviewerSelect = h("select", { class: "input" });
  const resolverSelect = h("select", { class: "input" });
  const resolverField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Comment resolver model"), resolverSelect);
  const roundsInput = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(state.settings?.maxRounds ?? 3) });
  const submitButton = h("button", { class: "btn btn-primary", type: "submit" }, "Create task");

  const form = h(
    "form",
    { class: "card form", onsubmit: submit },
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Type"), typeButtons, typeHelp),
    h(
      "div",
      { class: "grid-2" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Repository"), repoSelect),
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Base branch"), branchSelect),
    ),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Title"), titleInput),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Description"), description),
    h(
      "details",
      { class: "advanced" },
      h("summary", {}, "Agents, models and review rounds"),
      h(
        "div",
        { class: "grid-2" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Author model (designer / coder)"), authorSelect),
        resolverField,
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Reviewer model"), reviewerSelect),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Max review rounds"), roundsInput),
      ),
    ),
    h("div", { class: "row end" }, h("a", { class: "btn", href: "#/tasks" }, "Cancel"), submitButton),
  );

  root.append(
    h("a", { class: "back", href: "#/tasks" }, "← Tasks"),
    h("div", { class: "page-header" }, h("div", {}, h("h1", {}, "New task"), h("p", { class: "muted" }, "Each agent works on its own branch in an isolated worktree; tasks on the same repository run side by side and your checkout is never modified."))),
    form,
  );

  function renderTypes() {
    setContent(
      typeButtons,
      TYPES.map((type) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": String(kind === type.id),
            class: `seg-item ${kind === type.id ? "active" : ""}`,
            onclick: () => {
              kind = type.id;
              renderTypes();
            },
          },
          type.title,
        ),
      ),
    );
    const type = TYPES.find((candidate) => candidate.id === kind);
    typeHelp.textContent = type.text;
    description.placeholder = type.placeholder;
    resolverField.hidden = kind === "design";
  }

  function renderRepos() {
    if (!state.repos.length) {
      setContent(repoSelect, h("option", { value: "" }, "No repositories registered"));
      repoSelect.disabled = true;
      form.prepend(
        h("div", { class: "callout callout-warning" }, "Register a repository first. ", h("a", { href: "#/repos" }, "Go to Repositories →")),
      );
      submitButton.disabled = true;
      return;
    }
    setContent(repoSelect, state.repos.map((repo) => h("option", { value: repo.id }, `${repo.name} — ${repo.path}`)));
    loadBranches();
  }

  async function loadBranches() {
    const repoId = repoSelect.value;
    setContent(branchSelect, h("option", { value: "" }, "Loading…"));
    try {
      const { branches, current } = await get(`/api/repos/${encodeURIComponent(repoId)}/branches`);
      setContent(
        branchSelect,
        branches.map((branch) => h("option", { value: branch, selected: branch === current }, branch === current ? `${branch} (checked out)` : branch)),
      );
    } catch (error) {
      setContent(branchSelect, h("option", { value: "" }, "Default"));
      toast(error.message, "error");
    }
  }

  async function renderModels() {
    try {
      const models = await loadModels();
      setContent(authorSelect, modelOptions(models, state.settings?.authorModel));
      setContent(reviewerSelect, modelOptions(models, state.settings?.reviewerModel));
      setContent(resolverSelect, h("option", { value: "" }, "Same as author model"), modelOptions(models, state.settings?.resolverModel));
    } catch (error) {
      toast(`Could not load models: ${error.message}`, "error");
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (!description.value.trim()) {
      toast("Describe the task first", "error");
      description.focus();
      return;
    }
    submitButton.disabled = true;
    try {
      const task = await post("/api/tasks", {
        kind,
        repoId: repoSelect.value,
        baseRef: branchSelect.value || undefined,
        title: titleInput.value.trim() || undefined,
        description: description.value,
        authorModel: authorSelect.value || undefined,
        reviewerModel: reviewerSelect.value || undefined,
        resolverModel: kind === "design" ? undefined : resolverSelect.value || undefined,
        maxRounds: Number(roundsInput.value) || undefined,
      });
      toast(`Created ${task.id}`, "success");
      location.hash = `#/tasks/${task.id}`;
    } catch (error) {
      toast(error.message, "error");
      submitButton.disabled = false;
    }
  }

  repoSelect.addEventListener("change", loadBranches);
  renderTypes();
  renderRepos();
  renderModels();
  description.focus();
}
