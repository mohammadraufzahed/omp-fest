/**
 * LoopTracker: watches task lifecycle so the plugin can nudge when work was
 * done but `fest task completed` + `fest commit` never landed — the most
 * common way a festival's work record goes stale.
 */
export interface LoopState {
  /** Task currently being executed (festival-relative path). */
  openTask?: string;
  taskCompleted: boolean;
  commitDone: boolean;
}

export class LoopTracker {
  private state: LoopState = { taskCompleted: false, commitDone: false };

  taskOpened(path: string): void {
    this.state = { openTask: path, taskCompleted: false, commitDone: false };
  }

  taskCompleted(): void {
    this.state.taskCompleted = true;
  }

  committed(): void {
    this.state.commitDone = true;
  }

  cleared(): void {
    this.state = { taskCompleted: false, commitDone: false };
  }

  /** Nudge message when the record is stale, or undefined when clean. */
  nudge(): string | undefined {
    const { openTask, taskCompleted, commitDone } = this.state;
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
