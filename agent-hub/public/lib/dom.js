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

export const ROLE_LABELS = {
  designer: "Designer",
  "design-reviewer": "Design reviewer",
  coder: "Coder",
  resolver: "Comment resolver",
  "code-reviewer": "Code reviewer",
};

export const ROLE_ICONS = { designer: "✎", "design-reviewer": "◎", coder: "⌨", resolver: "⚒", "code-reviewer": "◎" };

export const ROLE_DESCRIPTIONS = {
  designer: "Writes the design document and revises it for review comments",
  "design-reviewer": "Reviews the design in a read-only worktree",
  coder: "Implements the request on its own branch",
  resolver: "Resolves code review comments on its own branch",
  "code-reviewer": "Reviews each commit in a read-only worktree pinned to it",
};

/** Hub best-practice skills each role is asked to apply (mirrors the server's ROLE_SKILLS). */
export const ROLE_SKILLS = {
  designer: ["system-design"],
  "design-reviewer": ["design-review"],
  coder: ["coding-best-practices"],
  resolver: ["review-comment-resolution", "coding-best-practices"],
  "code-reviewer": ["code-review"],
};

/** Sub-agents a task kind uses, in workflow order. */
export function rolesFor(kind) {
  if (kind === "design") return ["designer", "design-reviewer"];
  if (kind === "design-coding") return ["designer", "design-reviewer", "coder", "code-reviewer", "resolver"];
  return ["coder", "code-reviewer", "resolver"];
}

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

export const KIND_LABELS = { coding: "Coding", design: "Design", "design-coding": "Design → Coding" };
export const STAGE_LABELS = { design: "Design", coding: "Coding" };

export function phaseLabel(stage, phase) {
  switch (phase) {
    case "authoring":
      return stage === "design" ? "Designing" : "Coding";
    case "reviewing":
      return stage === "design" ? "Reviewing design" : "Reviewing code";
    case "revising":
      return stage === "design" ? "Revising design" : "Resolving review comments";
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
      return { label: phaseLabel(task.currentStage, task.phase), cls: "running" };
    case "needs-input":
      return { label: "Needs your input", cls: "attention" };
    case "completed": {
      const approved = task.approved ?? task.result?.approved;
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
export function confirmDialog({ title, body, confirmText = "Confirm", danger = false }) {
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
        { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title },
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
