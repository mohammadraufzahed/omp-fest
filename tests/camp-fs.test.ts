import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";

async function makeCamp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-"));
  await mkdir(join(root, "festivals", "active", "x-F1", ".fest"), { recursive: true });
  await mkdir(join(root, ".campaign"), { recursive: true });
  await mkdir(join(root, "projects", "app"), { recursive: true });
  await writeFile(join(root, "festivals", "active", "x-F1", "fest.yaml"), "a: 1\n");
  await writeFile(
    join(root, "festivals", "active", "x-F1", ".fest", "progress_events.jsonl"),
    '{"ts":"t","event":"wf_init","phase":"001","total_steps":3}\n',
  );
  return root;
}

describe("CampFsDetect", () => {
  it("classifies camp root", async () => {
    const root = await makeCamp();
    const location = await new CampFsDetect().locate(root);
    expect(location.kind).toBe("camp-root");
    expect(location.campName).toBeTruthy();
  });

  it("classifies a linked project dir", async () => {
    const root = await makeCamp();
    const location = await new CampFsDetect().locate(join(root, "projects", "app"));
    expect(location.kind).toBe("project");
    expect(location.campRoot).toBe(root);
  });

  it("classifies inside a festival and finds camp root", async () => {
    const root = await makeCamp();
    const location = await new CampFsDetect().locate(join(root, "festivals", "active", "x-F1"));
    expect(location.kind).toBe("festival");
    expect(location.festivalId).toBe("x-F1");
    expect(location.campRoot).toBe(root);
  });

  it("finds the active festival and reads progress events", async () => {
    const root = await makeCamp();
    const detect = new CampFsDetect();
    const dir = await detect.activeFestival(root);
    expect(dir).toContain("x-F1");
    const events = await detect.readProgress(dir!);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("wf_init");
  });

  it("returns outside for unrelated dirs", async () => {
    const location = await new CampFsDetect().locate("/");
    expect(location.kind).toBe("outside");
  });
});

it("pendingTasks groups tasks by sequence and marks completed ones done", async () => {
  const root = await mkdtemp(join(tmpdir(), "campfs-fest-"));
  const dir = join(root, "festival-x");
  await mkdir(join(dir, "003_IMPLEMENT/01_core"), { recursive: true });
  await mkdir(join(dir, "003_IMPLEMENT/02_extra"), { recursive: true });
  await mkdir(join(dir, ".fest"), { recursive: true });
  await writeFile(join(dir, "003_IMPLEMENT/01_core/01_a.md"), "task a");
  await writeFile(join(dir, "003_IMPLEMENT/01_core/02_b.md"), "task b");
  await writeFile(join(dir, "003_IMPLEMENT/02_extra/01_c.md"), "task c");
  await writeFile(
    join(dir, ".fest/progress_events.jsonl"),
    `${JSON.stringify({ ts: "2026-01-01T00:00:00Z", event: "completed", task: "003_IMPLEMENT/01_core/01_a.md" })}\n`,
  );
  const tasks = await new CampFsDetect().pendingTasks(dir);
  expect(tasks).toHaveLength(3);
  expect(tasks.find((t) => t.path.endsWith("01_a.md"))?.done).toBe(true);
  expect(tasks.find((t) => t.path.endsWith("02_b.md"))?.done).toBe(false);
  expect(new Set(tasks.map((t) => t.sequence)).size).toBe(2);
});
