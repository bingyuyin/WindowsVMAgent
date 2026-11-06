// Small DOM toolkit. Everything is built with createElement/textContent, never innerHTML,
// so agent-produced text can never inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (["value", "checked", "disabled", "selected", "hidden", "required", "open", "readOnly"].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function setContent(el, ...children) {
  clear(el);
  return append(el, children);
}

export const spinner = (label) => h("span", { class: "spinner-wrap" }, h("span", { class: "spinner" }), label ? h("span", {}, label) : null);

export function relTime(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function clock(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

export function duration(fromIso, toIso) {
  if (!fromIso) return "";
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function compactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

export const shortSha = (sha) => (sha ? sha.slice(0, 10) : "");

const SVG_NS = "http://www.w3.org/2000/svg";

/** SVG counterpart of h(): attributes are set as presentation attributes (CSP-safe, no inline styles). */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export const ROLE_LABELS = {
  planner: "Planner",
  designer: "Designer",
  "design-reviewer": "Design reviewer",
  writer: "Technical writer",
  "doc-reviewer": "Doc reviewer",
  coder: "Coder",
  resolver: "Comment resolver",
  "code-reviewer": "Code reviewer",
  executor: "Test executor",
  fixer: "Test fixer",
  "lead-reviewer": "Lead reviewer",
  "peer-reviewer": "Peer reviewer",
};

export const ROLE_ICONS = {
  planner: "◆",
  designer: "✎",
  "design-reviewer": "◎",
  writer: "¶",
  "doc-reviewer": "◎",
  coder: "⌨",
  resolver: "⚒",
  "code-reviewer": "◎",
  executor: "▶",
  fixer: "✚",
  "lead-reviewer": "◉",
  "peer-reviewer": "◎",
};

export const ROLE_DESCRIPTIONS = {
  planner: "The manager's planner: reads the request and repository and decides which sub-agents to create",
  designer: "Writes the design document and revises it for review comments",
  "design-reviewer": "Reviews the design in a read-only worktree",
  writer: "Writes the document and revises it for review comments",
  "doc-reviewer": "Reviews the document in a read-only worktree",
  coder: "Implements the request on its own branch",
  resolver: "Resolves code review comments on its own branch",
  "code-reviewer": "Reviews each commit in a read-only worktree pinned to it",
  executor: "Runs the test automation, verifies the results and checks fixes, in a checkout pinned to the commit under test",
  fixer: "Fixes test failures at the root cause on its own branch",
  "lead-reviewer": "Reviews the change, discusses the peer reviewer's findings and writes the final review",
  "peer-reviewer": "Reviews the change on its own model, discusses the findings and signs off on the final review",
};

/** Hub best-practice skills each role is asked to apply (mirrors the server's ROLE_SKILLS). */
export const ROLE_SKILLS = {
  planner: [],
  designer: ["system-design"],
  "design-reviewer": ["design-review"],
  writer: ["technical-writing"],
  "doc-reviewer": ["doc-review"],
  coder: ["coding-best-practices"],
  resolver: ["review-comment-resolution", "coding-best-practices"],
  "code-reviewer": ["code-review"],
  executor: ["test-execution"],
  fixer: ["test-fixing", "coding-best-practices"],
  "lead-reviewer": ["code-review"],
  "peer-reviewer": ["code-review"],
};

export const isCodeReviewRole = (role) => role === "lead-reviewer" || role === "peer-reviewer";
export const isReviewerRole = (role) => role === "design-reviewer" || role === "code-reviewer" || role === "doc-reviewer" || isCodeReviewRole(role);

/** Agents that work in a checkout pinned to a commit instead of on a branch of their own. */
export const worksDetached = (role) => isReviewerRole(role) || role === "executor" || role === "planner";

const STAGE_ROLES = {
  design: ["designer", "design-reviewer"],
  coding: ["coder", "code-reviewer", "resolver"],
  testing: ["executor", "fixer"],
  document: ["writer", "doc-reviewer"],
};

const KIND_STAGES = {
  auto: [],
  coding: ["coding"],
  design: ["design"],
  document: ["document"],
  testing: ["testing"],
  "design-coding": ["design", "coding"],
};

/** Sub-agents of the given stages, in workflow order. */
export function rolesForStages(stages) {
  return [...new Set(stages.flatMap((stage) => STAGE_ROLES[stage] ?? []))];
}

/** Sub-agents a task kind uses, in workflow order. */
export function rolesFor(kind) {
  if (kind === "review") return ["lead-reviewer", "peer-reviewer"];
  return kind === "auto" ? ["planner"] : rolesForStages(KIND_STAGES[kind] ?? ["coding"]);
}

/** A code review of an existing change: a Code review task, or an Auto task the manager planned as one (full tasks and summaries). */
export const isCodeReviewTask = (task) => task.kind === "review" || Boolean(task.review) || Boolean(task.plan?.review);

/** Sub-agents of a task: for Auto tasks the manager's planner plus the team it planned (stages, or the two reviewers). */
export function rolesForTask(task) {
  if (task.kind !== "auto") return rolesFor(task.kind);
  // A request that named the change to review went to the reviewers directly, without the planner.
  if (isCodeReviewTask(task)) return task.plan?.direct ? ["lead-reviewer", "peer-reviewer"] : ["planner", "lead-reviewer", "peer-reviewer"];
  const stages = task.plan?.stages ?? task.stages?.map((stage) => stage.kind) ?? [];
  return ["planner", ...rolesForStages(stages)];
}

/** Stage a role works in (null for the planner and the code review reviewers, which work outside stages). */
export const stageOfRole = (role) =>
  role === "designer" || role === "design-reviewer"
    ? "design"
    : role === "writer" || role === "doc-reviewer"
      ? "document"
      : role === "executor" || role === "fixer"
        ? "testing"
        : role === "planner" || isCodeReviewRole(role)
          ? null
          : "coding";

export function agentStatusInfo(agent) {
  if (!agent) return { label: "Not started", cls: "neutral" };
  switch (agent.status) {
    case "working":
      return { label: "Working", cls: "running" };
    case "idle":
      return { label: "Waiting for its next turn", cls: "info-soft" };
    case "done":
      return { label: "Done", cls: "success" };
    case "failed":
      return { label: "Failed", cls: "danger" };
    case "cancelled":
      return { label: "Stopped", cls: "neutral" };
    default:
      return { label: agent.status, cls: "neutral" };
  }
}

export const KIND_LABELS = {
  auto: "Auto (manager plans)",
  coding: "Coding",
  design: "Design",
  document: "Document",
  testing: "Execute & verify",
  "design-coding": "Design → Coding",
  review: "Code review",
};
export const STAGE_LABELS = { design: "Design", document: "Document", coding: "Coding", testing: "Execute & verify" };
export const isDocStage = (stage) => stage === "design" || stage === "document";

export function phaseLabel(stage, phase) {
  if (phase === "planning") return "Planning";
  if (phase === "verifying") return "Verifying unit tests";
  if (phase === "discussing") return "Discussing the findings";
  if (phase === "consolidating") return "Agreeing on the final review";
  if (stage === "testing" && phase === "reviewing") return "Running tests";
  if (stage === "testing" && (phase === "authoring" || phase === "revising")) return "Fixing test failures";
  const noun = stage === "design" ? "design" : stage === "document" ? "document" : "code";
  switch (phase) {
    case "authoring":
      return stage === "design" ? "Designing" : stage === "document" ? "Writing" : "Coding";
    case "reviewing":
      return `Reviewing ${noun}`;
    case "revising":
      return isDocStage(stage) ? `Revising ${noun}` : "Resolving review comments";
    case "preparing":
      return "Preparing workspace";
    case "finalizing":
      return "Finalizing";
    case "done":
      return "Done";
    default:
      return "Queued";
  }
}

export function statusInfo(task) {
  switch (task.status) {
    case "queued":
      return { label: "Queued", cls: "neutral" };
    case "running":
      return { label: isCodeReviewTask(task) && task.phase === "reviewing" ? "Reviewing the change" : phaseLabel(task.currentStage, task.phase), cls: "running" };
    case "needs-input":
      return { label: "Needs your input", cls: "attention" };
    case "completed": {
      if (isCodeReviewTask(task)) {
        // Works for task summaries (review.published/agreed) and full tasks (review.publications/signoff).
        const review = task.review;
        const published = review?.published ?? Boolean(review?.publications?.some((publication) => publication.main));
        const agreed = review?.agreed ?? (review?.signoff ? review.signoff.agreed : null);
        if (published) return { label: "Review published", cls: "success" };
        return { label: agreed === false ? "Review ready · disputed" : "Review ready", cls: agreed === false ? "warning" : "success" };
      }
      const approved = task.approved ?? task.result?.approved;
      const testsLast = (task.plan?.stages ?? task.stages?.map((stage) => stage.kind) ?? []).at(-1) === "testing";
      if (testsLast) return approved ? { label: "Tests pass", cls: "success" } : { label: "Done · tests failing", cls: "warning" };
      return approved ? { label: "Approved", cls: "success" } : { label: "Done · not approved", cls: "warning" };
    }
    case "failed":
      return { label: "Failed", cls: "danger" };
    case "cancelled":
      return { label: "Cancelled", cls: "neutral" };
    case "interrupted":
      return { label: "Interrupted", cls: "warning" };
    default:
      return { label: task.status, cls: "neutral" };
  }
}

export const isActive = (task) => ["queued", "running", "needs-input"].includes(task.status);

export const chip = (label, cls = "neutral", title) => h("span", { class: `chip chip-${cls}`, title }, label);

export const roleTag = (role) => h("span", { class: `role-tag role-${role}` }, ROLE_LABELS[role] ?? role);

export function toast(message, kind = "info") {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, message);
  host.append(el);
  setTimeout(() => el.classList.add("leaving"), 4500);
  setTimeout(() => el.remove(), 5000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "success");
  } catch {
    toast("Copy failed", "error");
  }
}

export const copyButton = (text, label = "Copy") =>
  h("button", { class: "btn btn-xs btn-ghost", type: "button", title: `Copy ${text}`, onclick: () => copyText(text) }, label);

/** Minimal modal dialog. Resolves with true when confirmed. */
export function confirmDialog({ title, body, confirmText = "Confirm", danger = false, wide = false }) {
  return new Promise((resolve) => {
    const close = (result) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(false);
    };
    const confirmButton = h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"}`, onclick: () => close(true) }, confirmText);
    const overlay = h(
      "div",
      { class: "modal-overlay", onclick: (event) => event.target === overlay && close(false) },
      h(
        "div",
        { class: `modal ${wide ? "modal-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
        h("h2", {}, title),
        h("div", { class: "modal-body" }, body),
        h("div", { class: "modal-actions" }, h("button", { class: "btn", onclick: () => close(false) }, "Cancel"), confirmButton),
      ),
    );
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    confirmButton.focus();
  });
}
