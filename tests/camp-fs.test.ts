import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { festivalCampRoot, isCompletedFestivalPath, lifecycleStatus } from "../src/domain/festival-lifecycle.js";

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

it("activeFestival prefers the active festival over planning/parked ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "campfs-prio-"));
  for (const status of ["planning", "active", "parked"]) {
    await mkdir(join(root, "festivals", status, `f-${status}`), { recursive: true });
    await writeFile(join(root, "festivals", status, `f-${status}`, "fest.yaml"), "a: 1\n");
  }
  const dir = await new CampFsDetect().activeFestival(root);
  expect(dir).toContain("f-active");
});

it("pendingTasks skips quality-gate files (fest_type: gate)", async () => {
  const root = await mkdtemp(join(tmpdir(), "campfs-gates-"));
  const dir = join(root, "festival-x");
  await mkdir(join(dir, "003_IMPLEMENT/01_core"), { recursive: true });
  await writeFile(join(dir, "003_IMPLEMENT/01_core/01_design.md"), "fest_type: task\nbody");
  await writeFile(join(dir, "003_IMPLEMENT/01_core/02_implement.md"), "fest_type: task\nbody");
  await writeFile(join(dir, "003_IMPLEMENT/01_core/03_testing.md"), "fest_type: gate\nbody");
  await writeFile(join(dir, "003_IMPLEMENT/01_core/06_fest_commit.md"), "fest_type: gate\nbody");
  const tasks = await new CampFsDetect().pendingTasks(dir);
  expect(tasks.map((t) => t.path)).toEqual([
    "003_IMPLEMENT/01_core/01_design.md",
    "003_IMPLEMENT/01_core/02_implement.md",
  ]);
});

it("replays completed then reset or blocked as unfinished tasks", async () => {
  const root = await makeCamp();
  const dir = join(root, "festivals", "active", "x-F1");
  const task = "001_IMPLEMENT/01_core/01_task.md";
  await mkdir(join(dir, "001_IMPLEMENT", "01_core"), { recursive: true });
  await writeFile(join(dir, task), "fest_type: task\n");
  for (const final of ["reset", "blocked", "progress"]) {
    await writeFile(join(dir, ".fest", "progress_events.jsonl"), ["completed", final]
      .map((event) => JSON.stringify({ ts: "t", event, task })).join("\n"));
    expect((await new CampFsDetect().pendingTasks(dir))[0]?.done).toBe(false);
  }
});

it("discovers moved completed sequences and applies events from their old paths", async () => {
  const root = await makeCamp();
  const dir = join(root, "festivals", "active", "x-F1");
  const moved = "001_IMPLEMENT/completed/01_core/01_task.md";
  await mkdir(join(dir, "001_IMPLEMENT", "completed", "01_core"), { recursive: true });
  await writeFile(join(dir, moved), "fest_type: task\n");
  await writeFile(join(dir, ".fest", "progress_events.jsonl"), JSON.stringify({
    ts: "t", event: "completed", task: "001_IMPLEMENT/01_core/01_task.md",
  }));
  expect(await new CampFsDetect().pendingTasks(dir)).toEqual([
    { path: moved, sequence: "001_IMPLEMENT/01_core", done: true },
  ]);
});

it("includes tasks in completed phase subtrees without assuming they are done", async () => {
  const root = await makeCamp();
  const dir = join(root, "festivals", "active", "x-F1");
  const path = "completed/001_IMPLEMENT/01_core/01_task.md";
  await mkdir(join(dir, "completed", "001_IMPLEMENT", "01_core"), { recursive: true });
  await writeFile(join(dir, path), "fest_type: task\n");
  expect(await new CampFsDetect().pendingTasks(dir)).toEqual([
    { path, sequence: "001_IMPLEMENT/01_core", done: false },
  ]);
});

it("discovers native terminal lifecycle date buckets without scanning unrelated folders", async () => {
  const root = await makeCamp();
  const detect = new CampFsDetect();
  for (const status of ["completed", "archived", "someday"]) {
    const dir = join(root, "festivals", "dungeon", status, "2026-10-25", `f-${status}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "fest.yaml"), "version: '1.0'\n");
    expect(await detect.locate(dir)).toMatchObject({ kind: "festival", campRoot: root, festivalId: `f-${status}` });
  }
  const unrelated = join(root, "festivals", "dungeon", "completed", "unrelated", "hidden-festival");
  await mkdir(unrelated, { recursive: true });
  await writeFile(join(unrelated, "fest.yaml"), "version: '1.0'\n");
  const listed = await detect.listFestivals(root);
  expect(listed.map((festival) => festival.id).sort()).toEqual(["f-archived", "f-completed", "f-someday", "x-F1"]);
  expect(listed.find((festival) => festival.id === "f-completed")?.status).toBe("completed");
});

it("tries every live entry rather than stopping at a non-festival file", async () => {
  const root = await makeCamp();
  await writeFile(join(root, "festivals", "active", "00_readme.txt"), "not a festival");
  expect(await new CampFsDetect().activeFestival(root)).toBe(join(root, "festivals", "active", "x-F1"));
});

it("does not classify a projects-prefixed unrelated folder as a linked project", async () => {
  const root = await makeCamp();
  await mkdir(join(root, "projects-unrelated"));
  expect((await new CampFsDetect().locate(join(root, "projects-unrelated"))).kind).toBe("camp-root");
});

it("resolves lifecycle helpers only for festival root paths", () => {
  const path = "/camp/festivals/dungeon/completed/2026-10-25/demo-F1";
  expect(lifecycleStatus(path)).toBe("completed");
  expect(isCompletedFestivalPath(path)).toBe(true);
  expect(festivalCampRoot(path)).toBe("/camp");
  expect(lifecycleStatus("/camp/festivals/dungeon/archived/demo-F1")).toBe("archived");
  expect(isCompletedFestivalPath("/camp/festivals/.dungeon/completed/2026-10-25/demo-F1")).toBe(true);
  expect(lifecycleStatus("/camp/festivals/completed/demo-F1")).toBe("completed");
  expect(lifecycleStatus("/camp/festivals/ritual/demo-F1")).toBe("ritual");
  expect(lifecycleStatus("/camp/festivals/dungeon/completed/2026-10-25/demo-F1/001_PHASE")).toBeUndefined();
  expect(isCompletedFestivalPath("/camp/completed/demo-F1")).toBe(false);
});
