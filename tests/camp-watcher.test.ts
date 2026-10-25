import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { CachedDetect } from "../src/application/detect-cache.js";
import { diffSnapshots, snapshotCamp, watchCampTransitions } from "../src/application/camp-watcher.js";

class ObservedDetect extends CampFsDetect {
  reads = 0;

  override async listFestivals(root: string) {
    const festivals = await super.listFestivals(root);
    this.reads += 1;
    return festivals;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ompfest-watcher-"));
  const festival = join(root, "festivals", "active", "demo-F1");
  await mkdir(festival, { recursive: true });
  await mkdir(join(root, ".campaign"));
  await writeFile(join(festival, "fest.yaml"), "version: '1.0'\n");
  return { root, festival };
}

describe("camp lifecycle watcher", () => {
  it("reports a terminal native move as completion, not disappearance, despite cached reads", async () => {
    const { root, festival } = await fixture();
    try {
      const detect = new CachedDetect(new CampFsDetect(), 60_000);
      const before = await snapshotCamp(detect, root);
      const bucket = join(root, "festivals", "dungeon", "completed", "2026-10-25");
      await mkdir(bucket, { recursive: true });
      await rename(festival, join(bucket, "demo-F1"));
      const after = await snapshotCamp(detect, root);
      expect(diffSnapshots(before, after)).toEqual(["festival demo-F1: active → completed"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("watches newly created terminal containers and later moves within date buckets", async () => {
    const { root, festival } = await fixture();
    const detect = new ObservedDetect();
    const messages: string[] = [];
    const stop = watchCampTransitions(detect, root, (changes) => messages.push(...changes));
    try {
      await vi.waitFor(() => { expect(detect.reads).toBeGreaterThan(0); });
      const bucket = join(root, "festivals", "dungeon", "completed", "2026-10-25");
      const before = detect.reads;
      await mkdir(bucket, { recursive: true });
      await vi.waitFor(() => { expect(detect.reads).toBeGreaterThan(before); });
      await rename(festival, join(bucket, "demo-F1"));
      await vi.waitFor(() => { expect(messages).toContain("festival demo-F1: active → completed"); });
      const another = join(root, "festivals", "active", "second-F2");
      await mkdir(another);
      await writeFile(join(another, "fest.yaml"), "version: '1.0'\n");
      await vi.waitFor(() => { expect(messages).toContain("festival second-F2 appeared (active)"); });
      await rename(another, join(bucket, "second-F2"));
      await vi.waitFor(() => { expect(messages).toContain("festival second-F2: active → completed"); });
      expect(messages.some((message) => message.includes("disappeared"))).toBe(false);
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
