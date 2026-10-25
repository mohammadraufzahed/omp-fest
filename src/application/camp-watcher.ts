/**
 * Transition watcher: watches the camp's festivals/ dir for lifecycle moves
 * (planning → ready → active → completed, new festivals appearing) and reports
 * transitions — as a human notify + a silent context message, never a turn.
 */
import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FESTIVAL_STATUS_DIRECTORIES, isFestivalDateBucket } from "../domain/festival-lifecycle.js";
import type { CampDetect } from "../ports.js";

/** id → status for every festival in the camp. */
export type CampSnapshot = Map<string, string>;


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
  detect.bustCache?.();
  const festivals = await detect.listFestivals(campRoot);
  return new Map(festivals.map((f) => [f.id, f.status]));
}

/** Watch lifecycle containers and terminal date buckets, never festival contents. */
export function watchCampTransitions(
  detect: CampDetect,
  campRoot: string,
  onTransitions: (messages: string[]) => void,
): () => void {
  let snapshot: CampSnapshot | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;
  let stopped = false;
  // Read through a function after awaits: close() can run while I/O is pending.
  const isStopped = (): boolean => stopped;
  const watchers = new Map<string, FSWatcher>();

  const refreshWatches = async (): Promise<void> => {
    const root = join(campRoot, "festivals");
    const paths = new Set([root, join(root, "dungeon"), join(root, ".dungeon")]);
    const watchPath = (path: string): void => {
      if (isStopped() || watchers.has(path)) return;
      try {
        watchers.set(path, watch(path, debounced));
      } catch {
        // Existing parents discover lifecycle containers when they are created.
      }
    };
    for (const path of paths) watchPath(path);
    for (const { directory } of FESTIVAL_STATUS_DIRECTORIES) {
      const path = join(root, directory);
      paths.add(path);
      watchPath(path);
      if (!directory.includes("/")) continue;
      for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && isFestivalDateBucket(entry.name)) paths.add(join(path, entry.name));
      }
    }
    if (isStopped()) return;
    for (const [path, watcher] of watchers) {
      if (!paths.has(path)) {
        watcher.close();
        watchers.delete(path);
      }
    }
    for (const path of paths) watchPath(path);
  };

  const pump = async (): Promise<void> => {
    if (isStopped()) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await refreshWatches();
      const next = await snapshotCamp(detect, campRoot);
      if (isStopped()) return;
      if (snapshot) {
        const messages = diffSnapshots(snapshot, next);
        if (messages.length > 0) {
          onTransitions(messages);
        }
      }
      snapshot = next;
    } finally {
      running = false;
      if (queued && !isStopped()) {
        queued = false;
        void pump();
      }
    }
  };

  const debounced = (): void => {
    if (isStopped()) return;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => void pump(), 250);
  };

  void pump();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
