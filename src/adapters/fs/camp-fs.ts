/**
 * Filesystem detection for camps and festivals + the progress watcher.
 * A camp root is identified by its `festivals/` dir plus any camp marker
 * (`.campaign/`, `camp.yaml`, `projects/`); a festival dir by `fest.yaml` /
 * `FESTIVAL_GOAL.md`; progress is tailed from `.fest/progress_events.jsonl`.
 */
import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { canonicalTaskPath, latestTaskStates, parseProgressLine } from "../../domain/progress.js";
import { FESTIVAL_STATUS_DIRECTORIES, isFestivalDateBucket, LIVE_FESTIVAL_STATUSES } from "../../domain/festival-lifecycle.js";
import type { CampLocation, FestivalSummary, PendingTask, ProgressEvent } from "../../domain/types.js";
import type { CampDetect } from "../../ports.js";


async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export class CampFsDetect implements CampDetect {
  async locate(cwd: string): Promise<CampLocation> {
    let dir = cwd;
    for (;;) {
      if (await this.isFestivalDir(dir)) {
        const campRoot = await this.findCampRoot(dirname(dir));
        return {
          kind: "festival",
          festivalDir: dir,
          festivalId: basename(dir),
          ...(campRoot
            ? { campRoot, campName: basename(campRoot) }
            : {}),
        };
      }
      if (await this.isCampRoot(dir)) {
        const rel = relative(dir, cwd);
        return {
          kind: rel === "projects" || rel.startsWith(`projects/`) ? "project" : "camp-root",
          campRoot: dir,
          campName: basename(dir),
        };
      }
      const parent = dirname(dir);
      if (parent === dir) {
        return { kind: "outside" };
      }
      dir = parent;
    }
  }

  async activeFestival(campRoot: string): Promise<string | undefined> {
    for (const status of LIVE_FESTIVAL_STATUSES) {
      const dir = join(campRoot, "festivals", status);
      for (const name of await safeReaddir(dir)) {
        if (!name.startsWith(".")) {
          const candidate = join(dir, name);
          if (await this.isFestivalDir(candidate)) return candidate;
        }
      }
    }
    return undefined;
  }

  async listFestivals(campRoot: string): Promise<FestivalSummary[]> {
    const found: FestivalSummary[] = [];
    for (const { status, directory } of FESTIVAL_STATUS_DIRECTORIES) {
      const dir = join(campRoot, "festivals", directory);
      for (const name of await safeReaddir(dir)) {
        if (name.startsWith(".")) continue;
        const path = join(dir, name);
        if (await this.isFestivalDir(path)) {
          found.push({ id: name, name, status, path });
        } else if ((directory.includes("/") || status === "completed") && isFestivalDateBucket(name)) {
          for (const id of await safeReaddir(path)) {
            if (id.startsWith(".")) continue;
            const festivalPath = join(path, id);
            if (await this.isFestivalDir(festivalPath)) {
              found.push({ id, name: id, status, path: festivalPath });
            }
          }
        }
      }
    }
    return found;
  }

  progressFile(festivalDir: string): string {
    return join(festivalDir, ".fest", "progress_events.jsonl");
  }

  async pendingTasks(festivalDir: string): Promise<PendingTask[]> {
    const events = await this.readProgress(festivalDir);
    const states = latestTaskStates(events);
    const tasks: PendingTask[] = [];
    const scanSequences = async (phase: string, phaseDir: string, includeCompleted = true): Promise<void> => {
      for (const seq of await safeReaddir(phaseDir)) {
        if (seq === "completed" && includeCompleted) {
          await scanSequences(phase, join(phaseDir, seq), false);
          continue;
        }
        if (!/^\d{2,3}_/.test(seq)) continue;
        const seqDir = join(phaseDir, seq);
        if (!(await stat(seqDir).catch(() => undefined))?.isDirectory()) continue;
        for (const file of await safeReaddir(seqDir)) {
          if (!/^\d{2}_.*\.md$/.test(file)) continue;
          const full = join(seqDir, file);
          const head = await readFile(full, "utf8").catch(() => "");
          const festType = /^fest_type:\s*(\w+)/m.exec(head)?.[1];
          if (festType && festType !== "task") continue;
          const rel = relative(festivalDir, full);
          tasks.push({ sequence: `${phase}/${seq}`, path: rel, done: states.get(canonicalTaskPath(rel)) === "completed" });
        }
      }
    };
    for (const base of [festivalDir, join(festivalDir, "completed")]) {
      for (const phase of await safeReaddir(base)) {
        if (/^\d{3}_/.test(phase)) await scanSequences(phase, join(base, phase));
      }
    }
    return tasks;
  }

  async readProgress(festivalDir: string): Promise<ProgressEvent[]> {
    try {
      const raw = await readFile(this.progressFile(festivalDir), "utf8");
      return raw
        .split("\n")
        .map(parseProgressLine)
        .filter((e): e is ProgressEvent => e !== undefined);
    } catch {
      return [];
    }
  }

  watch(festivalDir: string, onEvent: (event: ProgressEvent) => void): () => void {
    const file = this.progressFile(festivalDir);
    let offset = 0;
    const pump = async (): Promise<void> => {
      try {
        const raw = await readFile(file, "utf8");
        const fresh = raw.slice(offset);
        offset = raw.length;
        for (const line of fresh.split("\n")) {
          const event = parseProgressLine(line);
          if (event) {
            onEvent(event);
          }
        }
      } catch {
        // file not created yet — watcher retries on next change
      }
    };
    try {
      const fsWatcher = watch(dirname(file), () => {
        void pump();
      });
      return () => {
        fsWatcher.close();
      };
    } catch {
      return () => undefined;
    }
  }

  private async isCampRoot(dir: string): Promise<boolean> {
    if (!(await exists(join(dir, "festivals")))) {
      return false;
    }
    for (const marker of [".campaign", "camp.yaml", "projects"]) {
      if (await exists(join(dir, marker))) {
        return true;
      }
    }
    return false;
  }

  private async isFestivalDir(dir: string): Promise<boolean> {
    return (
      (await exists(join(dir, "fest.yaml"))) ||
      (await exists(join(dir, "FESTIVAL_GOAL.md")))
    );
  }

  private async findCampRoot(dir: string): Promise<string | undefined> {
    let current = dir;
    for (;;) {
      if (await this.isCampRoot(current)) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

