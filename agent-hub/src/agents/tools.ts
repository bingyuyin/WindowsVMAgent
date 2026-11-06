import { defineTool, type Tool } from "@github/copilot-sdk";
import type { CodeReviewTool, PlanSubmissionInput, ReviewSubmissionInput, SubmitChannel, TestRunSubmissionInput, WorkSubmissionInput } from "./driver.ts";

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

const unrelatedFailuresSchema = {
  type: "array",
  description:
    "Failing tests the requested change has nothing to do with: they fail without it too, or they are flaky, in code and tests the change does not touch. They are reported to the user and left for their owners, not fixed in this task. When the request itself is to make these tests pass, they are not unrelated.",
  items: {
    type: "object",
    properties: {
      test: { type: "string", description: "Full test name (and file)." },
      reason: { type: "string", description: "Why it is unrelated, e.g. fails the same way without the change, or flaky: the result changes on re-run." },
    },
    required: ["test", "reason"],
  },
} as const;

export const unitTestsSchema = {
  type: "object",
  description:
    "The unit tests you ran after your last change. The manager re-runs these commands in your working directory before the review; the round only goes to review when they pass.",
  properties: {
    status: {
      type: "string",
      enum: ["passed", "failed", "blocked"],
      description:
        "passed: the tests that cover your change pass and every command exits 0 (failing tests unrelated to your change go in unrelated_failures). failed: tests your change affects still fail - fix them before you submit. blocked: the tests that cover your change cannot run (a missing tool or service, unrelated failures that no command can leave out, no unit tests can cover this change); explain in reason.",
    },
    commands: {
      type: "array",
      description:
        "The exact unit test commands you ran, one per entry and as you ran them in your shell: no install or setup steps, no chaining. They cover your change (the affected test files or projects, or the whole suite) and leave out tests that fail for reasons unrelated to it. Each must exit non-zero when a test fails (for example Invoke-Pester -CI).",
      items: { type: "string" },
    },
    total: { type: "integer", description: "Number of tests that ran." },
    passed: { type: "integer" },
    failed: { type: "integer" },
    skipped: { type: "integer" },
    reason: { type: "string", description: "Required when status is blocked: what prevents the tests from running or passing." },
    unrelated_failures: unrelatedFailuresSchema,
  },
  required: ["status", "commands"],
} as const;

/** submit_work for coding agents: the unit tests are part of every submission. */
export const submitCodeSchema = {
  ...submitWorkSchema,
  properties: { ...submitWorkSchema.properties, unit_tests: unitTestsSchema },
  required: ["summary", "unit_tests"],
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
        "passed: everything requested ran, and no failure related to the request and no integrity problem remains (failures unrelated to the request go in unrelated_failures). failed: one or more tests related to the request failed (or a fix is not legitimate). blocked: the automation could not run (missing tool, dependency, credential or environment).",
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
      description: "One entry per failure the test fixer must fix, or per blocking problem. Required (non-empty) unless status is passed.",
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
    unrelated_failures: unrelatedFailuresSchema,
    log_excerpt: { type: "string", description: "Short excerpt of the runner output: the summary lines and key failure output." },
  },
  required: ["status", "summary", "commands", "failures"],
} as const;

const STAGE_ENUM = ["design", "coding", "testing", "document", "review"] as const;

export const submitPlanSchema = {
  type: "object",
  properties: {
    stages: {
      type: "array",
      description:
        "Which sub-agent teams to create: design (designer + design reviewer), coding (coder + code reviewer + comment resolver), testing (test executor + test fixer), document (technical writer + doc reviewer); they run in the order design, coding, testing, document. Or review (lead reviewer + peer reviewer) for a request to review an existing change - a pull request or a branch: it always stands alone, with `review_target`.",
      items: { type: "string", enum: STAGE_ENUM },
    },
    rationale: { type: "string", description: "Why these stages (and not others) fit the request, in 1-3 sentences." },
    instructions: {
      type: "object",
      description:
        "Your assignment for each chosen stage's agents: scope, acceptance criteria, files/areas, and for testing the exact commands or suites to run. For review: what the reviewers should focus on.",
      properties: {
        design: { type: "string" },
        coding: { type: "string" },
        testing: { type: "string" },
        document: { type: "string" },
        review: { type: "string" },
      },
    },
    review_target: {
      type: "string",
      description:
        "With the review stage only: the pull request to review (#12, 12 or its URL) or the branch, as the request names it. The hub fetches it from the repository's remote.",
    },
    review_base: {
      type: "string",
      description:
        "With the review stage only, optional: the branch the change is compared with. Omit it for a pull request (the hub reads its target branch) and for a branch that merges into the default branch.",
    },
    briefing: {
      type: "string",
      description:
        "What every sub-agent should know about the repository before it starts, from your inspection: the architecture and the modules/files relevant to this request, conventions to follow, how to build and test (commands you verified exist) and pitfalls. Specific to this request, not generic advice.",
    },
  },
  required: ["stages", "rationale", "instructions", "briefing"],
} as const;

const SEVERITY_ENUM = ["blocker", "major", "minor", "nit"] as const;

const reviewCommentProperties = {
  severity: {
    type: "string",
    enum: SEVERITY_ENUM,
    description: "blocker: must be fixed (bug, security hole, data loss). major: should be fixed before merging. minor: worth improving. nit: polish.",
  },
  file: { type: "string", description: "Repository-relative path of the file the comment is about." },
  line: {
    type: "integer",
    description:
      "1-based line in the NEW version of the file (the reviewed commit). Prefer a line the change added or modified: comments on lines of the diff can be posted inline on the pull request.",
  },
  body: {
    type: "string",
    description:
      "Written for the change's author: what is wrong, why it matters and how to fix it (a short code suggestion helps). Self-contained: never mention the other reviewer, comment IDs or this discussion.",
  },
} as const;

const reviewCommentSchema = { type: "object", properties: reviewCommentProperties, required: ["severity", "body"] } as const;

const verdictSchema = {
  type: "string",
  enum: ["approve", "request_changes"],
  description: "approve: the change can be merged as is or with minor/nit comments. request_changes: a blocker or major issue must be fixed first.",
} as const;

export const submitFindingsSchema = {
  type: "object",
  properties: {
    change_summary: {
      type: "string",
      description:
        "What the change does, for a reader who has not seen it: its purpose, the main changes grouped by area or file, and notable risks. Concise Markdown.",
    },
    assessment: { type: "string", description: "Your overall assessment of the change in a few sentences." },
    verdict: verdictSchema,
    comments: { type: "array", description: "One entry per issue worth raising; empty when there is none.", items: reviewCommentSchema },
  },
  required: ["change_summary", "assessment", "verdict", "comments"],
} as const;

export const submitPositionsSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Where you agree and disagree with the other reviewer, in a few sentences." },
    responses: {
      type: "array",
      description: "Exactly one entry for every comment of the OTHER reviewer.",
      items: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "The other reviewer's comment ID, e.g. P2 or L3." },
          position: {
            type: "string",
            enum: ["agree", "disagree", "refine"],
            description: "agree: valid as written. disagree: not a real issue (say why, pointing to the code). refine: valid, but the text, severity or line should change.",
          },
          note: { type: "string", description: "Your reasoning, with evidence from the code." },
          suggested_body: { type: "string", description: "refine: the better comment text." },
          suggested_severity: { type: "string", enum: SEVERITY_ENUM, description: "refine: the severity it should have." },
        },
        required: ["comment_id", "position", "note"],
      },
    },
    own_updates: {
      type: "array",
      description: "Changes to your OWN comments after reading the other review: withdraw one that is wrong, or revise it.",
      items: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "Your comment's ID." },
          action: { type: "string", enum: ["withdraw", "revise"] },
          note: { type: "string", description: "Why you withdraw or revise it." },
          body: { type: "string", description: "revise: the new text." },
          severity: { type: "string", enum: SEVERITY_ENUM, description: "revise: the new severity." },
          line: { type: "integer", description: "revise: the corrected line." },
        },
        required: ["comment_id", "action", "note"],
      },
    },
    new_comments: {
      type: "array",
      description: "Real issues neither reviewer raised (often prompted by the other review). Usually empty.",
      items: reviewCommentSchema,
    },
  },
  required: ["summary", "responses"],
} as const;

export const submitFinalReviewSchema = {
  type: "object",
  properties: {
    change_summary: { type: "string", description: "The final summary of what the change does (purpose, main changes by area, risks). Concise Markdown." },
    assessment: { type: "string", description: "The overall assessment the change's author reads with the comments." },
    verdict: verdictSchema,
    comments: {
      type: "array",
      description: "The final comments, each self-contained and written for the change's author.",
      items: {
        type: "object",
        properties: {
          ...reviewCommentProperties,
          sources: {
            type: "array",
            items: { type: "string" },
            description: 'IDs of the reviewer comments merged into this one, e.g. ["L2", "P1"]; empty for an issue you add now.',
          },
        },
        required: ["severity", "body", "sources"],
      },
    },
    dropped: {
      type: "array",
      description: "Every reviewer comment that is in no final comment's sources, with the reason (wrong, duplicate, out of scope...). Withdrawn comments need not be listed.",
      items: {
        type: "object",
        properties: { comment_id: { type: "string" }, reason: { type: "string" } },
        required: ["comment_id", "reason"],
      },
    },
    objection_responses: {
      type: "array",
      description: "Only when revising after the peer reviewer's objections: how you handled each one.",
      items: {
        type: "object",
        properties: { objection: { type: "string", description: "The objection, briefly." }, response: { type: "string", description: "What you changed, or why you keep your decision." } },
        required: ["objection", "response"],
      },
    },
  },
  required: ["change_summary", "assessment", "verdict", "comments", "dropped"],
} as const;

export const submitSignoffSchema = {
  type: "object",
  properties: {
    agree: { type: "boolean", description: "true when you accept the final review as a whole; wording preferences and nits are no reason to object." },
    summary: { type: "string", description: "Why you accept it, or what is wrong with it, in a few sentences." },
    objections: {
      type: "array",
      description: "Required when agree is false: one entry per problem.",
      items: {
        type: "object",
        properties: {
          comment_id: { type: "string", description: "R# of a final comment, or the ID of a reviewer comment the final review dropped; omit for the review as a whole." },
          issue: { type: "string", description: "What is wrong and what the final review should do instead." },
        },
        required: ["issue"],
      },
    },
  },
  required: ["agree", "summary"],
} as const;

const CODE_REVIEW_TOOLS: Record<CodeReviewTool, { description: string; parameters: Record<string, unknown>; done: string }> = {
  submit_findings: {
    description: "Submit your independent review of the change: its summary, your assessment and verdict, and your comments. Call exactly once, as your final action.",
    parameters: submitFindingsSchema,
    done: "Findings recorded. Your turn is complete.",
  },
  submit_positions: {
    description: "Submit your response to the other reviewer's comments and any changes to your own. Call exactly once, as your final action.",
    parameters: submitPositionsSchema,
    done: "Positions recorded. Your turn is complete.",
  },
  submit_final_review: {
    description: "Submit the consolidated final review. Call exactly once, as your final action.",
    parameters: submitFinalReviewSchema,
    done: "Final review recorded. Your turn is complete.",
  },
  submit_signoff: {
    description: "Accept the final review, or object to it. Call exactly once, as your final action.",
    parameters: submitSignoffSchema,
    done: "Sign-off recorded. Your turn is complete.",
  },
};

/** The terminal tools of an agent: one submit tool, or one per step for the code review reviewers. */
export function buildSubmitTools(channel: SubmitChannel): Tool<any>[] {
  if (channel.kind !== "code-review") return [buildSubmitTool(channel)];
  return channel.tools.map((name) => {
    const tool = CODE_REVIEW_TOOLS[name];
    return defineTool<Record<string, unknown>>(name, {
      description: tool.description,
      parameters: tool.parameters,
      handler: async (args) => {
        await channel.onSubmit(name, args);
        return tool.done;
      },
      isTerminal: true,
      skipPermission: true,
      defer: "never",
    });
  });
}

/** Builds the terminal tool through which an agent hands its structured result to the workflow. */
export function buildSubmitTool(channel: SubmitChannel): Tool<any> {
  const terminal = { isTerminal: true, skipPermission: true, defer: "never" } as const;
  switch (channel.kind) {
    case "work":
      return defineTool<WorkSubmissionInput>(SUBMIT_WORK_TOOL, {
        description: channel.unitTests
          ? "Submit your work for this round to the reviewer, with the unit tests you ran. Call exactly once, as your final action, after the round's work is complete and the unit tests pass."
          : "Submit your work for this round to the reviewer. Call exactly once, as your final action, after the round's work is complete.",
        parameters: channel.unitTests ? submitCodeSchema : submitWorkSchema,
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
    case "code-review":
      throw new Error("Code review reviewers have one tool per step: use buildSubmitTools");
  }
}
