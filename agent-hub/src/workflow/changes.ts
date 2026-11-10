import {
  kindForStages,
  STAGE_ORDER,
  stageKindsOf,
  type ChangePlan,
  type ChangeRequest,
  type ReviewComment,
  type Round,
  type Stage,
  type StageKind,
  type Task,
  type TaskKind,
} from "../types.ts";
import { truncate } from "../util.ts";
import { isReviewStage, stageNamed } from "./submissions.ts";

/**
 * Change requests: what the user asks of a task after it ran (or while it waits), whatever its state. The manager
 * re-evaluates the task for them - which teams (stages) handle the request: the existing team revising its work, new
 * teams (e.g. coding to implement a finished design), or fewer (an unfinished stage the request makes unnecessary) -
 * and the task's type follows its stages. The user can also hand a request to a stage directly.
 */

export const STAGE_TITLES: Record<StageKind, string> = { design: "Design", coding: "Coding", testing: "Execute & verify", document: "Document" };

export const KIND_TITLES: Record<TaskKind, string> = {
  auto: "Auto (manager plans)",
  coding: "Coding",
  design: "Design",
  document: "Document",
  testing: "Execute & verify",
  "design-coding": "Design → Coding",
  review: "Code review",
};

const CHANGED_ARTIFACT: Record<StageKind, string> = { design: "design document", coding: "code", testing: "code and tests", document: "document" };

/** How change requests are handled: from the manager's re-plan, or the stage the user chose. */
export interface ChangeDecision {
  /** Every stage the task has from now on. */
  stages: StageKind[];
  /** The stage whose agents revise their work for the requests (a stage without work yet starts afresh with them). */
  changeStage?: StageKind;
  /** Assignments for the stages' teams; each replaces the stage's current one. */
  instructions: Partial<Record<StageKind, string>>;
  rationale: string;
  briefing?: string;
  routing: "manager" | "user";
  /** The manager could not re-plan: the requests go to the latest stage, and nothing else changes. */
  fallback?: boolean;
}

/** What applying change requests did to the task. */
export interface AppliedChange {
  previous: StageKind[];
  stages: StageKind[];
  added: StageKind[];
  dropped: StageKind[];
  /** The stage that revises its work for the requests (it got a round holding them). */
  target?: StageKind;
  /** The change stage had no work yet: it starts afresh with the requests. */
  fresh?: StageKind;
  /** Later stages that bring their work in line (the testing stage re-runs the tests). */
  later: StageKind[];
  round?: number;
  kind?: { from: TaskKind; to: TaskKind };
}

/** The stage produced something: an author round, or a test run. */
export function stageHasWork(stage: Stage | undefined): boolean {
  return Boolean(stage?.rounds.some((round) => round.author || (round.review && round.review.by !== "user")));
}

const finished = (stage: Stage | undefined): boolean => stage?.status === "approved" || stage?.status === "not-approved";

/** Change requests the manager has yet to re-plan the task for. */
export function pendingChangeRequests(task: Pick<Task, "changeRequests">): ChangeRequest[] {
  return (task.changeRequests ?? []).filter((request) => request.pending);
}

/** Where a change goes without a plan: the latest stage that has work, otherwise the first stage. */
export function defaultChangeStage(task: Task): StageKind | undefined {
  const kinds = stageKindsOf(task);
  return [...kinds].reverse().find((kind) => stageHasWork(task.stages.find((stage) => stage.kind === kind))) ?? kinds[0];
}

/**
 * Validates the manager's plan for change requests (its `submit_plan` while re-planning). The errors are written for
 * the planner, which gets them back and submits again.
 */
export function normalizeChangePlan(input: unknown, task: Task): ChangeDecision {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.stages) || !raw.stages.length) {
    throw new Error(`\`stages\` must list every stage the task has from now on, using: ${STAGE_ORDER.join(", ")}.`);
  }
  const chosen = new Set<StageKind>();
  for (const value of raw.stages) {
    const name = String(value ?? "").trim().toLowerCase();
    if (isReviewStage(name)) {
      throw new Error(
        "A change request cannot turn this task into a code review: the review team reviews changes someone else wrote. List the stages whose teams handle the request: design, coding, testing, document.",
      );
    }
    const stage = stageNamed(name);
    if (!stage) throw new Error(`Unknown stage '${String(value)}'. Use: ${STAGE_ORDER.join(", ")}.`);
    chosen.add(stage);
  }
  const stages = STAGE_ORDER.filter((kind) => chosen.has(kind));
  const current = stageKindsOf(task);
  const stageOf = (kind: StageKind) => task.stages.find((stage) => stage.kind === kind);
  for (const kind of current) {
    if (!chosen.has(kind) && finished(stageOf(kind)) && stageHasWork(stageOf(kind))) {
      throw new Error(`Keep the ${kind} stage: its work is finished and stays on the task branch. A finished stage does not run again unless it is the \`change_stage\`.`);
    }
  }
  const rawChange = typeof raw.change_stage === "string" ? raw.change_stage.trim().toLowerCase() : "";
  let changeStage: StageKind | undefined;
  if (rawChange && rawChange !== "none") {
    changeStage = stageNamed(rawChange);
    if (!changeStage) throw new Error(`Unknown change_stage '${String(raw.change_stage)}': name one of the stages you listed, or omit it.`);
    if (!chosen.has(changeStage)) throw new Error(`change_stage '${changeStage}' must be one of the stages you listed in \`stages\`.`);
  }
  const added = stages.filter((kind) => !current.includes(kind));
  const dropped = current.filter((kind) => !chosen.has(kind));
  if (!changeStage && !added.length && !dropped.length) {
    throw new Error("Nothing in this plan handles the change request: name the stage whose agents make the change in `change_stage`, or add (or drop) stages.");
  }
  const given = (raw.instructions && typeof raw.instructions === "object" ? raw.instructions : {}) as Record<string, unknown>;
  const instructions: Partial<Record<StageKind, string>> = {};
  for (const kind of stages) {
    const text = typeof given[kind] === "string" ? (given[kind] as string).trim() : "";
    if (text) instructions[kind] = truncate(text, 4000);
    else if (added.includes(kind) && !task.plan?.instructions[kind]?.trim()) {
      throw new Error(
        `instructions.${kind} is required: write the assignment for the new ${kind} stage (what to do for the request, scope, acceptance criteria${kind === "testing" ? ", the commands or suites to run" : ""}).`,
      );
    }
  }
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) throw new Error("`rationale` is required: explain in 1-3 sentences why these teams handle the request.");
  const briefing = typeof raw.briefing === "string" && raw.briefing.trim() ? truncate(raw.briefing.trim(), 6000) : undefined;
  return { stages, ...(changeStage ? { changeStage } : {}), instructions, rationale: truncate(rationale, 2000), ...(briefing ? { briefing } : {}), routing: "manager" };
}

/**
 * Applies change requests to the task: its stages from now on (new teams added; unfinished stages dropped, keeping
 * their history as "skipped"), a round of the change stage holding the requests (a stage without work starts afresh
 * instead), rounds asking later stages that have work to bring it in line, and - for the manager's plans - the teams'
 * assignments and the task type that matches the stages.
 */
export function applyChangePlan(task: Task, requests: readonly ChangeRequest[], decision: ChangeDecision, now: string): AppliedChange {
  const previous = stageKindsOf(task);
  const stages = STAGE_ORDER.filter((kind) => decision.stages.includes(kind));
  const added = stages.filter((kind) => !previous.includes(kind));
  const dropped = previous.filter((kind) => !stages.includes(kind));
  const ids = requests.map((request) => request.id).join(", ");

  for (const kind of stages) {
    const stage = task.stages.find((candidate) => candidate.kind === kind);
    if (!stage) {
      task.stages.push({ kind, status: "pending", rounds: [], nextCommentNumber: 1 });
    } else if (stage.status === "skipped") {
      stage.status = "pending";
      delete stage.skippedFor;
    }
  }
  for (const kind of dropped) {
    const stage = task.stages.find((candidate) => candidate.kind === kind);
    if (!stage) continue;
    if (stage.rounds.length) {
      stage.status = "skipped";
      stage.skippedFor = requests[0]?.id;
      delete stage.rerun;
    } else {
      task.stages.splice(task.stages.indexOf(stage), 1);
    }
  }
  task.stages.sort((a, b) => STAGE_ORDER.indexOf(a.kind) - STAGE_ORDER.indexOf(b.kind));
  const stageOf = (kind: StageKind) => task.stages.find((stage) => stage.kind === kind)!;

  const applied: AppliedChange = { previous, stages, added, dropped, later: [] };
  const target = decision.changeStage;
  if (target) {
    const stage = stageOf(target);
    dropUnstartedRounds(stage);
    if (stageHasWork(stage)) {
      applied.target = target;
      applied.round = addRequestRound(
        stage,
        task.attempt,
        now,
        `Change request ${ids} from the user`,
        requests.map((request) => ({ id: request.id, severity: "major", body: request.text, status: "open" })),
      );
      for (const kind of stages.slice(stages.indexOf(target) + 1)) {
        const next = stageOf(kind);
        if (!stageHasWork(next)) continue;
        dropUnstartedRounds(next);
        if (kind === "testing") {
          // A testing stage that has a request round waiting re-runs the tests after its fixer's round anyway.
          if (!awaitsRequest(next)) next.rerun = true;
          next.status = "pending";
        } else {
          addRequestRound(
            next,
            task.attempt,
            now,
            `Bring this stage in line with change request ${ids}`,
            requests.map((request) => ({ id: request.id, severity: "major", body: cascadeRequest(target, kind, request.id, request.text), status: "open" })),
          );
        }
        applied.later.push(kind);
      }
    } else {
      applied.fresh = target;
      stage.status = "pending";
    }
  }

  const manager = decision.routing === "manager" && !decision.fallback;
  if (manager) {
    if (task.kind !== "auto" && task.kind !== "review") {
      const to = kindForStages(stages) ?? "auto";
      if (to !== task.kind) {
        applied.kind = { from: task.kind, to };
        task.kind = to;
      }
    }
    const briefing = decision.briefing ?? task.plan?.briefing;
    task.plan = {
      ...task.plan,
      stages,
      rationale: task.plan?.rationale ?? decision.rationale,
      instructions: { ...(task.plan?.instructions ?? {}), ...decision.instructions },
      ...(briefing ? { briefing } : {}),
      plannedAt: task.plan?.plannedAt ?? now,
    };
  }

  const handledBy = target ?? added[0] ?? stages.find((kind) => !finished(stageOf(kind)));
  const plan: ChangePlan | undefined =
    decision.routing === "manager"
      ? {
          previous,
          stages,
          added,
          dropped,
          ...(applied.kind ? { kind: applied.kind } : {}),
          rationale: decision.rationale,
          ...(decision.fallback ? { fallback: true } : {}),
          plannedAt: now,
        }
      : undefined;
  for (const request of requests) {
    delete request.pending;
    if (handledBy) request.stage = handledBy;
    else delete request.stage;
    if (applied.round !== undefined) request.round = applied.round;
    else delete request.round;
    if (plan) request.plan = plan;
  }
  return applied;
}

/** Requests that arrived before the manager first planned the task: its plan covers them. */
export function foldIntoPlan(task: Task, requests: readonly ChangeRequest[], now: string): void {
  const stages = task.plan?.stages ?? [];
  for (const request of requests) {
    delete request.pending;
    delete request.round;
    if (stages[0]) request.stage = stages[0];
    else delete request.stage;
    request.plan = { previous: [], stages: [...stages], added: [...stages], dropped: [], rationale: task.plan?.rationale ?? "", initial: true, plannedAt: now };
  }
}

/** "adds Coding; the task becomes Design → Coding" - what a change did, for the timeline and the manager's log. */
export function describeChange(applied: AppliedChange): string {
  const titles = (kinds: readonly StageKind[]) => kinds.map((kind) => STAGE_TITLES[kind]).join(", ");
  const parts: string[] = [];
  if (applied.target) parts.push(`the ${STAGE_TITLES[applied.target]} team revises its work`);
  if (applied.fresh) parts.push(`the ${STAGE_TITLES[applied.fresh]} team starts afresh with it`);
  if (applied.added.length) parts.push(`adds ${titles(applied.added)}`);
  if (applied.dropped.length) parts.push(`drops ${titles(applied.dropped)}`);
  if (applied.later.length) parts.push(`then ${applied.later.map((kind) => (kind === "testing" ? "the tests run again" : `the ${STAGE_TITLES[kind]} stage updates to match`)).join(", then ")}`);
  if (!parts.length) parts.push("the remaining stages continue");
  return `${parts.join("; ")}${applied.kind ? ` (the task becomes ${KIND_TITLES[applied.kind.to]})` : ""}`;
}

/** What a later stage is asked to do after an earlier stage changed for a change request. */
export function cascadeRequest(changed: StageKind, stage: StageKind, id: string, request: string): string {
  const action =
    stage === "coding"
      ? "Bring the implementation (and its tests) in line with it"
      : stage === "design"
        ? "Update the design document to match"
        : "Update the document to match";
  const quoted = truncate(request, 4000)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  return `The ${CHANGED_ARTIFACT[changed]} changed in the ${STAGE_TITLES[changed]} stage for the user's change request ${id} (quoted below). ${action}; decline with the reason if nothing here needs to change.\n\n${quoted}`;
}

/**
 * The request is a round of its own: a "review" by the user whose comments the stage's agents must address. A stage
 * whose last round is already a request nobody has worked on yet gets the new comments in that round.
 */
function addRequestRound(stage: Stage, attempt: number, now: string, summary: string, comments: ReviewComment[]): number {
  const last = stage.rounds.at(-1);
  if (last && !last.author && last.review?.by === "user") {
    for (const comment of comments) {
      if (!last.review.comments.some((existing) => existing.id === comment.id)) last.review.comments.push(comment);
    }
    last.review.summary = `${last.review.summary}; ${summary}`;
    last.attempt = attempt;
    stage.status = "pending";
    delete stage.rerun;
    return last.n;
  }
  const round: Round = { n: stage.rounds.length + 1, attempt, startedAt: now, review: { verdict: "request_changes", by: "user", summary, comments, at: now } };
  stage.rounds.push(round);
  stage.status = "pending";
  // The request round's agents re-run the tests anyway; a pending re-run must not skip the request.
  delete stage.rerun;
  return round.n;
}

/** The stage's last round is a request nobody has worked on yet. */
function awaitsRequest(stage: Stage): boolean {
  const last = stage.rounds.at(-1);
  return Boolean(last && !last.author && last.review?.by === "user");
}

/** Rounds that never got going (no author work, no review), e.g. when the task failed or stopped as one began. */
function dropUnstartedRounds(stage: Stage): void {
  while (stage.rounds.length && !stage.rounds.at(-1)!.author && !stage.rounds.at(-1)!.review) stage.rounds.pop();
}
