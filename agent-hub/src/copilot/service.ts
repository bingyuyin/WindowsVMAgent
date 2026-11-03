import fs from "node:fs";
import { CopilotClient, type CopilotSession, type ModelInfo } from "@github/copilot-sdk";
import { errorMessage, nowIso, randomId } from "../util.ts";

export type RuntimeState = "stopped" | "starting" | "ready" | "error";
export type LoginProvider = "githubDotCom" | "proxima";
export type LoginFlowStatus = "pending" | "input-required" | "completed" | "error" | "cancelled";

export interface LoginFlowView {
  id: string;
  provider: LoginProvider;
  status: LoginFlowStatus;
  url?: string;
  prompt?: string;
  message?: string;
  startedAt: string;
}

export interface AuthState {
  runtime: RuntimeState;
  runtimeVersion?: string;
  runtimeError?: string;
  authenticated: boolean;
  login?: string;
  host?: string;
  authType?: string;
  statusMessage?: string;
  flow?: LoginFlowView;
}

export interface ModelSummary {
  id: string;
  name: string;
  multiplier: number | null;
  /** Token prices per `priceUnitTokens` tokens, when the account uses token-based billing. */
  inputPrice: number | null;
  outputPrice: number | null;
  priceUnitTokens: number | null;
  policy: string | null;
  vision: boolean;
  reasoning: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
}

type AuthLoginStep = Awaited<ReturnType<CopilotSession["rpc"]["accounts"]["login"]["advance"]>>;
type AuthLoginResult = Extract<AuthLoginStep, { kind: "completed" }>["result"];

interface ActiveFlow {
  view: LoginFlowView;
  session: CopilotSession;
  runtimeFlowId: string;
  resolveInput: ((input: string) => void) | null;
  cancelled: boolean;
}

export interface CopilotServiceOptions {
  copilotHome: string;
  workingDirectory: string;
  logLevel: "none" | "error" | "warning" | "info" | "debug" | "all";
}

const rejectAllPermissions = () => ({ kind: "reject" as const, feedback: "Not allowed in this session" });

/**
 * Owns the single Copilot runtime (CopilotClient) used by the hub, the GitHub sign-in
 * flows, and the model catalog. All agent sessions are created from this client.
 */
export class CopilotService {
  private readonly options: CopilotServiceOptions;
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  private state: AuthState = { runtime: "stopped", authenticated: false };
  private flow: ActiveFlow | null = null;
  private models: ModelSummary[] | null = null;
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(options: CopilotServiceOptions) {
    this.options = options;
  }

  get copilotHome(): string {
    return this.options.copilotHome;
  }

  onChange(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): AuthState {
    const flow = this.flow ? { ...this.flow.view } : undefined;
    return { ...this.state, flow };
  }

  isReady(): boolean {
    return this.state.runtime === "ready" && this.state.authenticated;
  }

  private setState(patch: Partial<AuthState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[copilot] state listener failed:", error);
      }
    }
  }

  async start(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.setState({ runtime: "starting", runtimeError: undefined });
    this.starting = (async () => {
      fs.mkdirSync(this.options.copilotHome, { recursive: true });
      const client = new CopilotClient({
        baseDirectory: this.options.copilotHome,
        workingDirectory: this.options.workingDirectory,
        logLevel: this.options.logLevel,
        clientInfo: { applicationName: "copilot-agent-hub", applicationVersion: "0.1.0" },
      });
      await client.start();
      const status = await client.getStatus();
      this.client = client;
      this.setState({ runtime: "ready", runtimeVersion: status.version });
      await this.refreshAuth();
      return client;
    })();
    try {
      return await this.starting;
    } catch (error) {
      this.setState({ runtime: "error", runtimeError: errorMessage(error) });
      throw error;
    } finally {
      this.starting = null;
    }
  }

  async stop(): Promise<void> {
    await this.cancelLogin();
    const client = this.client;
    this.client = null;
    this.models = null;
    if (client) {
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8000));
      const outcome = await Promise.race([client.stop().then(() => "stopped" as const), timeout]).catch(() => "timeout" as const);
      if (outcome === "timeout") await client.forceStop().catch(() => undefined);
    }
    this.setState({ runtime: "stopped", authenticated: false, login: undefined, host: undefined, authType: undefined });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async refreshAuth(): Promise<AuthState> {
    const client = this.client;
    if (!client) return this.getState();
    try {
      const status = await client.getAuthStatus();
      this.setState({
        authenticated: status.isAuthenticated,
        login: status.login,
        host: status.host,
        authType: status.authType,
        statusMessage: status.statusMessage,
      });
    } catch (error) {
      this.setState({ authenticated: false, statusMessage: errorMessage(error) });
    }
    return this.getState();
  }

  /** Returns a started client with an authenticated user, or throws. */
  async requireClient(): Promise<CopilotClient> {
    const client = await this.start();
    if (!this.state.authenticated) await this.refreshAuth();
    if (!this.state.authenticated) throw new Error("Not signed in to GitHub Copilot. Sign in from the hub UI first.");
    return client;
  }

  async listModels(force = false): Promise<ModelSummary[]> {
    if (this.models && !force) return this.models;
    const client = await this.requireClient();
    const models = await client.listModels();
    this.models = models.map(toModelSummary).sort((a, b) => {
      const enabledA = a.policy !== "disabled" ? 0 : 1;
      const enabledB = b.policy !== "disabled" ? 0 : 1;
      return enabledA - enabledB || a.name.localeCompare(b.name);
    });
    return this.models;
  }

  /** Starts an interactive sign-in. The returned flow carries the GitHub authorize URL to open. */
  async beginLogin(provider: LoginProvider): Promise<LoginFlowView> {
    const client = await this.start();
    await this.cancelLogin();
    const session = await client.createSession({
      onPermissionRequest: rejectAllPermissions,
      workingDirectory: this.options.workingDirectory,
    });
    try {
      const begun = await session.rpc.accounts.login.begin({ kind: provider });
      const flow: ActiveFlow = {
        view: { id: randomId(12), provider, status: "pending", startedAt: nowIso() },
        session,
        runtimeFlowId: begun.flowId,
        resolveInput: null,
        cancelled: false,
      };
      this.flow = flow;
      this.applyStep(flow, begun.step);
      void this.driveFlow(flow, begun.step);
      return { ...flow.view };
    } catch (error) {
      await this.disposeSession(session);
      throw error;
    }
  }

  submitLoginInput(flowId: string, input: string): void {
    const flow = this.flow;
    if (!flow || flow.view.id !== flowId || !flow.resolveInput) throw new Error("No sign-in step is waiting for input");
    flow.resolveInput(input);
  }

  async cancelLogin(flowId?: string): Promise<void> {
    const flow = this.flow;
    if (!flow || (flowId && flow.view.id !== flowId)) return;
    flow.cancelled = true;
    this.flow = null;
    flow.resolveInput?.("");
    await flow.session.rpc.accounts.login.cancel({ flowId: flow.runtimeFlowId }).catch(() => undefined);
    await this.disposeSession(flow.session);
    this.emit();
  }

  async loginWithToken(token: string, host = "https://github.com"): Promise<AuthState> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error("Token is required");
    if (trimmed.startsWith("ghp_")) {
      throw new Error(
        "Classic personal access tokens (ghp_) are not supported by Copilot. Use a fine-grained token with the 'Copilot Requests' permission, or an OAuth token (gho_).",
      );
    }
    const client = await this.start();
    await this.cancelLogin();
    await client.rpc.account.login({ host, token: trimmed });
    await this.reloadCredentials();
    const state = this.getState();
    if (!state.authenticated) throw new Error(state.statusMessage || "The token was not accepted");
    return state;
  }

  /**
   * The runtime persists new credentials but keeps the auth state it resolved at startup,
   * so a successful sign-in is followed by a runtime restart to pick the credential up.
   */
  private async reloadCredentials(): Promise<void> {
    await this.restart();
  }

  async logout(): Promise<void> {
    const client = await this.start();
    const session = await client.createSession({
      onPermissionRequest: rejectAllPermissions,
      workingDirectory: this.options.workingDirectory,
    });
    try {
      await session.rpc.accounts.set({ command: { kind: "logout" } });
    } finally {
      await this.disposeSession(session);
    }
    // Restarting drops cached models and any in-memory credentials.
    await this.restart();
  }

  /** Removes persisted agent sessions (conversation history) from the hub's Copilot home. */
  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    const client = this.client;
    if (!client) return;
    for (const sessionId of sessionIds) await client.deleteSession(sessionId).catch(() => undefined);
  }

  private applyStep(flow: ActiveFlow, step: AuthLoginStep): void {
    if (flow.cancelled) return;
    switch (step.kind) {
      case "open-url":
        flow.view = { ...flow.view, status: "pending", url: step.url, prompt: undefined };
        break;
      case "input-required":
        flow.view = { ...flow.view, status: "input-required", prompt: step.prompt };
        break;
      case "awaiting":
      case "needs-interaction":
        flow.view = { ...flow.view, status: "pending", prompt: undefined };
        break;
      case "error":
        flow.view = { ...flow.view, status: "error", message: step.message };
        break;
      case "completed":
        break;
    }
    this.emit();
  }

  private async driveFlow(flow: ActiveFlow, firstStep: AuthLoginStep): Promise<void> {
    let step = firstStep;
    try {
      while (!flow.cancelled) {
        if (step.kind === "completed") {
          await this.completeFlow(flow, step.result);
          return;
        }
        if (step.kind === "error") return;
        if (step.kind === "input-required") {
          const input = await new Promise<string>((resolve) => {
            flow.resolveInput = resolve;
          });
          flow.resolveInput = null;
          if (flow.cancelled) return;
          flow.view = { ...flow.view, status: "pending", prompt: undefined };
          this.emit();
          step = await flow.session.rpc.accounts.login.advance({ flowId: flow.runtimeFlowId, input });
        } else {
          const started = Date.now();
          step = await flow.session.rpc.accounts.login.advance({ flowId: flow.runtimeFlowId });
          // advance long-polls; avoid a hot loop if a runtime answers "awaiting" immediately.
          if (step.kind === "awaiting" && Date.now() - started < 500) await new Promise((r) => setTimeout(r, 1000));
        }
        this.applyStep(flow, step);
      }
    } catch (error) {
      if (!flow.cancelled) {
        flow.view = { ...flow.view, status: "error", message: friendlyLoginError(error) };
        this.emit();
      }
    } finally {
      await this.disposeSession(flow.session);
    }
  }

  private async completeFlow(flow: ActiveFlow, result: AuthLoginResult): Promise<void> {
    switch (result.status) {
      case "completed":
        if (this.flow === flow) this.flow = null;
        flow.view = { ...flow.view, status: "completed", message: result.login ? `Signed in as ${result.login}` : undefined };
        await this.disposeSession(flow.session);
        await this.reloadCredentials();
        return;
      case "declined":
        flow.view = { ...flow.view, status: "cancelled", message: "Sign-in was declined." };
        break;
      case "needs-plaintext-consent":
        flow.view = {
          ...flow.view,
          status: "error",
          message: "No secure credential store is available on this machine. Sign in with a token instead.",
        };
        break;
      case "needs-account-selection":
        flow.view = { ...flow.view, status: "error", message: "Account selection is not supported by the hub yet." };
        break;
    }
    this.emit();
  }

  private async disposeSession(session: CopilotSession): Promise<void> {
    const sessionId = session.sessionId;
    await session.disconnect().catch(() => undefined);
    await this.client?.deleteSession(sessionId).catch(() => undefined);
  }
}

function friendlyLoginError(error: unknown): string {
  const message = errorMessage(error)
    .replace(/^Request [\w.]+ failed with message:\s*/i, "")
    .replace(/^GenericFailure,\s*/i, "");
  if (/timed out/i.test(message)) {
    return "Sign-in timed out before access was approved. Click “Sign in with GitHub” to start again, then approve access in the GitHub tab right away.";
  }
  return message;
}

function toModelSummary(model: ModelInfo): ModelSummary {
  const prices = model.billing?.tokenPrices;
  return {
    id: model.id,
    name: model.name || model.id,
    multiplier: model.billing?.multiplier ?? null,
    inputPrice: prices?.inputPrice ?? null,
    outputPrice: prices?.outputPrice ?? null,
    priceUnitTokens: prices?.batchSize || null,
    policy: model.policy?.state ?? null,
    vision: Boolean(model.capabilities?.supports?.vision),
    reasoning: Boolean(model.capabilities?.supports?.reasoningEffort),
    contextWindow: model.capabilities?.limits?.max_context_window_tokens ?? null,
    maxOutput: model.capabilities?.limits?.max_output_tokens ?? null,
  };
}
