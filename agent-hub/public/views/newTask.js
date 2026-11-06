import { get, post } from "../lib/api.js";
import { h, setContent, toast } from "../lib/dom.js";
import { state } from "../lib/store.js";
import { loadModels, modelOptions } from "./models.js";

const TYPES = [
  {
    id: "auto",
    title: "Auto",
    text: "The manager agent reads your request and the repository, then decides which sub-agents to create (design, coding, test execution & fixing, documentation; or a lead and a peer reviewer when you ask to review a pull request or branch), gives each its assignment and monitors them.",
    placeholder: "Describe what you need in plain words, e.g. \"Add retry support to the uploader and make sure the Pester tests pass\", \"Run the end-to-end automation and fix the failures\" or \"Review pull request #42, focusing on error handling\"…",
  },
  {
    id: "coding",
    title: "Coding",
    text: "Agents: a coder implements the request, a code reviewer reviews each commit, and a comment resolver fixes review comments, round by round until approval.",
    placeholder: "Describe the change: what to build or fix, acceptance criteria, constraints, files or areas involved…",
  },
  {
    id: "testing",
    title: "Execute & verify",
    text: "Agents: a test executor runs the test automation and verifies the results; a test fixer fixes failures at the root cause; the executor re-runs and checks the fixes are legitimate, until everything passes.",
    placeholder: "Describe the automation to run and verify, e.g. \"Run the Pester tests in tests/ (Invoke-Pester) and fix any failures\" or \"Run npm test and the e2e suite (npm run e2e)\"…",
  },
  {
    id: "design",
    title: "Design",
    text: "Agents: a designer writes the design as a light-themed HTML document (with diagrams) and revises it; a design reviewer critiques it until a finalized version is approved.",
    placeholder: "Describe the problem to design for: goals, requirements, constraints, open questions…",
  },
  {
    id: "document",
    title: "Document",
    text: "Agents: a technical writer writes the documentation as a light-themed HTML page (with diagrams) grounded in the repository; a doc reviewer checks accuracy and clarity until it is approved.",
    placeholder: "Describe the document: audience, purpose, topics to cover (e.g. onboarding guide, API reference, runbook, architecture overview)…",
  },
  {
    id: "design-coding",
    title: "Design → Coding",
    text: "Agents: designer and design reviewer finalize a design first; then coder, code reviewer and comment resolver implement it.",
    placeholder: "Describe the feature: goals, requirements and acceptance criteria. The design is written first, then implemented…",
  },
  {
    id: "review",
    title: "Code review",
    text: "Agents: a lead reviewer and a peer reviewer (pick different models for a real second opinion) review a pull request or branch independently, discuss each other's findings and agree on a final review. You then keep, drop or edit each comment and publish them on the pull request with one click.",
    placeholder: "Optional: what the reviewers should focus on, e.g. \"security of the token handling\" or \"API compatibility\". Leave empty for a full review…",
  },
];

export function newTaskView(root) {
  let kind = "auto";
  const typeButtons = h("div", { class: "seg", role: "radiogroup", "aria-label": "Task type" });
  const typeHelp = h("p", { class: "muted small" });
  const repoSelect = h("select", { class: "input", required: true });
  const branchSelect = h("select", { class: "input" });
  const branchLabel = h("span", { class: "field-label" }, "Base branch");
  const titleInput = h("input", { class: "input", type: "text", maxlength: "100", placeholder: "Optional – defaults to the first line of the description" });
  const targetInput = h("input", { class: "input", type: "text", maxlength: "1000", spellcheck: "false", placeholder: "#123, a pull request URL, or a branch, tag or commit" });
  const targetField = h(
    "label",
    { class: "field", hidden: true },
    h("span", { class: "field-label" }, "Pull request or branch to review"),
    targetInput,
    h(
      "small",
      { class: "muted" },
      "A pull request is fetched from the repository's remote (GitHub, GitLab, Azure DevOps) and reviewed against its target branch; a branch is reviewed against the target branch below. Comments can be published on GitHub pull requests (GitHub CLI signed in); otherwise copy the review as Markdown.",
    ),
  );
  const descriptionLabel = h("span", { class: "field-label" }, "Description");
  const description = h("textarea", { class: "input", rows: "10", required: true });
  const authorSelect = h("select", { class: "input" });
  const reviewerSelect = h("select", { class: "input" });
  const resolverSelect = h("select", { class: "input" });
  const managerSelect = h("select", { class: "input" });
  const peerSelect = h("select", { class: "input" });
  const authorField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Author model (designer / writer / coder)"), authorSelect);
  const reviewerLabel = h("span", { class: "field-label" }, "Reviewer / test executor model");
  const resolverField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Comment resolver / test fixer model"), resolverSelect);
  const managerField = h("label", { class: "field" }, h("span", { class: "field-label" }, "Manager model (plans the task)"), managerSelect);
  const peerLabel = h("span", { class: "field-label" }, "Peer reviewer model");
  const peerField = h("label", { class: "field", hidden: true }, peerLabel, peerSelect);
  const roundsLabel = h("span", { class: "field-label" }, "Max review rounds / test runs");
  const roundsInput = h("input", { class: "input", type: "number", min: "1", max: "10", value: String(state.settings?.maxRounds ?? 3) });
  const advanced = h("details", { class: "advanced" });
  const submitButton = h("button", { class: "btn btn-primary", type: "submit" }, "Create task");

  setContent(
    advanced,
    h("summary", {}, "Agents, models and review rounds"),
    h(
      "div",
      { class: "grid-2" },
      managerField,
      authorField,
      resolverField,
      h("label", { class: "field" }, reviewerLabel, reviewerSelect),
      peerField,
      h("label", { class: "field" }, roundsLabel, roundsInput),
    ),
  );
  const form = h(
    "form",
    { class: "card form", onsubmit: submit },
    h("div", { class: "field" }, h("span", { class: "field-label" }, "Type"), typeButtons, typeHelp),
    targetField,
    h(
      "div",
      { class: "grid-2" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, "Repository"), repoSelect),
      h("label", { class: "field" }, branchLabel, branchSelect),
    ),
    h("label", { class: "field" }, h("span", { class: "field-label" }, "Title"), titleInput),
    h("label", { class: "field" }, descriptionLabel, description),
    advanced,
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
    const review = kind === "review";
    typeHelp.textContent = type.text;
    description.placeholder = type.placeholder;
    description.required = !review;
    descriptionLabel.textContent = review ? "Review focus (optional)" : "Description";
    titleInput.placeholder = review ? "Optional – defaults to the pull request's title or the branch name" : "Optional – defaults to the first line of the description";
    targetField.hidden = !review;
    targetInput.required = review;
    branchLabel.textContent = review ? "Target branch (pull requests use their own)" : "Base branch";
    authorField.hidden = review;
    resolverField.hidden = review || kind === "design" || kind === "document";
    managerField.hidden = kind !== "auto";
    // Auto tasks become code reviews when the manager plans one, so their peer reviewer model is offered too.
    peerField.hidden = !review && kind !== "auto";
    peerLabel.textContent = review ? "Peer reviewer model" : "Peer reviewer model (when the manager plans a code review)";
    reviewerLabel.textContent = review ? "Lead reviewer model" : "Reviewer / test executor model";
    roundsLabel.textContent = review ? "Max final-review rounds (lead ↔ peer)" : "Max review rounds / test runs";
    if (review) advanced.open = true;
    selectDefaultBranch();
  }

  /** Code reviews compare against the repository's default branch; other tasks start from the checked-out branch. */
  function selectDefaultBranch() {
    const repo = state.repos.find((candidate) => candidate.id === repoSelect.value);
    const preferred = kind === "review" ? repo?.defaultBranch : branchSelect.dataset.current;
    const option = [...branchSelect.options].find((candidate) => candidate.value === preferred);
    if (option) branchSelect.value = option.value;
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
      branchSelect.dataset.current = current ?? "";
      setContent(
        branchSelect,
        branches.map((branch) => h("option", { value: branch, selected: branch === current }, branch === current ? `${branch} (checked out)` : branch)),
      );
      selectDefaultBranch();
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
      setContent(managerSelect, h("option", { value: "" }, "Same as author model"), modelOptions(models, state.settings?.managerModel));
      setContent(peerSelect, h("option", { value: "" }, "Same as author model"), modelOptions(models, state.settings?.peerReviewerModel));
    } catch (error) {
      toast(`Could not load models: ${error.message}`, "error");
    }
  }

  async function submit(event) {
    event.preventDefault();
    const review = kind === "review";
    if (review && !targetInput.value.trim()) {
      toast("Enter the pull request or branch to review", "error");
      targetInput.focus();
      return;
    }
    if (!review && !description.value.trim()) {
      toast("Describe the task first", "error");
      description.focus();
      return;
    }
    submitButton.disabled = true;
    if (review) submitButton.textContent = "Fetching the change…";
    try {
      const task = await post("/api/tasks", {
        kind,
        repoId: repoSelect.value,
        baseRef: branchSelect.value || undefined,
        title: titleInput.value.trim() || undefined,
        description: description.value,
        reviewTarget: review ? targetInput.value.trim() : undefined,
        authorModel: review ? undefined : authorSelect.value || undefined,
        reviewerModel: reviewerSelect.value || undefined,
        resolverModel: review || kind === "design" || kind === "document" ? undefined : resolverSelect.value || undefined,
        managerModel: kind === "auto" ? managerSelect.value || undefined : undefined,
        peerReviewerModel: review || kind === "auto" ? peerSelect.value || undefined : undefined,
        maxRounds: Number(roundsInput.value) || undefined,
      });
      toast(`Created ${task.id}`, "success");
      location.hash = `#/tasks/${task.id}`;
    } catch (error) {
      toast(error.message, "error");
      submitButton.disabled = false;
      submitButton.textContent = "Create task";
    }
  }

  repoSelect.addEventListener("change", loadBranches);
  renderTypes();
  renderRepos();
  renderModels();
  description.focus();
}
