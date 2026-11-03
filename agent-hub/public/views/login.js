import { post } from "../lib/api.js";
import { h, setContent, spinner, toast } from "../lib/dom.js";
import { state, subscribe } from "../lib/store.js";

export function loginView(root) {
  let busy = false;
  let pendingWindow = null;

  const runtimeLine = h("div", { class: "runtime-line" });
  const flowBox = h("div", { class: "login-flow" });
  const signInButton = h("button", { class: "btn btn-primary btn-lg btn-block", onclick: () => begin("githubDotCom") }, "Sign in with GitHub");
  const gheButton = h("button", { class: "btn-link", onclick: () => begin("proxima") }, "Sign in to GitHub Enterprise Cloud (*.ghe.com)");
  const tokenInput = h("input", { class: "input", type: "password", placeholder: "github_pat_…  or  gho_…", autocomplete: "off", spellcheck: "false" });
  const hostInput = h("input", { class: "input", type: "text", value: "https://github.com", spellcheck: "false" });
  const tokenButton = h("button", { class: "btn", onclick: submitToken }, "Sign in with token");

  root.append(
    h(
      "div",
      { class: "login-wrap" },
      h(
        "div",
        { class: "card login-card" },
        h("div", { class: "login-logo", "aria-hidden": "true" }, "◆"),
        h("h1", {}, "Sign in to GitHub Copilot"),
        h(
          "p",
          { class: "muted" },
          "Agent Hub runs designer, coder and reviewer agents with your GitHub Copilot subscription through the GitHub Copilot SDK.",
        ),
        runtimeLine,
        h("div", { class: "login-actions" }, signInButton, gheButton),
        flowBox,
        h(
          "details",
          { class: "token-login" },
          h("summary", {}, "Use a token instead"),
          h(
            "div",
            { class: "stack" },
            h(
              "label",
              { class: "field" },
              h("span", { class: "field-label" }, "Token"),
              tokenInput,
              h(
                "small",
                { class: "muted" },
                "A fine-grained personal access token with the “Copilot Requests” permission, or an OAuth token (for example the output of “gh auth token”). Classic ghp_ tokens are not supported.",
              ),
            ),
            h("label", { class: "field" }, h("span", { class: "field-label" }, "GitHub host"), hostInput),
            tokenButton,
          ),
        ),
      ),
    ),
  );

  async function begin(provider) {
    if (busy) return;
    busy = true;
    render();
    // Open the tab inside the click handler so popup blockers allow it; navigate it once the URL is known.
    pendingWindow = window.open("about:blank", "_blank");
    try {
      const flow = await post("/api/auth/login", { provider });
      if (flow?.url && pendingWindow && !pendingWindow.closed) {
        pendingWindow.opener = null;
        pendingWindow.location.href = flow.url;
      } else {
        pendingWindow?.close();
      }
    } catch (error) {
      pendingWindow?.close();
      toast(error.message, "error");
    } finally {
      pendingWindow = null;
      busy = false;
      render();
    }
  }

  async function cancel(flowId) {
    try {
      await post(`/api/auth/login/${encodeURIComponent(flowId)}/cancel`);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function sendInput(flowId, value) {
    try {
      await post(`/api/auth/login/${encodeURIComponent(flowId)}/input`, { input: value });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function submitToken() {
    if (!tokenInput.value.trim()) {
      toast("Paste a token first", "error");
      return;
    }
    tokenButton.disabled = true;
    try {
      await post("/api/auth/token", { token: tokenInput.value, host: hostInput.value });
      tokenInput.value = "";
      toast("Signed in", "success");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      tokenButton.disabled = false;
    }
  }

  function render() {
    const auth = state.auth;
    const runtime = auth?.runtime ?? "starting";
    if (runtime === "ready") {
      setContent(runtimeLine, h("span", { class: "dot dot-success" }), `Copilot runtime ${auth.runtimeVersion ?? ""} ready`);
    } else if (runtime === "error") {
      setContent(runtimeLine, h("span", { class: "dot dot-danger" }), `Copilot runtime failed to start: ${auth.runtimeError ?? "unknown error"}`);
    } else {
      setContent(runtimeLine, spinner("Starting the Copilot runtime…"));
    }
    if (auth?.statusMessage && runtime === "ready" && !auth.authenticated && !auth.flow) {
      runtimeLine.append(h("span", { class: "muted" }, `· ${auth.statusMessage}`));
    }

    const flow = auth?.flow;
    const flowActive = flow && (flow.status === "pending" || flow.status === "input-required");
    signInButton.disabled = busy || runtime !== "ready" || Boolean(flowActive);
    gheButton.disabled = signInButton.disabled;

    if (!flow) {
      setContent(flowBox);
      return;
    }
    if (flow.status === "pending") {
      setContent(
        flowBox,
        h(
          "div",
          { class: "callout callout-info" },
          spinner(flow.url ? "Waiting for you to authorize in the GitHub tab…" : "Starting sign-in…"),
          flow.url
            ? h(
                "p",
                { class: "muted small" },
                "If no tab opened, ",
                h("a", { href: flow.url, target: "_blank", rel: "noopener noreferrer" }, "open the GitHub sign-in page"),
                ". After you approve access, this page continues automatically.",
              )
            : null,
          h("div", { class: "row" }, h("button", { class: "btn btn-sm", onclick: () => cancel(flow.id) }, "Cancel")),
        ),
      );
    } else if (flow.status === "input-required") {
      const input = h("input", { class: "input", type: "text", placeholder: "https://your-enterprise.ghe.com" });
      setContent(
        flowBox,
        h(
          "div",
          { class: "callout callout-info stack" },
          h("strong", {}, flow.prompt ?? "Input required"),
          input,
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn btn-primary btn-sm", onclick: () => input.value.trim() && sendInput(flow.id, input.value.trim()) }, "Continue"),
            h("button", { class: "btn btn-sm", onclick: () => cancel(flow.id) }, "Cancel"),
          ),
        ),
      );
    } else if (flow.status === "error") {
      setContent(flowBox, h("div", { class: "callout callout-danger" }, h("strong", {}, "Sign-in failed. "), flow.message ?? ""));
    } else if (flow.status === "cancelled") {
      setContent(flowBox, h("div", { class: "callout" }, flow.message ?? "Sign-in cancelled."));
    } else {
      setContent(flowBox);
    }
  }

  const unsubscribe = subscribe((kind) => kind === "auth" && render());
  render();
  return unsubscribe;
}
