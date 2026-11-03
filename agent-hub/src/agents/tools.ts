import { defineTool, type Tool } from "@github/copilot-sdk";
import type { PlanSubmissionInput, ReviewSubmissionInput, SubmitChannel, TestRunSubmissionInput, WorkSubmissionInput } from "./driver.ts";

export const SUBMIT_WORK_TOOL = "submit_work";
export const SUBMIT_REVIEW_TOOL = "submit_review";
export const SUBMIT_TEST_RESULTS_TOOL = "submit_test_results";
export const SUBMIT_PLAN_TOOL = "submit_plan";

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

export const submitTestResultsSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["passed", "failed", "blocked"],
      description:
        "passed: everything requested ran and passed, and no integrity problem was found. failed: one or more tests failed (or a fix is not legitimate). blocked: the automation could not run (missing tool, dependency, credential or environment).",
    },
    summary: { type: "string", description: "What you ran and what you found, in a few sentences." },
    commands: {
      type: "array",
      description: "The exact commands you ran (setup, build and test), in order.",
      items: { type: "string" },
    },
    total: { type: "integer", description: "Number of tests executed (from the runner's summary)." },
    passed: { type: "integer" },
    failed: { type: "integer" },
    skipped: { type: "integer" },
    failures: {
      type: "array",
      description: "One entry per failing test or blocking problem. Required (non-empty) unless status is passed.",
      items: {
        type: "object",
        properties: {
          test: { type: "string", description: "Full test name, or the step that could not run." },
          file: { type: "string", description: "Repository-relative path of the test (or failing code), when known." },
          line: { type: "integer", description: "1-based line number, when known." },
          error: { type: "string", description: "The key error: assertion with expected vs actual, exception and the relevant stack lines." },
          category: {
            type: "string",
            enum: ["product-bug", "test-bug", "environment", "flaky", "integrity", "unknown"],
            description:
              "product-bug: the code under test is wrong. test-bug: the test itself is wrong. environment: setup/tooling/infrastructure. flaky: passes on re-run. integrity: a fix made the test pass without fixing the cause (deleted/skipped test, weakened assertion).",
          },
          suggestion: { type: "string", description: "Where the root cause most likely is and how to fix it." },
        },
        required: ["test", "error", "category"],
      },
    },
    log_excerpt: { type: "string", description: "Short excerpt of the runner output: the summary lines and key failure output." },
  },
  required: ["status", "summary", "commands", "failures"],
} as const;

const STAGE_ENUM = ["design", "coding", "testing", "document"] as const;

export const submitPlanSchema = {
  type: "object",
  properties: {
    stages: {
      type: "array",
      description:
        "Stages to run, i.e. which sub-agent teams to create: design (designer + design reviewer), coding (coder + code reviewer + comment resolver), testing (test executor + test fixer), document (technical writer + doc reviewer). They run in the order design, coding, testing, document.",
      items: { type: "string", enum: STAGE_ENUM },
    },
    rationale: { type: "string", description: "Why these stages (and not others) fit the request, in 1-3 sentences." },
    instructions: {
      type: "object",
      description: "Your assignment for each chosen stage's agents: scope, acceptance criteria, files/areas, and for testing the exact commands or suites to run.",
      properties: {
        design: { type: "string" },
        coding: { type: "string" },
        testing: { type: "string" },
        document: { type: "string" },
      },
    },
    briefing: {
      type: "string",
      description:
        "What every sub-agent should know about the repository before it starts, from your inspection: the architecture and the modules/files relevant to this request, conventions to follow, how to build and test (commands you verified exist) and pitfalls. Specific to this request, not generic advice.",
    },
  },
  required: ["stages", "rationale", "instructions", "briefing"],
} as const;

/** Builds the terminal tool through which an agent hands its structured result to the workflow. */
export function buildSubmitTool(channel: SubmitChannel): Tool<any> {
  const terminal = { isTerminal: true, skipPermission: true, defer: "never" } as const;
  switch (channel.kind) {
    case "work":
      return defineTool<WorkSubmissionInput>(SUBMIT_WORK_TOOL, {
        description:
          "Submit your work for this round to the reviewer. Call exactly once, as your final action, after the round's work is complete.",
        parameters: submitWorkSchema,
        handler: async (args) => {
          await channel.onSubmit(args);
          return "Submission recorded. Your turn is complete.";
        },
        ...terminal,
      });
    case "review":
      return defineTool<ReviewSubmissionInput>(SUBMIT_REVIEW_TOOL, {
        description: "Submit your review verdict and comments. Call exactly once, as your final action, after reviewing.",
        parameters: submitReviewSchema,
        handler: async (args) => {
          await channel.onSubmit(args);
          return "Review recorded. Your turn is complete.";
        },
        ...terminal,
      });
    case "test":
      return defineTool<TestRunSubmissionInput>(SUBMIT_TEST_RESULTS_TOOL, {
        description:
          "Submit the verified results of this test run: status, the commands you ran, counts and one entry per failure. Call exactly once, as your final action.",
        parameters: submitTestResultsSchema,
        handler: async (args) => {
          await channel.onSubmit(args);
          return "Test results recorded. Your turn is complete.";
        },
        ...terminal,
      });
    case "plan":
      return defineTool<PlanSubmissionInput>(SUBMIT_PLAN_TOOL, {
        description: "Submit your plan: which stages (sub-agent teams) to run and the assignment for each. Call exactly once, as your final action.",
        parameters: submitPlanSchema,
        handler: async (args) => {
          await channel.onSubmit(args);
          return "Plan recorded. The hub creates the sub-agents now. Your turn is complete.";
        },
        ...terminal,
      });
  }
}
