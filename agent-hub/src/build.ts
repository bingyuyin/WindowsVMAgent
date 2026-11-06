import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** What code the hub runs: its version, the git commit of its checkout and a fingerprint of the browser files it serves. */
export interface BuildInfo {
  version: string;
  /** Short commit of the hub's checkout, with "+changes" when its files differ from it; null outside a git checkout. */
  commit: string | null;
  /** Fingerprint of the browser files: a page loaded from different files is out of date. */
  ui: string;
}

export function readBuildInfo(projectRoot: string, publicDir: string): BuildInfo {
  let version = "unknown";
  try {
    version = (JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version?: string }).version ?? version;
  } catch {
    // Keep "unknown".
  }
  return { version, commit: gitCommit(projectRoot), ui: fingerprint(publicDir) };
}

function gitCommit(dir: string): string | null {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = run(["rev-parse", "--short", "HEAD"]);
    if (!sha) return null;
    const changed = run(["status", "--porcelain", "--untracked-files=no", "--", "."]) !== "";
    return changed ? `${sha}+changes` : sha;
  } catch {
    return null;
  }
}

/** Hash of every file under `dir` (relative paths and contents): any change to the files changes it. */
export function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        hash.update(path.relative(dir, full).replaceAll("\\", "/"));
        hash.update("\0");
        hash.update(fs.readFileSync(full));
        hash.update("\0");
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hash.digest("hex").slice(0, 12);
}

/** "v0.1.0 (ea2113d)" */
export function describeBuild(build: Pick<BuildInfo, "version" | "commit">): string {
  return `v${build.version}${build.commit ? ` (${build.commit})` : ""}`;
}
