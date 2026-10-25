/**
 * Core domain types for omp-fest.
 *
 * These mirror the fest.build model: a camp contains projects and festivals;
 * a festival contains phases; a phase is either a WORKFLOW.md of steps or
 * sequences of task files, and ends with a GATES.md phase gate.
 */

export type CampLocationKind = "camp-root" | "project" | "festival" | "outside";

export interface CampLocation {
  kind: CampLocationKind;
  /** Camp root directory when inside a camp. */
  campRoot?: string;
  /** Camp display name (directory basename). */
  campName?: string;
  /** Festival directory when inside one (or the resolved active festival). */
  festivalDir?: string;
  /** Festival id like "demo-fest-DF0001". */
  festivalId?: string;
}

export type TaskState =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "deferred";

export type Autonomy = "low" | "medium" | "high";

/** A task-file unit emitted by `fest next` for implementation phases. */
export interface TaskUnit {
  kind: "task";
  /** Festival-relative task path, e.g. 003_IMPLEMENT/01_core/02_implement.md */
  path: string;
  phase?: string;
  sequence?: string;
  workingDir?: string;
  autonomy?: Autonomy;
  /** Rendered task document (objective, requirements, done-when). */
  doc: string;
  goals: string[];
}

/** A WORKFLOW.md step unit (planning/ingest/research phases). */
export interface WorkflowStepUnit {
  kind: "wf_step";
  phase: string;
  phaseType?: string;
  step: number;
  totalSteps: number;
  title: string;
  goal: string;
  actions: string[];
  checkpoint: boolean;
  doc: string;
}

/** A GATES.md phase-gate step — requires human attestation. */
export interface GateStepUnit {
  kind: "gate_step";
  phase: string;
  step: number;
  totalSteps: number;
  question: string;
  doc: string;
}

/** `fest next` refused: validation errors must be fixed first. */
export interface BlockedUnit {
  kind: "blocked";
  errors: ValidationIssue[];
  raw: string;
}

export interface CompleteUnit {
  kind: "complete";
  reason?: string;
}

export interface IdleUnit {
  kind: "idle";
  reason: string;
}

export type NextUnit =
  | TaskUnit
  | WorkflowStepUnit
  | GateStepUnit
  | BlockedUnit
  | CompleteUnit
  | IdleUnit;

/** One structural problem reported by `fest next` STOP / `fest validate`. */
export interface ValidationIssue {
  file: string;
  /** Unfilled marker tokens like "[REPLACE: ...]" found in the file. */
  markers: string[];
  /** Non-marker error text (e.g. missing fest_working_dir). */
  error?: string;
}

/** One line of `.fest/progress_events.jsonl`. */
export interface ProgressEvent {
  ts: string;
  event: string;
  phase?: string;
  step?: number;
  totalSteps?: number;
  task?: string;
  [key: string]: unknown;
}

export interface PendingTask {
  /** Sequence the task belongs to (tasks in different sequences are parallel-safe). */
  sequence: string;
  /** Festival-relative task path. */
  path: string;
  done: boolean;
}

export interface FestivalProgress {
  completed: number;
  total: number;
  percent: number;
  gatePending: boolean;
  currentLabel?: string;
}

export interface FestivalSummary {
  id: string;
  name: string;
  status: string;
  path: string;
  progress?: number;
  tokens?: number;
}

export interface CampProject {
  name: string;
  path: string;
}

export interface GateRequest {
  phase: string;
  step: number;
  totalSteps: number;
  question: string;
  evidence?: string;
}

export type GateDecision =
  | { action: "approve" }
  | { action: "reject"; reason: string }
  | { action: "pending" };

/** Machine-checkable camp conventions (vs RULES.md judgement rules). See conventions.ts. */
export interface Conventions {
  /** Regex festival names must match at scaffold; empty = unchecked. */
  festivalName: string;
  /** Worktree branch template; {festival}/{project}/{camp} placeholders. */
  branch: string;
  /** Worktree dir template relative to the camp root. */
  worktreeDir: string;
  /** "free" passes messages through, "conventional" validates type(scope): subject, "prefix" prepends commitPrefix. */
  commitStyle: "free" | "conventional" | "prefix";
  /** Prepended to commit messages when commitStyle is "prefix". */
  commitPrefix?: string;
  /** How fest_complete merges festival worktree branches back. */
  finishMerge: "merge" | "squash";
}

export const DEFAULT_CONVENTIONS: Conventions = {
  festivalName: "",
  branch: "fest/{festival}",
  worktreeDir: "projects/worktrees/{project}/{festival}",
  commitStyle: "free",
  commitPrefix: "[{camp}:{festival}]",
  finishMerge: "merge",
};

export interface OmpFestConfig {
  statusLine: boolean;
  watchTransitions: boolean;
  progressWidget: boolean;
  autoCommitAfterTask: "ask" | "always" | "never";
  autonomyCeiling: Autonomy;
  gateNotify: ("ui" | "camp-notify" | "webhook")[];
  webhookUrl?: string;
  pauseAtGates: boolean;
  evidenceRequiredOnGates: boolean;
  /** Per-file/checkout write reservations. Off for worktree-per-festival or legacy projects. */
  writeLocks: boolean;
  /** Subagent delegation policy: "never" blocks worker spawns, "always" delegates every unit, "auto" delegates units with disjoint scope. */
  delegateMode: "auto" | "always" | "never";
  /** Machine-checkable naming/commit conventions enforced by the plugin. */
  conventions: Conventions;
  /** Non-fatal config problems found at load time (never persisted). */
  configWarnings?: string[];
}

export const DEFAULT_CONFIG: OmpFestConfig = {
  statusLine: true,
  watchTransitions: true,
  progressWidget: true,
  autoCommitAfterTask: "ask",
  autonomyCeiling: "medium",
  gateNotify: ["ui", "camp-notify"],
  pauseAtGates: true,
  evidenceRequiredOnGates: true,
  writeLocks: true,
  delegateMode: "auto",
  conventions: DEFAULT_CONVENTIONS,
};
