import { put } from "./api.js";
import { h, toast } from "./dom.js";
import { notify, state } from "./store.js";

export const MAX_PARALLEL_TASKS = 10;

/**
 * A live "Parallel tasks" stepper. Changes are saved right away and apply immediately: raising the limit
 * starts queued tasks at once; lowering it lets running tasks finish while new ones wait.
 * Call update() when settings change elsewhere (other tabs receive them over the live stream).
 */
export function parallelControl({ label = "Parallel tasks" } = {}) {
  let pending = null;
  let timer = null;
  const value = h("span", { class: "parallel-value mono", "aria-live": "polite" });
  const minus = h("button", { class: "btn btn-xs parallel-step", type: "button", "aria-label": "Run fewer tasks in parallel", onclick: () => change(-1) }, "−");
  const plus = h("button", { class: "btn btn-xs parallel-step", type: "button", "aria-label": "Run more tasks in parallel", onclick: () => change(1) }, "+");
  const el = h(
    "span",
    { class: "parallel-control", title: `How many tasks run at the same time (1-${MAX_PARALLEL_TASKS}). Changes apply immediately; extra tasks wait in the queue.` },
    label ? h("span", { class: "parallel-label" }, label) : null,
    minus,
    value,
    plus,
  );

  const current = () => pending ?? state.settings?.maxConcurrency ?? MAX_PARALLEL_TASKS;

  function update() {
    const n = current();
    value.textContent = String(n);
    minus.disabled = n <= 1;
    plus.disabled = n >= MAX_PARALLEL_TASKS;
    el.classList.toggle("saving", pending !== null);
  }

  function change(delta) {
    pending = Math.min(MAX_PARALLEL_TASKS, Math.max(1, current() + delta));
    update();
    clearTimeout(timer);
    // Debounced so several clicks become one change.
    timer = setTimeout(save, 400);
  }

  async function save() {
    const target = pending;
    if (target === null) return;
    try {
      state.settings = await put("/api/settings", { maxConcurrency: target });
      notify("settings");
      toast(`Up to ${target} task${target === 1 ? "" : "s"} now run in parallel`, "success");
    } catch (error) {
      toast(`Could not change parallel tasks: ${error.message}`, "error");
    } finally {
      if (pending === target) pending = null;
      update();
    }
  }

  update();
  return { el, update };
}
