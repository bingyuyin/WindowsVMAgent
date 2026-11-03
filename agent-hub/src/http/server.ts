import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { errorMessage, HttpError } from "../util.ts";

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

type Handler = (ctx: RequestContext) => unknown;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  /** Raw handlers write the response themselves (used for Server-Sent Events). */
  raw: boolean;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, options: { raw?: boolean } = {}): void {
    const keys: string[] = [];
    const source = pattern.replace(/:(\w+)/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler, raw: options.raw ?? false });
  }

  get(pattern: string, handler: Handler, options?: { raw?: boolean }): void {
    this.add("GET", pattern, handler, options);
  }
  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }
  put(pattern: string, handler: Handler): void {
    this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: Handler): void {
    this.add("DELETE", pattern, handler);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | "method-not-allowed" | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? "");
      });
      return { route, params };
    }
    return pathMatched ? "method-not-allowed" : null;
  }
}

export interface ServerOptions {
  host: string;
  port: number;
  publicDir: string;
  router: Router;
  /** Extra static files outside `publicDir` (URL path -> absolute file), e.g. vendored browser bundles. */
  vendor?: Record<string, string>;
}

export function createHttpServer(options: ServerOptions): http.Server {
  const allowedHosts = new Set(
    ["localhost", "127.0.0.1", "[::1]", options.host].map((host) => `${host}:${options.port}`.toLowerCase()),
  );
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));

  return http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      console.error("[http] unhandled error:", error);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    const method = (req.method ?? "GET").toUpperCase();

    // DNS-rebinding and CSRF protection: only same-origin requests to a loopback host name.
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      sendJson(res, 403, { error: "Forbidden host" });
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin?.toLowerCase();
      if (origin && !allowedOrigins.has(origin)) {
        sendJson(res, 403, { error: "Cross-origin request blocked" });
        return;
      }
      if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith("/api/")) {
      const vendorFile = options.vendor?.[url.pathname];
      if (vendorFile) serveFile(vendorFile, method, res, "public, max-age=86400");
      else serveStatic(options.publicDir, url.pathname, method, res);
      return;
    }

    const matched = options.router.match(method, url.pathname);
    if (matched === null) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (matched === "method-not-allowed") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }
    try {
      const body = method === "GET" || method === "HEAD" ? {} : await readJsonBody(req);
      const result = await matched.route.handler({ req, res, url, params: matched.params, body });
      if (!matched.route.raw && !res.headersSent) sendJson(res, 200, result ?? { ok: true });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(`[http] ${method} ${url.pathname} failed:`, error);
      if (!res.headersSent) sendJson(res, status, { error: errorMessage(error) });
      else res.end();
    }
  }
}

export function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(json);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Body must be a JSON object");
}

function serveStatic(publicDir: string, pathname: string, method: string, res: http.ServerResponse): void {
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "Bad path" });
    return;
  }
  if (relative === "/" || !path.extname(relative)) relative = "/index.html";
  const file = path.resolve(publicDir, `.${relative}`);
  const rel = path.relative(publicDir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  serveFile(file, method, res, "no-cache");
}

function serveFile(file: string, method: string, res: http.ServerResponse, cacheControl: string): void {
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": cacheControl,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

export interface SseChannel {
  send(payload: unknown): void;
  onClose(listener: () => void): void;
}

export function openSse(req: http.IncomingMessage, res: http.ServerResponse): SseChannel {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const listeners: Array<() => void> = [];
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  let closed = false;
  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    for (const listener of listeners) listener();
  });
  return {
    send(payload) {
      if (!closed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    onClose(listener) {
      listeners.push(listener);
    },
  };
}
