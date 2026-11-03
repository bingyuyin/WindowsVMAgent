import fs from "node:fs";
import path from "node:path";
import type { Bus } from "./bus.ts";
import { cloneRepo, inspectRepo, listBranches } from "./git.ts";
import type { Store } from "./store.ts";
import { ACTIVE_STATUSES, type Repo } from "./types.ts";
import { errorMessage, HttpError, nowIso, slugify } from "./util.ts";

export interface RegisterRepoInput {
  path?: string;
  cloneUrl?: string;
  name?: string;
}

const CLONE_URL = /^(https:\/\/|ssh:\/\/|git@)[^\s]+$/i;

export class RepoService {
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly reposDir: string;

  constructor(store: Store, bus: Bus, reposDir: string) {
    this.store = store;
    this.bus = bus;
    this.reposDir = reposDir;
  }

  list(): readonly Repo[] {
    return this.store.repos;
  }

  get(id: string): Repo {
    const repo = this.store.getRepo(id);
    if (!repo) throw new HttpError(404, `Repository ${id} not found`);
    return repo;
  }

  async register(input: RegisterRepoInput): Promise<Repo> {
    const requestedName = typeof input.name === "string" ? input.name.trim() : "";
    let directory: string;
    if (typeof input.cloneUrl === "string" && input.cloneUrl.trim()) {
      const url = input.cloneUrl.trim();
      if (!CLONE_URL.test(url)) throw new HttpError(400, "Clone URL must start with https://, ssh:// or git@");
      const name = requestedName || repoNameFromUrl(url);
      directory = input.path?.trim() ? path.resolve(input.path.trim()) : path.join(this.reposDir, slugify(name, 60));
      if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
        throw new HttpError(409, `Clone destination already exists and is not empty: ${directory}`);
      }
      try {
        await cloneRepo(url, directory);
      } catch (error) {
        throw new HttpError(400, `Clone failed: ${errorMessage(error)}`);
      }
    } else if (typeof input.path === "string" && input.path.trim()) {
      directory = path.resolve(input.path.trim());
    } else {
      throw new HttpError(400, "Provide a local repository path or a clone URL");
    }

    let info;
    try {
      info = await inspectRepo(directory);
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
    if (!info.headSha) throw new HttpError(400, "The repository has no commits yet; commit something first");
    const existing = this.store.repos.find((repo) => samePath(repo.path, info.root));
    if (existing) throw new HttpError(409, `Already registered as '${existing.name}'`);

    const name = requestedName || path.basename(info.root);
    const repo: Repo = {
      id: this.uniqueId(slugify(name, 40)),
      name,
      path: info.root,
      defaultBranch: info.branch ?? "HEAD",
      remoteUrl: info.remoteUrl,
      addedAt: nowIso(),
    };
    this.store.addRepo(repo);
    this.bus.publishGlobal({ type: "repos", repos: this.store.repos });
    return repo;
  }

  remove(id: string): void {
    const repo = this.get(id);
    const active = this.store.tasks.some((task) => task.repoId === repo.id && ACTIVE_STATUSES.includes(task.status));
    if (active) throw new HttpError(409, "This repository has active tasks; cancel them first");
    this.store.removeRepo(id);
    this.bus.publishGlobal({ type: "repos", repos: this.store.repos });
  }

  async branches(id: string): Promise<{ branches: string[]; current: string | null }> {
    const repo = this.get(id);
    try {
      const [branches, info] = await Promise.all([listBranches(repo.path), inspectRepo(repo.path)]);
      return { branches, current: info.branch };
    } catch (error) {
      throw new HttpError(400, errorMessage(error));
    }
  }

  private uniqueId(base: string): string {
    let candidate = base;
    for (let i = 2; this.store.getRepo(candidate); i++) candidate = `${base}-${i}`;
    return candidate;
  }
}

function repoNameFromUrl(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "repo";
  return last.replace(/\.git$/i, "") || "repo";
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
