/**
 * Transition watcher: watches the camp's festivals/ dir for lifecycle moves
 * (planning → ready → active → completed, new festivals appearing) and reports
 * transitions — as a human notify + a silent context message, never a turn.
 */
import { watch } from "node:fs";
import { join } from "node:path";
import type { CampDetect } from "../ports.js";

/** id → status for every festival in the camp. */
export type CampSnapshot = Map<string, string>;

const STATUS_DIRS = ["planning", "ready", "active", "parked", "completed", "ritual"] as const;

export function diffSnapshots(prev: CampSnapshot, next: CampSnapshot): string[] {
  const messages: string[] = [];
  for (const [id, status] of next) {
    const before = prev.get(id);
    if (before === undefined) {
      messages.push(`festival ${id} appeared (${status})`);
    } else if (before !== status) {
      messages.push(`festival ${id}: ${before} → ${status}`);
    }
  }
  for (const [id, status] of prev) {
    if (!next.has(id)) {
      messages.push(`festival ${id} disappeared (was ${status})`);
    }
  }
  return messages;
}

export async function snapshotCamp(detect: CampDetect, campRoot: string): Promise<CampSnapshot> {
  const festivals = await detect.listFestivals(campRoot);
  return new Map(festivals.map((f) => [f.id, f.status]));
}

/**
 * Watch every status dir under festivals/ non-recursively: festival dirs are
 * created/moved between status dirs, so parent-level watches catch every
 * lifecycle transition without relying on recursive fs.watch support.
 * Returns the unwatch function.
 */
export function watchCampTransitions(
  detect: CampDetect,
  campRoot: string,
  onTransitions: (messages: string[]) => void,
): () => void {
  let snapshot: CampSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;

  const pump = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const next = await snapshotCamp(detect, campRoot);
      if (snapshot) {
        const messages = diffSnapshots(snapshot, next);
        if (messages.length > 0) {
          onTransitions(messages);
        }
      }
      snapshot = next;
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void pump();
      }
    }
  };

  const debounced = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void pump(), 250);
  };

  const watchers = STATUS_DIRS.map((status) => {
    try {
      return watch(join(campRoot, "festivals", status), debounced);
    } catch {
      return undefined;
    }
  });
  void pump();
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    for (const w of watchers) {
      w?.close();
    }
  };
}
