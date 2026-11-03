import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  host: string;
  port: number;
  projectRoot: string;
  publicDir: string;
  /** Best-practice skills bundled with the hub (fallback when a repository has no guidance). */
  skillsDir: string;
  /** Light-themed HTML templates for design and document deliverables. */
  templatesDir: string;
  /** Browser bundles served from node_modules (URL path -> file). */
  vendorFiles: Record<string, string>;
  dataDir: string;
  worktreesDir: string;
  reposDir: string;
  /** COPILOT_HOME for the hub's runtime: isolates its sessions, config and sign-in from ~/.copilot. */
  copilotHome: string;
  runtimeLogLevel: "none" | "error" | "warning" | "info" | "debug" | "all";
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_LEVELS = ["none", "error", "warning", "info", "debug", "all"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(env.HUB_DATA_DIR ?? path.join(projectRoot, "data"));
  const port = Number(env.HUB_PORT ?? env.PORT ?? 4600);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid HUB_PORT: ${env.HUB_PORT ?? env.PORT}`);
  }
  const level = env.HUB_RUNTIME_LOG_LEVEL ?? "error";
  return {
    host: env.HUB_HOST ?? "127.0.0.1",
    port,
    projectRoot,
    publicDir: path.join(projectRoot, "public"),
    skillsDir: path.join(projectRoot, "skills"),
    templatesDir: path.join(projectRoot, "templates"),
    vendorFiles: { "/vendor/mermaid.min.js": path.join(projectRoot, "node_modules", "mermaid", "dist", "mermaid.min.js") },
    dataDir,
    worktreesDir: path.join(dataDir, "worktrees"),
    reposDir: path.join(dataDir, "repos"),
    copilotHome: path.resolve(env.HUB_COPILOT_HOME ?? path.join(dataDir, "copilot-home")),
    runtimeLogLevel: (LOG_LEVELS as readonly string[]).includes(level) ? (level as AppConfig["runtimeLogLevel"]) : "error",
  };
}
