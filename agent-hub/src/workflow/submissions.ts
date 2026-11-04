import type { PlanSubmissionInput, ReviewSubmissionInput, TestRunSubmissionInput, UnitTestsInput, WorkSubmissionInput } from "../agents/driver.ts";
import { FAILURE_CATEGORIES, SEVERITIES, STAGE_ORDER, type FailureCategory, type Severity, type StageKind, type TestStatus, type UnrelatedFailure, type Verdict } from "../types.ts";
import { truncate } from "../util.ts";

/**
 * Validation for agent submissions. Errors thrown here are returned to the agent as a failed
 * tool call, so messages are written as instructions the model can act on.
 */

const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: "blocker",
  blocking: "blocker",
  high: "major",
  important: "major",
  medium: "minor",
  moderate: "minor",
  low: "nit",
  style: "nit",
  suggestion: "minor",
  info: "nit",
};

export function normalizeVerdict(value: unknown): Verdict {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (text === "approve" || text === "approved" || text === "lgtm") return "approve";
  if (["request_changes", "changes_requested", "request_change", "reject", "needs_changes"].includes(text)) return "request_changes";
  throw new Error(`Invalid verdict '${String(value)}'. Use "approve" or "request_changes".`);
}

export function normalizeSeverity(value: unknown): Severity {
  const text = String(value ?? "").trim().toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(text)) return text as Severity;
  return SEVERITY_ALIASES[text] ?? "minor";
}

export function normalizeReview(input: unknown): ReviewSubmissionInput {
  const raw = (input ?? {}) as Partial<Record<keyof ReviewSubmissionInput, unknown>>;
  const verdict = normalizeVerdict(raw.verdict);
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("`summary` is required: give an overall assessment.");
  if (raw.comments !== undefined && !Array.isArray(raw.comments)) throw new Error("`comments` must be an array.");
  const comments = ((raw.comments as unknown[] | undefined) ?? []).map((item, index) => {
    const comment = (item ?? {}) as Record<string, unknown>;
    const body = typeof comment.body === "string" ? comment.body.trim() : "";
    if (!body) throw new Error(`comments[${index}].body is required.`);
    const line = Number(comment.line);
    const file = typeof comment.file === "string" && comment.file.trim() ? comment.file.trim().replaceAll("\\", "/") : undefined;
    return {
      severity: normalizeSeverity(comment.severity),
      file,
      line: Number.isInteger(line) && line > 0 ? line : undefined,
      body: truncate(body, 8000),
    };
  });
  if (verdict === "request_changes" && comments.length === 0) {
    throw new Error("request_changes requires at least one actionable comment. Add comments, or approve if nothing needs to change.");
  }
  const blocking = comments.filter((comment) => comment.severity === "blocker" || comment.severity === "major");
  if (verdict === "approve" && blocking.length) {
    throw new Error(
      "You approved but included blocker/major comments. Use request_changes, or downgrade them to minor/nit if they truly do not block approval.",
    );
  }
  return { verdict, summary: truncate(summary, 8000), comments };
}

export interface WorkRules {
  /** Coding stage: `unit_tests` is required, and failing tests must be fixed before submitting. */
  unitTests?: boolean;
  /** A resubmission after test fixes: responses already given need not be repeated. */
  partialResponses?: boolean;
}

export function normalizeWork(input: unknown, expectedCommentIds: readonly string[], rules: WorkRules = {}): WorkSubmissionInput {
  const raw = (input ?? {}) as Partial<Record<keyof WorkSubmissionInput, unknown>>;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("`summary` is required: describe what you did this round.");
  if (raw.comment_responses !== undefined && !Array.isArray(raw.comment_responses)) {
    throw new Error("`comment_responses` must be an array.");
  }
  const expected = new Set(expectedCommentIds.map((id) => id.toUpperCase()));
  const responses: NonNullable<WorkSubmissionInput["comment_responses"]> = [];
  for (const [index, item] of ((raw.comment_responses as unknown[] | undefined) ?? []).entries()) {
    const response = (item ?? {}) as Record<string, unknown>;
    const id = String(response.comment_id ?? "").trim().replace(/^\[|\]$/g, "").toUpperCase();
    if (!expected.has(id)) continue;
    const status = String(response.status ?? "").trim().toLowerCase();
    if (status !== "addressed" && status !== "declined") {
      throw new Error(`comment_responses[${index}].status must be "addressed" or "declined".`);
    }
    const note = typeof response.note === "string" ? response.note.trim() : "";
    if (!note) throw new Error(`comment_responses[${index}].note is required: explain the change or why you declined.`);
    responses.push({ comment_id: id, status, note: truncate(note, 4000) });
  }
  const answered = new Set(responses.map((response) => response.comment_id));
  const missing = [...expected].filter((id) => !answered.has(id));
  if (missing.length && !rules.partialResponses) {
    throw new Error(
      `Missing comment_responses for: ${missing.join(", ")}. Respond to every open comment ID with status "addressed" or "declined" and a note.`,
    );
  }
  const validation = typeof raw.validation === "string" && raw.validation.trim() ? truncate(raw.validation.trim(), 8000) : undefined;
  const unitTests = rules.unitTests ? normalizeUnitTests(raw.unit_tests) : undefined;
  return { summary: truncate(summary, 12000), validation, comment_responses: responses, ...(unitTests ? { unit_tests: unitTests } : {}) };
}

export function normalizeUnitTests(input: unknown): UnitTestsInput {
  if (!input || typeof input !== "object") {
    throw new Error("`unit_tests` is required: run the unit tests until they all pass and report the status and the exact commands you ran.");
  }
  const raw = input as Record<string, unknown>;
  const status = normalizeTestStatus(raw.status);
  if (status === "failed") {
    throw new Error(
      "The unit tests still fail. Fix the cause when your change causes the failure (in the code, or in a test that is itself wrong) and run them until they pass. A failure unrelated to your change (it fails without your change too, or it is flaky, in code you did not touch) is not yours to fix: leave it alone, report commands that cover your change without it and list it in `unit_tests.unrelated_failures` with status passed.",
    );
  }
  if (raw.commands !== undefined && !Array.isArray(raw.commands)) throw new Error("`unit_tests.commands` must be an array of strings.");
  const commands = ((raw.commands as unknown[] | undefined) ?? [])
    .map((command) => (typeof command === "string" ? command.trim() : ""))
    .filter(Boolean);
  if (commands.length > 10) throw new Error("`unit_tests.commands` may list at most 10 commands.");
  const tooLong = commands.find((command) => command.length > 500);
  if (tooLong) throw new Error(`Unit test command is too long (max 500 characters): ${truncate(tooLong, 80)}`);
  const total = count(raw.total, "unit_tests.total");
  const passed = count(raw.passed, "unit_tests.passed");
  const failed = count(raw.failed, "unit_tests.failed");
  const skipped = count(raw.skipped, "unit_tests.skipped");
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? truncate(raw.reason.trim(), 2000) : undefined;
  const unrelated = normalizeUnrelatedFailures(raw.unrelated_failures, "unit_tests.unrelated_failures");
  if (status === "passed") {
    if (!commands.length) throw new Error("`unit_tests.commands` is required: list the exact unit test commands you ran; the manager re-runs them before the review.");
    if (failed && !unrelated.length) {
      throw new Error(
        "`unit_tests.failed` is greater than 0, so tests still fail. Fix the ones your change causes; list failures unrelated to your change in `unit_tests.unrelated_failures` and leave them out of your commands.",
      );
    }
    if (total === 0) throw new Error("No unit tests ran (total is 0). Run the tests that cover your change, or report status blocked with the reason.");
  } else if (!reason) {
    throw new Error("`unit_tests.reason` is required when status is blocked: say what prevents the tests from running or passing.");
  }
  return { status, commands, total, passed, failed, skipped, reason, ...(unrelated.length ? { unrelated_failures: unrelated } : {}) };
}

function normalizeUnrelatedFailures(value: unknown, key: string): UnrelatedFailure[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be an array.`);
  return value.slice(0, 30).map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const test = typeof entry.test === "string" ? entry.test.trim() : "";
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (!test) throw new Error(`${key}[${index}].test is required: name the failing test.`);
    if (!reason) throw new Error(`${key}[${index}].reason is required: say why the failure is unrelated to the requested change.`);
    return { test: truncate(test, 400), reason: truncate(reason, 1000) };
  });
}

/** A resubmission after the manager sent failing unit tests back: the new report wins, earlier comment responses stay unless revised. */
export function mergeWork(previous: WorkSubmissionInput, next: WorkSubmissionInput): WorkSubmissionInput {
  const revised = new Set((next.comment_responses ?? []).map((response) => response.comment_id));
  return {
    summary: `${previous.summary}\n\n**Unit test fixes:** ${next.summary}`,
    validation: next.validation ?? previous.validation,
    comment_responses: [...(previous.comment_responses ?? []).filter((response) => !revised.has(response.comment_id)), ...(next.comment_responses ?? [])],
    unit_tests: next.unit_tests,
  };
}

/** Best-effort review when a reviewer never called submit_review. */
export function fallbackReview(lastMessage: string | undefined): ReviewSubmissionInput {
  const text = (lastMessage ?? "").trim();
  const approves = /\b(approve|approved|lgtm)\b/i.test(text) && !/request(ed|ing)?[\s_-]*changes|changes[\s_-]+requested/i.test(text);
  if (approves) return { verdict: "approve", summary: truncate(text, 4000), comments: [] };
  return {
    verdict: "request_changes",
    summary: "The reviewer did not submit a structured review; its final message is included as a comment.",
    comments: [{ severity: "major", body: truncate(text || "No review content was produced.", 6000) }],
  };
}

// ---- Test runs (test executor) -----------------------------------------------------------------

const TEST_STATUS_ALIASES: Record<string, TestStatus> = {
  pass: "passed",
  passed: "passed",
  passing: "passed",
  success: "passed",
  succeeded: "passed",
  ok: "passed",
  green: "passed",
  fail: "failed",
  failed: "failed",
  failing: "failed",
  failure: "failed",
  error: "failed",
  errors: "failed",
  red: "failed",
  blocked: "blocked",
  block: "blocked",
  cannot_run: "blocked",
  not_run: "blocked",
  did_not_run: "blocked",
};

const CATEGORY_ALIASES: Record<string, FailureCategory> = {
  product: "product-bug",
  bug: "product-bug",
  code: "product-bug",
  regression: "product-bug",
  product_bug: "product-bug",
  test: "test-bug",
  test_bug: "test-bug",
  test_defect: "test-bug",
  test_issue: "test-bug",
  env: "environment",
  infra: "environment",
  infrastructure: "environment",
  setup: "environment",
  configuration: "environment",
  config: "environment",
  dependency: "environment",
  intermittent: "flaky",
  flake: "flaky",
  cheat: "integrity",
  tampering: "integrity",
  test_integrity: "integrity",
};

export function normalizeTestStatus(value: unknown): TestStatus {
  const text = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const status = TEST_STATUS_ALIASES[text];
  if (!status) throw new Error(`Invalid status '${String(value)}'. Use "passed", "failed" or "blocked".`);
  return status;
}

export function normalizeCategory(value: unknown): FailureCategory {
  const text = String(value ?? "").trim().toLowerCase();
  if ((FAILURE_CATEGORIES as readonly string[]).includes(text)) return text as FailureCategory;
  return CATEGORY_ALIASES[text.replace(/[\s-]+/g, "_")] ?? "unknown";
}

function count(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`\`${key}\` must be a non-negative integer.`);
  return number;
}

export function normalizeTestRun(input: unknown): TestRunSubmissionInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  const status = normalizeTestStatus(raw.status);
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (!summary) throw new Error("`summary` is required: say what you ran and what you found.");
  if (raw.commands !== undefined && !Array.isArray(raw.commands)) throw new Error("`commands` must be an array of strings.");
  const commands = ((raw.commands as unknown[] | undefined) ?? [])
    .map((command) => (typeof command === "string" ? command.trim() : ""))
    .filter(Boolean)
    .slice(0, 40)
    .map((command) => truncate(command, 600));
  if (status !== "blocked" && !commands.length) throw new Error("`commands` is required: list the exact commands you ran, in order.");
  if (raw.failures !== undefined && !Array.isArray(raw.failures)) throw new Error("`failures` must be an array.");
  const failures = ((raw.failures as unknown[] | undefined) ?? []).map((item, index) => {
    const failure = (item ?? {}) as Record<string, unknown>;
    const test = typeof failure.test === "string" ? failure.test.trim() : "";
    const error = typeof failure.error === "string" ? failure.error.trim() : "";
    if (!test) throw new Error(`failures[${index}].test is required: name the failing test (or the step that could not run).`);
    if (!error) throw new Error(`failures[${index}].error is required: include the key error output.`);
    const line = Number(failure.line);
    const file = typeof failure.file === "string" && failure.file.trim() ? failure.file.trim().replaceAll("\\", "/") : undefined;
    const suggestion = typeof failure.suggestion === "string" && failure.suggestion.trim() ? truncate(failure.suggestion.trim(), 3000) : undefined;
    return {
      test: truncate(test, 400),
      file,
      line: Number.isInteger(line) && line > 0 ? line : undefined,
      error: truncate(error, 6000),
      category: normalizeCategory(failure.category),
      suggestion,
    };
  });
  const total = count(raw.total, "total");
  const passed = count(raw.passed, "passed");
  const failed = count(raw.failed, "failed");
  const skipped = count(raw.skipped, "skipped");
  const unrelated = normalizeUnrelatedFailures(raw.unrelated_failures, "unrelated_failures");
  if (status === "passed") {
    if (failures.length) {
      throw new Error(
        "status is passed but failures are listed. Use status failed, move failures unrelated to the request to `unrelated_failures`, or remove entries that are not failures.",
      );
    }
    if (total === 0) {
      throw new Error(
        "No tests ran (total is 0). A run without tests cannot pass: find and run the requested tests, or report status blocked with the reason.",
      );
    }
    if (failed && !unrelated.length) {
      throw new Error("status is passed but `failed` is greater than 0. Use status failed and list each failure (failures unrelated to the request go in `unrelated_failures`).");
    }
  } else if (!failures.length) {
    throw new Error(`status ${status} requires at least one entry in \`failures\` describing what failed or what blocked the run.`);
  }
  const logExcerpt = typeof raw.log_excerpt === "string" && raw.log_excerpt.trim() ? truncate(raw.log_excerpt.trim(), 6000) : undefined;
  return {
    status,
    summary: truncate(summary, 8000),
    commands,
    total,
    passed,
    failed,
    skipped,
    failures,
    ...(unrelated.length ? { unrelated_failures: unrelated } : {}),
    log_excerpt: logExcerpt,
  };
}

/** When the executor never called submit_test_results: treat the run as blocked so nothing is reported as passing. */
export function fallbackTestRun(lastMessage: string | undefined): TestRunSubmissionInput {
  const text = (lastMessage ?? "").trim();
  return {
    status: "blocked",
    summary: "The test executor did not submit structured results; its final message is included.",
    commands: [],
    failures: [{ test: "Test run", error: truncate(text || "No output was produced.", 6000), category: "unknown" }],
  };
}

/** Severity shown for a test failure: real failures block; environment and flaky problems are major. */
export function severityForCategory(category: FailureCategory): Severity {
  return category === "environment" || category === "flaky" || category === "unknown" ? "major" : "blocker";
}

// ---- Plans (manager planner) --------------------------------------------------------------------

const STAGE_ALIASES: Record<string, StageKind> = {
  design: "design",
  architecture: "design",
  coding: "coding",
  code: "coding",
  implementation: "coding",
  implement: "coding",
  development: "coding",
  testing: "testing",
  test: "testing",
  tests: "testing",
  verification: "testing",
  verify: "testing",
  execution: "testing",
  document: "document",
  documentation: "document",
  docs: "document",
  doc: "document",
};

export function normalizePlan(input: unknown): PlanSubmissionInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.stages) || !raw.stages.length) {
    throw new Error(`\`stages\` must be a non-empty array using: ${STAGE_ORDER.join(", ")}.`);
  }
  const chosen = new Set<StageKind>();
  for (const value of raw.stages) {
    const stage = STAGE_ALIASES[String(value ?? "").trim().toLowerCase()];
    if (!stage) throw new Error(`Unknown stage '${String(value)}'. Use: ${STAGE_ORDER.join(", ")}.`);
    chosen.add(stage);
  }
  const stages = STAGE_ORDER.filter((stage) => chosen.has(stage));
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) throw new Error("`rationale` is required: explain why these stages fit the request.");
  const given = (raw.instructions && typeof raw.instructions === "object" ? raw.instructions : {}) as Record<string, unknown>;
  const instructions: Partial<Record<StageKind, string>> = {};
  for (const stage of stages) {
    const text = typeof given[stage] === "string" ? (given[stage] as string).trim() : "";
    if (!text) throw new Error(`instructions.${stage} is required: write the assignment for the ${stage} agents (scope, acceptance criteria${stage === "testing" ? ", the commands or suites to run" : ""}).`);
    instructions[stage] = truncate(text, 4000);
  }
  const briefing = typeof raw.briefing === "string" ? raw.briefing.trim() : "";
  if (!briefing) {
    throw new Error(
      "`briefing` is required: tell the sub-agents what you learned about the repository (relevant modules/files, conventions, how to build and test, pitfalls).",
    );
  }
  return { stages, rationale: truncate(rationale, 2000), instructions, briefing: truncate(briefing, 6000) };
}

/** Plan derived from keywords in the request, used when the planner never submits one. */
export function heuristicPlan(description: string): PlanSubmissionInput {
  const text = description.toLowerCase();
  const stages = new Set<StageKind>();
  if (/\b(design|architecture|architect|proposal|rfc|adr)\b/.test(text)) stages.add("design");
  if (/\b(implement|add|fix|refactor|build|create|change|update|support|bug|feature|code)\b/.test(text)) stages.add("coding");
  if (/\b(tests?|testing|automation|verify|verification|regression|e2e)\b/.test(text)) stages.add("testing");
  if (/\b(document|documentation|docs|readme|guide|runbook|manual|tutorial)\b/.test(text)) stages.add("document");
  if (!stages.size) stages.add("coding");
  return {
    stages: STAGE_ORDER.filter((stage) => stages.has(stage)),
    rationale: "The planner did not submit a plan, so the hub chose the stages from keywords in the request.",
    instructions: {},
  };
}
