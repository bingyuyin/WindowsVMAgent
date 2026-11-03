import path from "node:path";
import type { Bus, TaskMessage } from "../bus.ts";
import type { CopilotService, LoginProvider } from "../copilot/service.ts";
import { docForViewer, escapeHtml } from "../docs.ts";
import type { RepoService } from "../repos.ts";
import type { Store } from "../store.ts";
import { DOC_FORMATS, ISOLATION_MODES, MAX_PARALLEL_TASKS, type DocFormat, type IsolationMode, type Settings, type TaskKind } from "../types.ts";
import { HttpError } from "../util.ts";
import type { TaskRunner } from "../workflow/runner.ts";
import { summarizeTask } from "../workflow/summary.ts";
import { openSse, Router } from "./server.ts";

/** Scripts injected into HTML documents shown in the sandboxed viewer (Mermaid + diagram rendering). */
export const DOC_VIEWER_SCRIPTS = ["/vendor/mermaid.min.js", "/lib/doc-viewer.js"];

export interface ApiDeps {
  store: Store;
  bus: Bus;
  copilot: CopilotService;
  runner: TaskRunner;
  repos: RepoService;
  version: string;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { store, bus, copilot, runner, repos } = deps;
  const router = new Router();

  router.get("/api/health", () => ({ ok: true, version: deps.version }));

  // ---- Authentication & models -------------------------------------------------------------
  router.get("/api/auth", () => copilot.getState());

  router.post("/api/auth/login", async ({ body }) => {
    const provider = (body.provider ?? "githubDotCom") as LoginProvider;
    if (provider !== "githubDotCom" && provider !== "proxima") throw new HttpError(400, "Unsupported sign-in provider");
    return copilot.beginLogin(provider);
  });

  router.post("/api/auth/login/:flowId/input", ({ params, body }) => {
    try {
      copilot.submitLoginInput(params.flowId!, requireString(body, "input", 500));
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(409, (error as Error).message);
    }
    return { ok: true };
  });

  router.post("/api/auth/login/:flowId/cancel", async ({ params }) => {
    await copilot.cancelLogin(params.flowId);
    return copilot.getState();
  });

  router.post("/api/auth/token", async ({ body }) => {
    const host = optionalString(body, "host", 200) || "https://github.com";
    if (!/^https:\/\/[\w.-]+$/i.test(host)) throw new HttpError(400, "Host must look like https://github.com or https://<name>.ghe.com");
    try {
      return await copilot.loginWithToken(requireString(body, "token", 2000), host);
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(400, (error as Error).message);
    }
  });

  router.post("/api/auth/logout", async () => {
    if (runner.hasActiveTasks()) throw new HttpError(409, "Cancel or finish active tasks before signing out");
    await copilot.logout();
    return copilot.getState();
  });

  router.get("/api/models", async ({ url }) => {
    if (!copilot.isReady()) throw new HttpError(401, "Sign in first");
    return copilot.listModels(url.searchParams.get("refresh") === "1");
  });

  // ---- Settings --------------------------------------------------------------------------
  router.get("/api/settings", () => store.settings);

  router.put("/api/settings", ({ body }) => {
    const settings = store.updateSettings(parseSettingsPatch(body));
    bus.publishGlobal({ type: "settings", settings });
    runner.pump();
    return settings;
  });

  router.get("/api/storage", () => store.storageInfo());

  // ---- Manager & agents ------------------------------------------------------------------
  router.get("/api/agents/overview", ({ url }) => {
    const limit = Number(url.searchParams.get("limit"));
    return runner.overview({
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : undefined,
      taskId: url.searchParams.get("taskId") ?? undefined,
    });
  });

  // ---- Repositories ----------------------------------------------------------------------
  router.get("/api/repos", () => repos.list());
  router.post("/api/repos", ({ body }) =>
    repos.register({
      path: optionalString(body, "path", 1000),
      cloneUrl: optionalString(body, "cloneUrl", 1000),
      name: optionalString(body, "name", 100),
      initGit: body.initGit === true,
    }),
  );
  router.delete("/api/repos/:id", ({ params }) => {
    repos.remove(params.id!);
    return { ok: true };
  });
  router.get("/api/repos/:id/branches", ({ params }) => repos.branches(params.id!));

  // ---- Tasks -----------------------------------------------------------------------------
  router.get("/api/tasks", () =>
    [...store.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summarizeTask),
  );

  router.post("/api/tasks", async ({ body }) => {
    const maxRounds = body.maxRounds === undefined || body.maxRounds === "" ? undefined : Number(body.maxRounds);
    return runner.submit({
      title: optionalString(body, "title", 200),
      description: requireString(body, "description", 50_000),
      kind: requireString(body, "kind", 40) as TaskKind,
      repoId: requireString(body, "repoId", 200),
      baseRef: optionalString(body, "baseRef", 300),
      authorModel: optionalString(body, "authorModel", 200),
      reviewerModel: optionalString(body, "reviewerModel", 200),
      resolverModel: optionalString(body, "resolverModel", 200),
      managerModel: optionalString(body, "managerModel", 200),
      maxRounds,
    });
  });

  router.get("/api/tasks/:id", async ({ params }) => {
    const task = runner.get(params.id!);
    return { task, events: await store.readEvents(task.id, { limit: 1500 }) };
  });

  router.post("/api/tasks/:id/cancel", ({ params }) => runner.cancel(params.id!));

  router.post("/api/tasks/:id/retry", ({ params, body }) => {
    const extra = body.extraRounds === undefined ? undefined : Number(body.extraRounds);
    return runner.retry(params.id!, extra);
  });

  router.post("/api/tasks/:id/change-request", ({ params, body }) =>
    runner.requestChanges(params.id!, {
      request: requireString(body, "request", 20_000),
      stage: optionalString(body, "stage", 40) || undefined,
      rounds: body.rounds === undefined || body.rounds === null || body.rounds === "" ? undefined : Number(body.rounds),
    }),
  );

  router.post("/api/tasks/:id/input", ({ params, body }) => {
    runner.answer(params.id!, requireString(body, "inputId", 100), requireString(body, "answer", 10_000));
    return { ok: true };
  });

  router.delete("/api/tasks/:id", async ({ params, body }) => {
    await runner.remove(params.id!, { deleteBranch: body.deleteBranch === true });
    return { ok: true };
  });

  router.get("/api/tasks/:id/diff", ({ params, url }) =>
    runner.diff(params.id!, url.searchParams.get("from") ?? undefined, url.searchParams.get("to") ?? undefined),
  );

  router.post("/api/tasks/:id/push", ({ params }) => runner.pushNow(params.id!));
  router.get("/api/tasks/:id/pull-request", ({ params }) => runner.pullRequestStatus(params.id!));
  router.post("/api/tasks/:id/pull-request", ({ params }) => runner.pullRequest(params.id!));

  const documentRound = (url: URL) => {
    const round = Number(url.searchParams.get("round"));
    return Number.isInteger(round) && round > 0 ? round : undefined;
  };
  router.get("/api/tasks/:id/doc", ({ params, url }) => runner.document(params.id!, documentRound(url)));
  router.get("/api/tasks/:id/design", ({ params, url }) => runner.document(params.id!, documentRound(url)));

  // Serves the document as a standalone page for the UI's sandboxed iframe (or a new tab). The page runs
  // in an opaque origin (CSP sandbox) and may only load the hub's local Mermaid scripts.
  router.get(
    "/api/tasks/:id/doc/view",
    async ({ req, res, params, url }) => {
      const doc = await runner.document(params.id!, documentRound(url));
      if (doc.content === null) throw new HttpError(404, "No document has been written yet");
      const origin = `http://${req.headers.host ?? ""}`;
      const html =
        doc.format === "html"
          ? docForViewer(doc.content, DOC_VIEWER_SCRIPTS)
          : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(doc.path ?? "Document")}</title></head>` +
            `<body><pre style="white-space: pre-wrap; font: 14px/1.6 Consolas, monospace; padding: 24px">${escapeHtml(doc.content)}</pre></body></html>`;
      res.removeHeader("X-Frame-Options");
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src ${origin}; style-src 'unsafe-inline'; img-src data: ${origin}; font-src data:; ` +
          `frame-ancestors ${origin}; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-popups`,
      );
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    },
    { raw: true },
  );

  // ---- Live updates (Server-Sent Events) ---------------------------------------------------
  router.get(
    "/api/stream",
    ({ req, res }) => {
      const sse = openSse(req, res);
      sse.send({ type: "hello", auth: copilot.getState(), settings: store.settings });
      sse.onClose(bus.onGlobal((message) => sse.send(message)));
    },
    { raw: true },
  );

  router.get(
    "/api/tasks/:id/stream",
    async ({ req, res, params, url }) => {
      const task = runner.get(params.id!);
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const sse = openSse(req, res);
      // Buffer live messages while replaying history so nothing is lost or duplicated.
      const buffered: TaskMessage[] = [];
      let live = false;
      sse.onClose(bus.onTask(task.id, (message) => (live ? sse.send(message) : buffered.push(message))));
      let lastSeq = after;
      for (const event of await store.readEvents(task.id, { after, limit: 2000 })) {
        sse.send({ type: "event", event });
        lastSeq = event.seq;
      }
      sse.send({ type: "task", task });
      for (const message of buffered) {
        if (message.type !== "event" || message.event.seq > lastSeq) sse.send(message);
      }
      live = true;
    },
    { raw: true },
  );

  return router;
}

function requireString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `'${key}' is required`);
  if (value.length > maxLength) throw new HttpError(400, `'${key}' is too long`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `'${key}' must be a string`);
  if (value.length > maxLength) throw new HttpError(400, `'${key}' is too long`);
  return value.trim() || undefined;
}

function intIn(value: unknown, min: number, max: number, key: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `'${key}' must be an integer between ${min} and ${max}`);
  }
  return number;
}

export function parseSettingsPatch(body: Record<string, unknown>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of ["authorModel", "reviewerModel", "resolverModel", "managerModel"] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value !== null && typeof value !== "string") throw new HttpError(400, `'${key}' must be a string`);
    patch[key] = typeof value === "string" && value.trim() ? value.trim() : null;
  }
  if ("isolation" in body) {
    if (!ISOLATION_MODES.includes(body.isolation as IsolationMode)) throw new HttpError(400, `'isolation' must be one of: ${ISOLATION_MODES.join(", ")}`);
    patch.isolation = body.isolation as IsolationMode;
  }
  if ("cleanupWorktrees" in body) {
    if (typeof body.cleanupWorktrees !== "boolean") throw new HttpError(400, "'cleanupWorktrees' must be a boolean");
    patch.cleanupWorktrees = body.cleanupWorktrees;
  }
  if ("resumeInterruptedTasks" in body) {
    if (typeof body.resumeInterruptedTasks !== "boolean") throw new HttpError(400, "'resumeInterruptedTasks' must be a boolean");
    patch.resumeInterruptedTasks = body.resumeInterruptedTasks;
  }
  if ("pushOnComplete" in body) {
    if (typeof body.pushOnComplete !== "boolean") throw new HttpError(400, "'pushOnComplete' must be a boolean");
    patch.pushOnComplete = body.pushOnComplete;
  }
  if ("docFormat" in body) {
    if (!DOC_FORMATS.includes(body.docFormat as DocFormat)) throw new HttpError(400, `'docFormat' must be one of: ${DOC_FORMATS.join(", ")}`);
    patch.docFormat = body.docFormat as DocFormat;
  }
  if ("maxRounds" in body) patch.maxRounds = intIn(body.maxRounds, 1, 10, "maxRounds");
  if ("maxConcurrency" in body) patch.maxConcurrency = intIn(body.maxConcurrency, 1, MAX_PARALLEL_TASKS, "maxConcurrency");
  if ("turnTimeoutMinutes" in body) patch.turnTimeoutMinutes = intIn(body.turnTimeoutMinutes, 5, 600, "turnTimeoutMinutes");
  if ("stuckAgentMinutes" in body) patch.stuckAgentMinutes = intIn(body.stuckAgentMinutes, 3, 240, "stuckAgentMinutes");
  if ("inputTimeoutMinutes" in body) patch.inputTimeoutMinutes = intIn(body.inputTimeoutMinutes, 1, 1440, "inputTimeoutMinutes");
  if ("designDocDir" in body) patch.designDocDir = repoFolder(body.designDocDir, "designDocDir");
  if ("documentDir" in body) patch.documentDir = repoFolder(body.documentDir, "documentDir");
  return patch;
}

function repoFolder(value: unknown, key: string): string {
  const raw = String(value ?? "").trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!raw || path.isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.split("/").includes("..")) {
    throw new HttpError(400, `'${key}' must be a relative folder inside the repository`);
  }
  return raw;
}
