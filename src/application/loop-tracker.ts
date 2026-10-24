/**
 * LoopTracker: watches task lifecycle so the plugin can nudge when work was
 * done but `fest task completed` + `fest commit` never landed — the most
 * common way a festival's work record goes stale.
 *
 * Everything is keyed by omp session id: parallel agents (main + subagent
 * lanes) work different festivals in the same process, so a shared
 * openTaskPath or warn-set would leak one agent's unit into another's
 * digest and discipline rules.
 */
import { basename } from "node:path";
export interface LoopState {
  /** Task currently being executed (festival-relative path). */
  openTask?: string;
  taskCompleted: boolean;
  commitDone: boolean;
  pausedReason?: string;
}

const EMPTY: LoopState = { taskCompleted: false, commitDone: false };

export class LoopTracker {
  private readonly states = new Map<string, LoopState>();
  private readonly warned = new Map<string, Set<string>>();
  private readonly festivals = new Map<string, { id: string; dir?: string }>();

  private stateOf(sessionId: string): LoopState {
    return this.states.get(sessionId) ?? EMPTY;
  }

  /** Dedupe untracked-edit warnings per session: true when this session wasn't warned for the path yet. */
  markWarned(sessionId: string, path: string): boolean {
    const set = this.warned.get(sessionId) ?? new Set<string>();
    this.warned.set(sessionId, set);
    if (set.has(path)) {
      return false;
    }
    set.add(path);
    return true;
  }

  /**
   * Record which festival this session is working — digest/tracking then
   * follow it instead of the camp-wide active pick. The id is stored beside
   * the dir because `fest promote` renames festivals/<status>/<id>, leaving
   * the dir stale while the id survives. Returns true when the claim changed.
   */
  claimFestival(sessionId: string, festivalDir: string): boolean {
    const id = basename(festivalDir);
    const prev = this.festivals.get(sessionId);
    const changed = prev?.id !== id || prev.dir !== festivalDir;
    if (changed) {
      this.festivals.set(sessionId, { id, dir: festivalDir });
    }
    return changed;
  }

  /** Update the stored dir after the festival moved (e.g. promote). */
  moveClaimedFestival(sessionId: string, id: string, dir: string): void {
    if (this.festivals.get(sessionId)?.id === id) {
      this.festivals.set(sessionId, { id, dir });
    }
  }

  clearFestival(sessionId: string): void {
    this.festivals.delete(sessionId);
  }

  festivalFor(sessionId: string): string | undefined {
    return this.festivals.get(sessionId)?.dir;
  }

  claimedFestivalIdFor(sessionId: string): string | undefined {
    return this.festivals.get(sessionId)?.id;
  }

  /**
   * Restore a claim persisted in the session transcript. The stored dir may
   * be stale or absent (festival moved status dirs) — claimedFestivalDir
   * re-resolves by id at use time. Returns the claimed id, or undefined when
   * the persisted data carried neither id nor dir.
   */
  restoreClaim(sessionId: string, festivalId?: string, festivalDir?: string): string | undefined {
    const id = festivalId ?? (festivalDir ? basename(festivalDir) : undefined);
    if (!id) {
      return undefined;
    }
    this.festivals.set(sessionId, { id, ...(festivalDir ? { dir: festivalDir } : {}) });
    return id;
  }

  taskOpened(sessionId: string, path: string): void {
    const previous = this.stateOf(sessionId);
    this.states.set(sessionId, {
      openTask: path, taskCompleted: false, commitDone: false,
      ...(previous.openTask === path && previous.pausedReason ? { pausedReason: previous.pausedReason } : {}),
    });
  }

  taskPaused(sessionId: string, path: string, reason: string): void {
    const previous = this.stateOf(sessionId);
    this.states.set(sessionId, {
      openTask: path, taskCompleted: previous.openTask === path && previous.taskCompleted,
      commitDone: previous.openTask === path && previous.commitDone, pausedReason: reason,
    });
  }

  taskResumed(sessionId: string, path: string): void {
    const previous = this.stateOf(sessionId);
    if (previous.openTask === path && previous.pausedReason) {
      this.states.set(sessionId, { openTask: path, taskCompleted: previous.taskCompleted, commitDone: previous.commitDone });
    }
  }

  taskCompleted(sessionId: string): void {
    const previous = this.stateOf(sessionId);
    this.states.set(sessionId, {
      ...(previous.openTask ? { openTask: previous.openTask } : {}),
      taskCompleted: true, commitDone: previous.commitDone,
    });
  }

  committed(sessionId: string): void {
    const s = { ...this.stateOf(sessionId), commitDone: true };
    this.states.set(sessionId, s);
  }

  cleared(sessionId: string): void {
    this.states.set(sessionId, { taskCompleted: false, commitDone: false });
  }

  openTaskPathFor(sessionId: string): string | undefined {
    return this.stateOf(sessionId).openTask;
  }
  pausedReasonFor(sessionId: string, path: string | undefined): string | undefined {
    const state = this.stateOf(sessionId);
    return path && state.openTask === path ? state.pausedReason : undefined;
  }

  /** A task is actionable only when opened and not explicitly paused by the supervisor. */
  unfinishedFor(sessionId: string): boolean {
    const s = this.stateOf(sessionId);
    return s.openTask !== undefined && !s.pausedReason && !(s.taskCompleted && s.commitDone);
  }

  /** Nudge only with an action appropriate to the task's actual state. */
  nudge(sessionId: string): string | undefined {
    const { openTask, taskCompleted, commitDone, pausedReason } = this.stateOf(sessionId);
    if (!openTask || (taskCompleted && commitDone)) {
      return undefined;
    }
    if (pausedReason) return `Festival task ${openTask} is paused: ${pausedReason}. Do not mark it completed or commit while blocked.`;
    const missing = [
      taskCompleted ? undefined : "fest task completed",
      commitDone ? undefined : "fest commit",
    ].filter((s): s is string => s !== undefined);
    return `Festival task ${openTask} still open — record it: ${missing.join(" + ")}`;
  }
}
