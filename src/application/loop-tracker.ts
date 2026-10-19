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
  private readonly festivals = new Map<string, string>();

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

  /** Record which festival this session is working — digest/tracking then follow it instead of the camp-wide active pick. */
  claimFestival(sessionId: string, festivalDir: string): void {
    this.festivals.set(sessionId, festivalDir);
  }

  festivalFor(sessionId: string): string | undefined {
    return this.festivals.get(sessionId);
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
