// Runs inside documents shown by the hub's sandboxed document viewer: renders Mermaid diagrams with a
// light theme and reports the document height so the hub UI can size the iframe to its content.
(() => {
  "use strict";

  const postHeight = () => {
    if (window.parent === window) return;
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    window.parent.postMessage({ type: "hub-doc-height", height }, "*");
  };

  const render = async () => {
    const mermaid = window.mermaid;
    const nodes = [...document.querySelectorAll("pre.mermaid, div.mermaid")];
    if (mermaid && nodes.length) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          primaryColor: "#eaf1ff",
          primaryBorderColor: "#93b4f5",
          primaryTextColor: "#1f2937",
          lineColor: "#64748b",
          secondaryColor: "#e8f7ee",
          tertiaryColor: "#fff6e5",
          fontFamily: "Segoe UI, system-ui, sans-serif",
        },
      });
      try {
        await mermaid.run({ nodes, suppressErrors: true });
      } catch (error) {
        console.warn("Diagram rendering failed", error);
      }
    }
    postHeight();
  };

  if (typeof ResizeObserver === "function") new ResizeObserver(postHeight).observe(document.documentElement);
  window.addEventListener("load", postHeight);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void render());
  else void render();
})();
