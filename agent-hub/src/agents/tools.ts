import { defineTool, type Tool } from "@github/copilot-sdk";
import type { ReviewSubmissionInput, SubmitChannel, WorkSubmissionInput } from "./driver.ts";

export const SUBMIT_WORK_TOOL = "submit_work";
export const SUBMIT_REVIEW_TOOL = "submit_review";

export const submitWorkSchema = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "Concise markdown summary of what you did this round: key changes, decisions, files touched.",
    },
    validation: {
      type: "string",
      description: "Build/test/lint commands you ran and their results. Write 'not applicable' if nothing could be run.",
    },
    comment_responses: {
      type: "array",
      description: "Exactly one entry for every open review comment ID listed in the prompt.",
      items: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "Review comment ID, e.g. C3 or D2." },
          status: { type: "string", enum: ["addressed", "declined"] },
          note: { type: "string", description: "What you changed, or the concrete technical reason for declining." },
        },
        required: ["comment_id", "status", "note"],
      },
    },
  },
  required: ["summary"],
} as const;

export const submitReviewSchema = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["approve", "request_changes"],
      description: "approve when no blocker/major issues remain; otherwise request_changes.",
    },
    summary: { type: "string", description: "Overall assessment in a few sentences." },
    comments: {
      type: "array",
      description: "Actionable review comments. Required (non-empty) when requesting changes.",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          file: { type: "string", description: "Repository-relative file path, when applicable." },
          line: { type: "integer", description: "1-based line number in the current version of the file, when applicable." },
          body: { type: "string", description: "The problem and the expected fix." },
        },
        required: ["severity", "body"],
      },
    },
  },
  required: ["verdict", "summary", "comments"],
} as const;

/** Builds the terminal tool through which an agent hands its structured result to the workflow. */
export function buildSubmitTool(channel: SubmitChannel): Tool<any> {
  if (channel.kind === "work") {
    return defineTool<WorkSubmissionInput>(SUBMIT_WORK_TOOL, {
      description:
        "Submit your work for this round to the reviewer. Call exactly once, as your final action, after the round's work is complete.",
      parameters: submitWorkSchema,
      handler: async (args) => {
        await channel.onSubmit(args);
        return "Submission recorded. Your turn is complete.";
      },
      isTerminal: true,
      skipPermission: true,
      defer: "never",
    });
  }
  return defineTool<ReviewSubmissionInput>(SUBMIT_REVIEW_TOOL, {
    description: "Submit your review verdict and comments. Call exactly once, as your final action, after reviewing.",
    parameters: submitReviewSchema,
    handler: async (args) => {
      await channel.onSubmit(args);
      return "Review recorded. Your turn is complete.";
    },
    isTerminal: true,
    skipPermission: true,
    defer: "never",
  });
}
