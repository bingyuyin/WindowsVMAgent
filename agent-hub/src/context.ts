import fs from "node:fs";
import path from "node:path";
import { git, readFileAt } from "./git.ts";
import type { AgentRole, ContextSkill, RepoContext } from "./types.ts";
import { nowIso, truncate } from "./util.ts";

/**
 * Repository guidance the hub looks for. Root instruction files are also auto-loaded by the Copilot
 * runtime from each agent's working directory; the rest is surfaced to agents in their prompt.
 */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursorrules"];
const AUTO_LOADED_INSTRUCTIONS = /^(AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.github\/copilot-instructions\.md|\.github\/instructions\/.+\.instructions\.md)$/i;
const GUIDE_PATTERNS = [
  /^(\.github\/|docs\/)?CONTRIBUTING\.md$/i,
  /^(docs\/)?ARCHITECTURE\.md$/i,
  /^(docs\/)?DESIGN\.md$/i,
  /^(docs\/)?(CODING[-_]?GUIDELINES|STYLE[-_]?GUIDE|STYLEGUIDE|CONVENTIONS|DEVELOPMENT|DEVELOPING|TESTING)\.md$/i,
  /^(\.github\/)?SECURITY\.md$/i,
  /^README\.md$/i,
  // CI pipelines show how the project is built and how its tests run.
  /^\.github\/workflows\/[^/]+\.ya?ml$/i,
  /^(\.azure-pipelines\/|\.pipelines\/)?azure-pipelines[^/]*\.ya?ml$/i,
];
const DESIGN_DOCS = /^(docs\/)?(design|designs|adr|adrs|rfc|rfcs|decisions|architecture|specs?)\/.+\.(md|html?)$/i;
const SKILL_ROOTS = [".github/skills", ".copilot/skills", ".claude/skills", "skills"];
const MAX_LISTED = 25;

/** Skills bundled with the hub, applied when the repository has no guidance of its own. */
export const ROLE_SKILLS: Record<AgentRole, string[]> = {
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

/** Hub skills with the best practices of each technology, keyed by the stack labels `discoverContext` reports. */
const STACK_SKILLS: Record<string, string> = {
  "Node.js": "typescript-best-practices",
  TypeScript: "typescript-best-practices",
  ".NET": "dotnet-best-practices",
  Python: "python-best-practices",
  Go: "go-best-practices",
  Rust: "rust-best-practices",
  "Java (Maven)": "java-best-practices",
  "JVM (Gradle)": "java-best-practices",
  PowerShell: "powershell-best-practices",
  "C/C++": "cpp-best-practices",
};

/** Roles that design, write, review or test code also apply the best practices of the repository's technologies. */
const TECH_ROLES: ReadonlySet<AgentRole> = new Set(["designer", "design-reviewer", "coder", "resolver", "code-reviewer", "executor", "fixer", "lead-reviewer", "peer-reviewer"]);

export function techSkillsFor(stack: readonly string[]): string[] {
  return [...new Set(stack.map((label) => STACK_SKILLS[label]).filter((skill): skill is string => Boolean(skill)))];
}

/** Hub skills an agent is asked to load: its role's skills plus the skills for the repository's technologies. */
export function skillsForRole(role: AgentRole, context: Pick<RepoContext, "stack"> | undefined): string[] {
  const tech = TECH_ROLES.has(role) ? techSkillsFor(context?.stack ?? []) : [];
  return [...new Set([...ROLE_SKILLS[role], ...tech])];
}

/** Instruction files the Copilot runtime loads by itself (from the root of the agent's worktree). */
export function isAutoLoadedInstruction(file: string): boolean {
  return AUTO_LOADED_INSTRUCTIONS.test(file);
}

export interface HubSkills {
  dir: string | null;
  skills: ContextSkill[];
}

export function loadHubSkills(dir: string): HubSkills {
  if (!fs.existsSync(dir)) return { dir: null, skills: [] };
  const skills: ContextSkill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !fs.existsSync(file)) continue;
    const meta = parseFrontmatter(fs.readFileSync(file, "utf8"));
    skills.push({ name: meta.name || entry.name, description: meta.description, path: entry.name, source: "hub" });
  }
  return { dir, skills };
}

/** Scans the repository at a commit for instructions, guides, design docs, skills and build/test commands. */
export async function discoverContext(repoPath: string, sha: string): Promise<RepoContext> {
  const listing = await git(repoPath, ["ls-tree", "-r", "--name-only", "--full-tree", sha], { maxBuffer: 512 * 1024 * 1024 });
  const files = listing.stdout.split(/\r?\n/).filter(Boolean);
  const lower = new Map(files.map((file) => [file.toLowerCase(), file]));
  const find = (candidate: string) => lower.get(candidate.toLowerCase());

  const instructions = [
    ...INSTRUCTION_FILES.map(find).filter((file): file is string => Boolean(file)),
    ...files.filter((file) => /^\.github\/instructions\/.+\.instructions\.md$/i.test(file)),
    // Folder-level agent instructions (monorepos); the runtime only loads the root one.
    ...files.filter((file) => /.\/AGENTS\.md$/i.test(file)),
  ].slice(0, MAX_LISTED);
  const guides = GUIDE_PATTERNS.flatMap((pattern) => files.filter((file) => pattern.test(file))).slice(0, MAX_LISTED);
  const designDocs = files.filter((file) => DESIGN_DOCS.test(file)).slice(0, MAX_LISTED);

  const skills: ContextSkill[] = [];
  const skillRoots: string[] = [];
  for (const root of SKILL_ROOTS) {
    const pattern = new RegExp(`^${root.replace(/\./g, "\\.")}/[^/]+/SKILL\\.md$`, "i");
    const found = files.filter((file) => pattern.test(file)).slice(0, MAX_LISTED);
    if (!found.length) continue;
    skillRoots.push(found[0]!.split("/").slice(0, -2).join("/"));
    for (const file of found) {
      const meta = parseFrontmatter((await readFileAt(repoPath, sha, file)) ?? "");
      skills.push({ name: meta.name || file.split("/").at(-2)!, description: meta.description, path: file, source: "repo" });
    }
  }

  const { validation, stack } = await detectToolchain(repoPath, sha, files, find);
  return { instructions, guides, designDocs, skills, skillRoots, validation, stack, techSkills: techSkillsFor(stack), discoveredAt: nowIso() };
}

async function detectToolchain(
  repoPath: string,
  sha: string,
  files: string[],
  find: (candidate: string) => string | undefined,
): Promise<{ validation: string[]; stack: string[] }> {
  const validation: string[] = [];
  const stack: string[] = [];
  const packageJson = find("package.json");
  if (packageJson) {
    stack.push("Node.js");
    const runner = find("pnpm-lock.yaml") ? "pnpm" : find("yarn.lock") ? "yarn" : "npm";
    try {
      const scripts = (JSON.parse((await readFileAt(repoPath, sha, packageJson)) ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {};
      for (const name of ["build", "typecheck", "lint", "test"]) {
        if (!scripts[name]) continue;
        validation.push(name === "test" ? `${runner} test` : `${runner} run ${name}`);
      }
    } catch {
      // Malformed package.json: ignore scripts.
    }
  }
  if (find("tsconfig.json")) stack.push("TypeScript");
  const csproj = files.filter((file) => /\.(csproj|fsproj|sln|slnx)$/i.test(file));
  if (csproj.length) {
    stack.push(".NET");
    validation.push("dotnet build");
    if (csproj.some((file) => /test/i.test(file))) validation.push("dotnet test");
  }
  if (find("go.mod")) {
    stack.push("Go");
    validation.push("go build ./...", "go test ./...");
  }
  if (find("Cargo.toml")) {
    stack.push("Rust");
    validation.push("cargo build", "cargo test");
  }
  if (find("pyproject.toml") || find("setup.py") || find("requirements.txt")) {
    stack.push("Python");
    if (files.some((file) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(file)) || find("pytest.ini")) validation.push("pytest");
  }
  if (find("pom.xml")) {
    stack.push("Java (Maven)");
    validation.push("mvn -q test");
  }
  if (find("build.gradle") || find("build.gradle.kts")) {
    stack.push("JVM (Gradle)");
    validation.push(find("gradlew") ? "./gradlew test" : "gradle test");
  }
  const makefile = find("Makefile");
  if (makefile) {
    const content = (await readFileAt(repoPath, sha, makefile)) ?? "";
    for (const target of ["build", "lint", "test"]) {
      if (new RegExp(`^${target}\\s*:`, "m").test(content)) validation.push(`make ${target}`);
    }
  }
  const cmake = find("CMakeLists.txt");
  if (cmake || files.some((file) => /\.vcxproj$/i.test(file)) || find("meson.build")) {
    if (files.some((file) => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|ixx)$/i.test(file))) stack.push("C/C++");
    if (cmake) {
      validation.push("cmake -S . -B build", "cmake --build build");
      if (/\b(enable_testing|add_test)\s*\(/i.test((await readFileAt(repoPath, sha, cmake)) ?? "")) validation.push("ctest --test-dir build --output-on-failure");
    }
  }
  if (files.some((file) => /\.(ps1|psm1|psd1)$/i.test(file))) {
    stack.push("PowerShell");
    if (files.some((file) => /\.tests\.ps1$/i.test(file))) validation.push("Invoke-Pester");
  }
  return { validation: [...new Set(validation)], stack: [...new Set(stack)] };
}

export function parseFrontmatter(markdown: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  const read = (key: string) => {
    const line = match?.[1]?.split(/\r?\n/).find((candidate) => candidate.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  };
  return { name: read("name"), description: truncate(read("description"), 300) };
}

export function describeContext(context: RepoContext): string {
  const parts = [
    context.instructions.length ? `${context.instructions.length} instruction file(s)` : null,
    context.guides.length ? `${context.guides.length} guide(s)` : null,
    context.designDocs.length ? `${context.designDocs.length} design doc(s)` : null,
    context.skills.length ? `${context.skills.length} repo skill(s)` : null,
    context.validation.length ? `validation: ${context.validation.join(", ")}` : null,
    context.techSkills?.length ? `best practices: ${context.techSkills.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no repository guidance found; agents use the hub's best-practice skills";
}
