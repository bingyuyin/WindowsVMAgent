import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import type { CopilotService } from "../copilot/service.ts";
import { ROLE_LABELS } from "../types.ts";
import { errorMessage, firstLine, randomId, truncate } from "../util.ts";
import { TurnTimeoutError, type AgentDriver, type AgentHandle, type AgentObserver, type AgentSpec } from "./driver.ts";
import { createPermissionPolicy } from "./policy.ts";
import { buildSubmitTools } from "./tools.ts";

/** Runs agents as GitHub Copilot SDK sessions on the hub's shared CopilotClient. */
export class CopilotAgentDriver implements AgentDriver {
  private readonly copilot: CopilotService;

  constructor(copilot: CopilotService) {
    this.copilot = copilot;
  }

  async start(spec: AgentSpec): Promise<AgentHandle> {
    const client = await this.copilot.requireClient();
    const sessionId = `hub-${spec.taskId.toLowerCase()}-${spec.role}-${randomId(6)}`;
    const toolNames = new Map<string, string>();
    const policy = createPermissionPolicy({
      readOnly: spec.readOnly,
      executeOnly: spec.executeOnly,
      workingDirectory: spec.workingDirectory,
      scratchRoots: [path.join(this.copilot.copilotHome, "session-state")],
      readRoots: spec.skillDirectories,
    });

    const session = await client.createSession({
      sessionId,
      name: sessionName(`${spec.taskId} ${ROLE_LABELS[spec.role]} - ${spec.title}`),
      model: spec.model,
      workingDirectory: spec.workingDirectory,
      trustWorkingDirectory: "session",
      systemMessage: { mode: "append", content: spec.systemPrompt },
      tools: buildSubmitTools(spec.submit),
      skillDirectories: spec.skillDirectories,
      disabledSkills: spec.disabledSkills,
      onPermissionRequest: (request) => policy(request),
      onUserInputRequest: async (request) => {
        const choices = request.choices ?? [];
        const answer = await spec.askUser({
          question: request.question,
          choices,
          allowFreeform: request.allowFreeform ?? true,
        });
        return { answer, wasFreeform: !choices.includes(answer) };
      },
      streaming: true,
      includeSubAgentStreamingEvents: false,
      coauthorEnabled: false,
      onEvent: (event) => forwardEvent(event, spec.observer, toolNames, spec.workingDirectory),
    });

    return {
      sessionId,
      async send(prompt: string) {
        try {
          const message = await session.sendAndWait({ prompt }, spec.turnTimeoutMs);
          return { lastMessage: message?.data.content };
        } catch (error) {
          // sendAndWait stops waiting at the timeout but leaves the turn running in the session.
          if (/^Timeout after \d+ms waiting/.test(errorMessage(error))) throw new TurnTimeoutError(spec.turnTimeoutMs);
          throw error;
        }
      },
      async abort() {
        await session.abort().catch(() => undefined);
      },
      async dispose() {
        await session.disconnect().catch(() => undefined);
      },
    };
  }
}

function forwardEvent(event: SessionEvent, observer: AgentObserver, toolNames: Map<string, string>, cwd: string): void {
  observer.onHeartbeat();
  const subAgent = Boolean((event as { agentId?: string }).agentId);
  switch (event.type) {
    case "assistant.message_delta":
      if (!subAgent) observer.onDelta(event.data.messageId, event.data.deltaContent);
      break;
    case "assistant.message":
      if (!subAgent && event.data.content?.trim()) observer.onMessage(event.data.content);
      break;
    case "assistant.intent":
      if (!subAgent) observer.onIntent(event.data.intent);
      break;
    case "tool.execution_start":
      toolNames.set(event.data.toolCallId, event.data.toolName);
      observer.onToolStart({
        id: event.data.toolCallId,
        name: event.data.toolName,
        label: describeTool(event.data.toolName, event.data.arguments, cwd),
        subAgent,
      });
      break;
    case "tool.execution_complete":
      observer.onToolDone({
        id: event.data.toolCallId,
        name: toolNames.get(event.data.toolCallId) ?? "tool",
        success: event.data.success,
        error: event.data.error?.message,
      });
      toolNames.delete(event.data.toolCallId);
      break;
    case "assistant.usage":
      observer.onUsage({
        inputTokens: event.data.inputTokens ?? 0,
        outputTokens: event.data.outputTokens ?? 0,
        premiumRequests: event.data.cost ?? 0,
      });
      break;
    case "session.error":
      observer.onError(event.data.message);
      break;
    case "subagent.started":
      observer.onInfo(`Sub-agent started: ${event.data.agentDisplayName}`);
      break;
    case "subagent.failed":
      observer.onInfo(`Sub-agent failed: ${event.data.agentDisplayName}: ${event.data.error}`);
      break;
    case "session.compaction_start":
      observer.onInfo("Compacting conversation context…");
      break;
    default:
      break;
  }
}

const ARGUMENT_KEYS = ["command", "path", "pattern", "url", "query", "description", "prompt"];

export function describeTool(name: string, args: unknown, cwd: string): string {
  if (name === "submit_work") return "Submitting work for review";
  if (name === "submit_review") {
    const verdict = isRecord(args) && typeof args.verdict === "string" ? args.verdict.replace("_", " ") : "";
    return `Submitting review${verdict ? ` (${verdict})` : ""}`;
  }
  if (name === "submit_test_results") {
    const status = isRecord(args) && typeof args.status === "string" ? args.status : "";
    return `Submitting test results${status ? ` (${status})` : ""}`;
  }
  if (name === "submit_plan") {
    const stages = isRecord(args) && Array.isArray(args.stages) ? args.stages.filter((stage) => typeof stage === "string").join(" → ") : "";
    return `Submitting plan${stages ? ` (${stages})` : ""}`;
  }
  if (name === "submit_findings") {
    const count = isRecord(args) && Array.isArray(args.comments) ? args.comments.length : null;
    return `Submitting review findings${count !== null ? ` (${count} comment${count === 1 ? "" : "s"})` : ""}`;
  }
  if (name === "submit_positions") return "Submitting positions on the other reviewer's comments";
  if (name === "submit_final_review") {
    const count = isRecord(args) && Array.isArray(args.comments) ? args.comments.length : null;
    return `Submitting the final review${count !== null ? ` (${count} comment${count === 1 ? "" : "s"})` : ""}`;
  }
  if (name === "submit_signoff") {
    const agree = isRecord(args) && typeof args.agree === "boolean" ? (args.agree ? " (agrees)" : " (objects)") : "";
    return `Signing off on the final review${agree}`;
  }
  if (name === "skill") {
    const skill = isRecord(args) ? Object.values(args).find((value): value is string => typeof value === "string" && value.trim().length > 0) : undefined;
    return skill ? `Loading skill: ${truncate(skill, 80)}` : "Loading a skill";
  }
  if (!isRecord(args)) return name;
  for (const key of ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    let text = firstLine(value);
    if (key === "path") text = relativeTo(cwd, text);
    return `${name}: ${truncate(text, 160)}`;
  }
  return name;
}

function relativeTo(cwd: string, target: string): string {
  if (!path.isAbsolute(target)) return target;
  const relative = path.relative(cwd, target);
  return relative && !relative.startsWith("..") ? relative.replaceAll("\\", "/") : target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Session names must be <=100 chars with no quotes, control characters, or surrounding spaces. */
function sessionName(raw: string): string {
  return truncate(raw.replace(/["\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim(), 100).trim();
}
