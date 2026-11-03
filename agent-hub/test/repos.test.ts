import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Bus } from "../src/bus.ts";
import { RepoService } from "../src/repos.ts";
import { Store } from "../src/store.ts";
import { git } from "./helpers.ts";

test("registers a plain folder only after opting in to git init", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-repos-"));
  try {
    const folder = path.join(root, "notes");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "a.md"), "# A\n");
    const store = new Store(path.join(root, "data"));
    store.load();
    const repos = new RepoService(store, new Bus(), path.join(root, "data", "repos"));

    await assert.rejects(repos.register({ path: folder }), /not a git repository/);
    assert.equal(fs.existsSync(path.join(folder, ".git")), false);

    const repo = await repos.register({ path: folder, initGit: true });
    assert.equal(repo.name, "notes");
    assert.match(git(folder, "log", "--oneline"), /Initial commit/);
    assert.equal(git(folder, "show", "HEAD:a.md"), "# A");
    await assert.rejects(repos.register({ path: folder }), /Already registered/);
    store.flushAllSync();
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
