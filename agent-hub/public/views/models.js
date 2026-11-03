import { get, put } from "../lib/api.js";
import { compactNumber, h, setContent, spinner, toast } from "../lib/dom.js";
import { notify, state } from "../lib/store.js";

/** Loads the model catalog for the signed-in user. Shared with the settings and new-task views. */
let modelsCache = null;
export async function loadModels(force = false) {
  if (!modelsCache || force) modelsCache = await get(`/api/models${force ? "?refresh=1" : ""}`);
  return modelsCache;
}
export function resetModelsCache() {
  modelsCache = null;
}

/** Premium-request multiplier, or input/output token prices for token-billed accounts. */
export function multiplierLabel(model) {
  if (model.multiplier !== null && model.multiplier !== undefined) return `${model.multiplier}×`;
  if (model.inputPrice !== null && model.inputPrice !== undefined) return `${compactNumber(model.inputPrice)} / ${compactNumber(model.outputPrice)}`;
  return "–";
}

const costTitle = (model) =>
  model.multiplier !== null && model.multiplier !== undefined
    ? "Premium request multiplier"
    : model.inputPrice !== null && model.inputPrice !== undefined
      ? `Input / output price per ${compactNumber(model.priceUnitTokens ?? 1_000_000)} tokens`
      : "No pricing information";

export function modelOptions(models, selected) {
  return models.map((model) =>
    h(
      "option",
      { value: model.id, selected: model.id === selected, disabled: model.policy === "disabled" },
      `${model.name}  (${multiplierLabel(model)})${model.policy === "disabled" ? " – not enabled" : ""}`,
    ),
  );
}

export function modelsView(root) {
  const body = h("div", { class: "card" }, spinner("Loading models available to your account…"));
  const saveButton = h("button", { class: "btn btn-primary", disabled: true }, "Save and continue");
  root.append(
    h(
      "div",
      { class: "page-header" },
      h(
        "div",
        {},
        h("h1", {}, "Choose models"),
        h(
          "p",
          { class: "muted" },
          "Pick the LLM for author agents (designer and coder) and for reviewer agents. A different reviewer model gives the author a genuine second opinion. You can change this later in Settings or per task.",
        ),
      ),
    ),
    body,
    h("div", { class: "row end" }, saveButton),
  );

  let author = state.settings?.authorModel ?? null;
  let reviewer = state.settings?.reviewerModel ?? null;

  loadModels(true)
    .then((models) => {
      const enabled = models.filter((model) => model.policy !== "disabled");
      if (!enabled.length) {
        setContent(body, h("div", { class: "empty" }, "No models are enabled for your account. Check your Copilot plan or organization policy."));
        return;
      }
      if (!enabled.some((model) => model.id === author)) author = enabled[0].id;
      if (!enabled.some((model) => model.id === reviewer)) reviewer = (enabled.find((model) => model.id !== author) ?? enabled[0]).id;
      renderTable(models);
      saveButton.disabled = false;
    })
    .catch((error) => setContent(body, h("div", { class: "callout callout-danger" }, error.message)));

  function renderTable(models) {
    const rows = models.map((model) => {
      const disabled = model.policy === "disabled";
      return h(
        "tr",
        { class: disabled ? "disabled" : null },
        h("td", {}, h("div", { class: "model-name" }, model.name), h("div", { class: "muted mono small" }, model.id)),
        h("td", { class: "num", title: costTitle(model) }, multiplierLabel(model)),
        h("td", { class: "num" }, model.contextWindow ? compactNumber(model.contextWindow) : "–"),
        h("td", {}, [model.reasoning ? "reasoning" : null, model.vision ? "vision" : null].filter(Boolean).join(" · ") || "–"),
        h(
          "td",
          { class: "center" },
          h("input", {
            type: "radio",
            name: "author",
            value: model.id,
            checked: model.id === author,
            disabled,
            "aria-label": `Use ${model.name} for authors`,
            onchange: () => (author = model.id),
          }),
        ),
        h(
          "td",
          { class: "center" },
          h("input", {
            type: "radio",
            name: "reviewer",
            value: model.id,
            checked: model.id === reviewer,
            disabled,
            "aria-label": `Use ${model.name} for reviewers`,
            onchange: () => (reviewer = model.id),
          }),
        ),
      );
    });
    setContent(
      body,
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h("th", {}, "Model"),
              h("th", { class: "num", title: "Premium request multiplier, or input/output price per 1M tokens" }, "Cost"),
              h("th", { class: "num" }, "Context"),
              h("th", {}, "Capabilities"),
              h("th", { class: "center" }, "Author"),
              h("th", { class: "center" }, "Reviewer"),
            ),
          ),
          h("tbody", {}, rows),
        ),
      ),
    );
  }

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      state.settings = await put("/api/settings", { authorModel: author, reviewerModel: reviewer });
      notify("settings");
      toast("Models saved", "success");
      location.hash = "#/tasks";
    } catch (error) {
      toast(error.message, "error");
    } finally {
      saveButton.disabled = false;
    }
  });
}
