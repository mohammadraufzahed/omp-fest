/**
 * Ports — the seams between pure domain logic and the outside world
 * (child processes, filesystem, omp UI). Adapters implement these; tests
 * substitute fakes.
 */
import type {
  CampLocation,
  CampProject,
  FestivalSummary,
  GateDecision,
  GateRequest,
  NextUnit,
  PendingTask,
  ProgressEvent,
} from "./domain/types.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecRunner {
  run(command: string, args: string[], cwd?: string): Promise<ExecResult>;
}

/** Structured access to the `fest` CLI. */
export interface FestCli {
  available(): Promise<boolean>;
  version(): Promise<string | undefined>;
  next(festivalDir: string): Promise<NextUnit>;
  taskComplete(festivalDir: string, task: string, evidence?: string): Promise<void>;
  taskMutate(
    festivalDir: string,
    action: "blocked" | "defer" | "unblock" | "reset" | "update",
    opts: { task?: string; reason?: string; percent?: string },
  ): Promise<void>;
  commit(festivalDir: string, message: string): Promise<string>;
  validate(festivalDir: string, fix?: boolean): Promise<{ score: number; output: string }>;
  workflowAdvance(festivalDir: string): Promise<string>;
  workflowStatus(festivalDir: string): Promise<string>;
  workflowApprove(festivalDir: string): Promise<string>;
  workflowReject(festivalDir: string, reason: string): Promise<string>;
  markersCount(festivalDir: string): Promise<number>;
  markersList(festivalDir: string): Promise<string>;
  /** `fest scaffold from-plan` — generate a festival from a STRUCTURE.md doc. Runs at campRoot. */
  scaffoldFromPlan(
    campRoot: string,
    opts: { plan: string; name: string; dest?: string; dryRun?: boolean },
  ): Promise<string>;
  /** `fest promote` — advance a festival one lifecycle step. Runs at campRoot or inside the festival. */
  promote(cwd: string, name?: string): Promise<string>;
  /**
   * `fest gates apply --approve` inside a festival. `fest scaffold from-plan` does NOT create
   * the festival-level `gates/` template dir, so when it's missing this seeds it from the camp's
   * `.festival/templates/phases/implementation/gates/` templates first. Returns files created.
   */
  gatesApply(campRoot: string, festivalDir: string): Promise<{ created: number; output: string }>;
  /** Raw passthrough for the long tail of `fest` subcommands. */
  raw(cwd: string, args: string[]): Promise<ExecResult>;
  list(campRoot: string): Promise<FestivalSummary[]>;
  rules(festivalDir: string): Promise<string>;
  context(cwd: string): Promise<string>;
  status(festivalDir: string): Promise<string>;
  show(festivalDir: string, selector?: string): Promise<string>;
}

/** Structured access to the `camp` CLI. */
export interface CampCli {
  available(): Promise<boolean>;
  projects(campRoot: string): Promise<CampProject[]>;
  ideaAdd(campRoot: string, text: string): Promise<string>;
  /** Raw passthrough for the long tail of `camp` subcommands. */
  raw(cwd: string, args: string[]): Promise<ExecResult>;
  notify(campRoot: string, message: string): Promise<void>;
  jobsPending(campRoot: string): Promise<number>;
}

/** Filesystem-level camp/festival detection. */
export interface CampDetect {
  locate(cwd: string): Promise<CampLocation>;
  activeFestival(campRoot: string): Promise<string | undefined>;
  /** Every festival in the camp (all status dirs), for guidance when none is active. */
  listFestivals(campRoot: string): Promise<FestivalSummary[]>;
  progressFile(festivalDir: string): string;
  readProgress(festivalDir: string): Promise<ProgressEvent[]>;
  pendingTasks(festivalDir: string): Promise<PendingTask[]>;
  watch(festivalDir: string, onEvent: (event: ProgressEvent) => void): () => void;
}

export interface Notifier {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Human-facing gate channel: present a gate, receive a decision. */
export interface GatePresenter {
  present(request: GateRequest): Promise<GateDecision>;
}
