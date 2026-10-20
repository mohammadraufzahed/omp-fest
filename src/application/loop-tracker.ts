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
    this.states.set(sessionId, { openTask: path, taskCompleted: false, commitDone: false });
  }

  taskCompleted(sessionId: string): void {
    const s = { ...this.stateOf(sessionId), taskCompleted: true };
    this.states.set(sessionId, s);
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

  /** A task was opened via fest_next but complete+commit haven't both landed. */
  unfinishedFor(sessionId: string): boolean {
    const s = this.stateOf(sessionId);
    return s.openTask !== undefined && !(s.taskCompleted && s.commitDone);
  }

  /** Nudge message when the record is stale, or undefined when clean. */
  nudge(sessionId: string): string | undefined {
    const { openTask, taskCompleted, commitDone } = this.stateOf(sessionId);
    if (!openTask || (taskCompleted && commitDone)) {
      return undefined;
    }
    const missing = [
      taskCompleted ? undefined : "fest task completed",
      commitDone ? undefined : "fest commit",
    ].filter((s): s is string => s !== undefined);
    return `Festival task ${openTask} still open — record it: ${missing.join(" + ")}`;
  }
}
