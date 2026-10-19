/**
 * CachedDetect — short-TTL memoization over the read-heavy CampDetect calls.
 * Tool calls and the tool_call hook re-resolve the same camp layout dozens of
 * times per turn; a ~1.5s cache kills the repeated filesystem walks without
 * letting promoted/scaffolded festivals go stale for long. Mutation paths
 * call bustCache() so the next read sees fresh state immediately.
 */
import type {
  CampLocation,
  FestivalSummary,
  PendingTask,
  ProgressEvent,
} from "../domain/types.js";
import type { CampDetect } from "../ports.js";

interface CacheSlot {
  at: number;
  value: unknown;
}

export class CachedDetect implements CampDetect {
  private readonly slots = new Map<string, CacheSlot>();

  constructor(
    private readonly inner: CampDetect,
    private readonly ttlMs = 1500,
  ) {}

  private async memo<T>(key: string, produce: () => Promise<T>): Promise<T> {
    const hit = this.slots.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return hit.value as T;
    }
    const value = await produce();
    this.slots.set(key, { at: Date.now(), value });
    return value;
  }

  /** Drop all memoized entries — call after camp-layout mutations. */
  bustCache(): void {
    this.slots.clear();
  }

  locate(cwd: string): Promise<CampLocation> {
    return this.memo(`locate:${cwd}`, () => this.inner.locate(cwd));
  }

  activeFestival(campRoot: string): Promise<string | undefined> {
    return this.memo(`active:${campRoot}`, () => this.inner.activeFestival(campRoot));
  }

  listFestivals(campRoot: string): Promise<FestivalSummary[]> {
    return this.memo(`list:${campRoot}`, () => this.inner.listFestivals(campRoot));
  }

  progressFile(festivalDir: string): string {
    return this.inner.progressFile(festivalDir);
  }

  readProgress(festivalDir: string): Promise<ProgressEvent[]> {
    return this.inner.readProgress(festivalDir);
  }

  pendingTasks(festivalDir: string): Promise<PendingTask[]> {
    return this.inner.pendingTasks(festivalDir);
  }

  watch(festivalDir: string, onEvent: (event: ProgressEvent) => void): () => void {
    return this.inner.watch(festivalDir, onEvent);
  }
}
