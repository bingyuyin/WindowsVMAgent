import fs from "node:fs";
import path from "node:path";
import { ROLE_LABELS, type AgentRole, type DocFormat, type StageKind } from "./types.ts";

/** Light-themed HTML templates the hub seeds design/document deliverables with. */
export interface DocTemplates {
  base: string;
  bodies: Partial<Record<StageKind, string>>;
}

export interface TemplateVars {
  title: string;
  taskId: string;
  repo: string;
  date: string;
  author: AgentRole;
  reviewer: AgentRole;
}

export const DOC_EXTENSIONS: Record<DocFormat, string> = { html: ".html", markdown: ".md" };

const PLACEHOLDER = /<[a-z][\w-]*\b[^>]*?\sdata-placeholder\b/gi;
const HUB_LOADER = /<script\b[^>]*\bdata-hub-mermaid\b[^>]*>[\s\S]*?<\/script>/gi;

export function loadDocTemplates(dir: string): DocTemplates | null {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const base = read("doc-base.html");
  if (!base) return null;
  return { base, bodies: { design: read("design-body.html"), document: read("document-body.html") } };
}

export function formatOfPath(filePath: string): DocFormat {
  return /\.html?$/i.test(filePath) ? "html" : "markdown";
}

/** Fills the template for a stage; null when there is no template for it. */
export function renderDocTemplate(templates: DocTemplates, stage: StageKind, vars: TemplateVars): string | null {
  const body = templates.bodies[stage];
  if (!body) return null;
  const values: Record<string, string> = {
    BODY: body.replace(/\s+$/, ""),
    TITLE: escapeHtml(vars.title),
    EYEBROW: stage === "design" ? "Design document" : "Documentation",
    TASK_ID: escapeHtml(vars.taskId),
    REPO: escapeHtml(vars.repo),
    DATE: escapeHtml(vars.date),
    AUTHOR: ROLE_LABELS[vars.author],
    REVIEWER: ROLE_LABELS[vars.reviewer].toLowerCase(),
  };
  // Single pass, so substituted values are never re-scanned for {{KEYS}}.
  return templates.base.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}

/** Why a submitted document is not acceptable yet, or null when it is. */
export function documentProblem(content: string | null | undefined, format: DocFormat, seeded?: string | null): string | null {
  if (!content?.trim()) return "is missing or empty";
  if (format !== "html") return null;
  if (seeded && normalizeWhitespace(content) === normalizeWhitespace(seeded)) return "is still the unmodified template";
  const placeholders = content.match(PLACEHOLDER)?.length ?? 0;
  if (placeholders) {
    return (
      `still has ${placeholders} template placeholder element${placeholders === 1 ? "" : "s"} (elements with a data-placeholder attribute). ` +
      "Replace each one with real content and remove the attribute, or delete sections that do not apply"
    );
  }
  if (!/<h1[\s>]/i.test(content)) return "has no <h1> title";
  return null;
}

/** Shrinks an HTML document for inclusion in a prompt (drops styles, scripts and comments). */
export function docForPrompt(content: string, format: DocFormat): string {
  if (format !== "html") return content;
  return content
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style>/* template styles omitted */</style>")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n\s*\n\s*\n+/g, "\n\n");
}

/** Prepares an HTML document for the hub's sandboxed viewer: swaps the CDN loader for local scripts. */
export function docForViewer(content: string, scripts: readonly string[]): string {
  let html = content.replace(HUB_LOADER, "");
  const tags = scripts.map((src) => `<script src="${escapeHtml(src)}"></script>`).join("\n");
  const close = html.toLowerCase().lastIndexOf("</body>");
  html = close >= 0 ? `${html.slice(0, close)}${tags}\n${html.slice(close)}` : `${html}\n${tags}`;
  return html;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
