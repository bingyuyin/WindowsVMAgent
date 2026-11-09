import fs from "node:fs";
import { CopilotAgentDriver } from "./agents/copilotDriver.ts";
import { describeBuild, readBuildInfo } from "./build.ts";
import { Bus } from "./bus.ts";
import { loadConfig } from "./config.ts";
import { loadHubSkills } from "./context.ts";
import { CopilotService } from "./copilot/service.ts";
import { loadDocTemplates } from "./docs.ts";
import { createApiRouter } from "./http/api.ts";
import { createHttpServer } from "./http/server.ts";
import { GhPullRequestCreator } from "./remote.ts";
import { RepoService } from "./repos.ts";
import { GhReviewHost } from "./review/github.ts";
import { Store } from "./store.ts";
import { TodoService } from "./todos.ts";
import { errorMessage } from "./util.ts";
import { TaskRunner } from "./workflow/runner.ts";

const config = loadConfig();
const build = readBuildInfo(config.projectRoot, config.publicDir);

const store = new Store(config.dataDir);
store.load();
const bus = new Bus();
const copilot = new CopilotService({
  copilotHome: config.copilotHome,
  workingDirectory: config.dataDir,
  logLevel: config.runtimeLogLevel,
});
const docTemplates = loadDocTemplates(config.templatesDir);
if (!docTemplates) console.warn(`[hub] No document templates found in ${config.templatesDir}; HTML documents start from scratch.`);
for (const [route, file] of Object.entries(config.vendorFiles)) {
  if (!fs.existsSync(file)) console.warn(`[hub] ${file} is missing (run npm install); ${route} will not be served.`);
}
const runner = new TaskRunner({
  store,
  bus,
  runtime: copilot,
  driver: new CopilotAgentDriver(copilot),
  worktreesDir: config.worktreesDir,
  hubSkills: loadHubSkills(config.skillsDir),
  docTemplates,
  pullRequests: new GhPullRequestCreator(),
  reviewHost: new GhReviewHost(),
  hubBuild: describeBuild(build),
});
const repos = new RepoService(store, bus, config.reposDir);
const todos = new TodoService(store, bus, runner);
runner.init();

copilot.onChange((auth) => {
  bus.publishGlobal({ type: "auth", auth });
  runner.pump();
});

const server = createHttpServer({
  host: config.host,
  port: config.port,
  publicDir: config.publicDir,
  router: createApiRouter({ store, bus, copilot, runner, repos, todos, build }),
  vendor: config.vendorFiles,
  uiBuild: build.ui,
});

server.on("error", (error) => {
  console.error(`[hub] HTTP server error: ${errorMessage(error)}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  console.log(`Copilot Agent Hub ${describeBuild(build)}`);
  console.log(`  UI:          http://localhost:${config.port}`);
  console.log(`  Data:        ${config.dataDir}`);
  console.log(`  Copilot home: ${config.copilotHome}`);
  if (!loopback) console.warn(`  WARNING: listening on ${config.host}; the hub has no authentication of its own.`);
  copilot.start().catch((error: unknown) => console.error(`[hub] Copilot runtime failed to start: ${errorMessage(error)}`));
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`\n[hub] ${signal} received, shutting down…`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  server.close();
  await runner.shutdown().catch(() => undefined);
  store.flushAllSync();
  await copilot.stop().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
