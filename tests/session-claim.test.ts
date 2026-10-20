/**
 * Session festival claims: the resolution path that lets two agents in one
 * camp work two different festivals. Covers the claim sticking across calls,
 * surviving a promote-style rename, persisting via appendEntry, and restoring
 * from a transcript branch — all through the real CampFsDetect on a real
 * camp layout, with only the CLIs faked.
 */
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { registerTools, type PiLike } from "../src/adapters/omp/tools.js";
import { claimedFestivalDir } from "../src/application/fest-resolve.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import {
  FESTIVAL_CLAIM_ENTRY,
  restoreClaimFromBranch,
} from "../src/application/session-claim.js";
import type { CampCli, FestCli } from "../src/ports.js";

interface ToolResultShape {
  content: { type: string; text: string }[];
}

type ToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<ToolResultShape>;

const schema = (): { optional(): unknown; describe(): unknown } => ({
  optional: schema,
  describe: schema,
});

function makePi() {
  const tools = new Map<string, { execute: ToolExecute }>();
  const appended: { customType: string; data: unknown }[] = [];
  const pi: PiLike = {
    zod: {
      object: schema,
      string: schema,
      boolean: schema,
      enum: schema,
      array: schema,
    } as never,
    registerTool: (tool) => {
      tools.set(tool.name as string, tool as { execute: ToolExecute });
    },
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
    },
  };
  return { pi, tools, appended };
}

function ctxFor(cwd: string, sessionId: string) {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

async function makeCamp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-claim-"));
  await mkdir(join(root, "festivals", "active"), { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  return root;
}

async function makeFestival(root: string, id: string, taskFile: string, status = "active"): Promise<string> {
  const dir = join(root, "festivals", status, id);
  await mkdir(join(dir, "001_IMPLEMENT", "01_seq"), { recursive: true });
  await writeFile(join(dir, "fest.yaml"), `id: ${id}\n`);
  await writeFile(join(dir, "001_IMPLEMENT", "01_seq", taskFile), "# task\n");
  return dir;
}

function laneTasks(result: ToolResultShape): string[] {
  const parsed = JSON.parse(result.content[0]?.text ?? "{}") as {
    lanes?: { tasks: string[] }[];
  };
  return (parsed.lanes ?? []).flatMap((lane) => lane.tasks);
}

describe("session festival claim", () => {
  it("pins each session to its own festival — no cross-talk between agents", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    await makeFestival(root, "fest-b", "01_task-b.md");
    const tracker = new LoopTracker();
    const { pi, tools } = makePi();
    registerTools(pi, {
      fest: {} as FestCli,
      camp: {} as CampCli,
      detect: new CampFsDetect(),
      tracker,
    });
    const parallel = tools.get("fest_parallel")?.execute;
    const s1 = ctxFor(root, "s1");
    const s2 = ctxFor(root, "s2");

    // s1 picks fest-b, s2 picks fest-a.
    const picked = await parallel?.("t", { festival: "fest-b" }, undefined, undefined, s1);
    expect(laneTasks(picked!)).toEqual(["001_IMPLEMENT/01_seq/01_task-b.md"]);
    await parallel?.("t", { festival: "fest-a" }, undefined, undefined, s2);

    // The next selector-less call on s1 must still target fest-b — before the
    // fix it re-resolved to the camp-wide pick (fest-a, first alphabetically).
    const s1Again = await parallel?.("t", {}, undefined, undefined, s1);
    expect(laneTasks(s1Again!)).toEqual(["001_IMPLEMENT/01_seq/01_task-b.md"]);
    const s2Again = await parallel?.("t", {}, undefined, undefined, s2);
    expect(laneTasks(s2Again!)).toEqual(["001_IMPLEMENT/01_seq/01_task-a.md"]);
  });

  it("defaults to the camp-wide pick only while the session has no claim", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    const tracker = new LoopTracker();
    const { pi, tools } = makePi();
    registerTools(pi, {
      fest: {} as FestCli,
      camp: {} as CampCli,
      detect: new CampFsDetect(),
      tracker,
    });
    const parallel = tools.get("fest_parallel")?.execute;
    const fresh = await parallel?.("t", {}, undefined, undefined, ctxFor(root, "fresh"));
    expect(laneTasks(fresh!)).toEqual(["001_IMPLEMENT/01_seq/01_task-a.md"]);
  });

  it("keeps the claim live across a promote-style status-dir rename", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    const oldDir = await makeFestival(root, "fest-b", "01_task-b.md");
    const tracker = new LoopTracker();
    const { pi, tools } = makePi();
    const detect = new CampFsDetect();
    registerTools(pi, { fest: {} as FestCli, camp: {} as CampCli, detect, tracker });
    const parallel = tools.get("fest_parallel")?.execute;
    const s1 = ctxFor(root, "s1");
    await parallel?.("t", { festival: "fest-b" }, undefined, undefined, s1);

    // `fest promote` moves festivals/<status>/<id> — the stored dir goes stale.
    await mkdir(join(root, "festivals", "ready"), { recursive: true });
    const newDir = join(root, "festivals", "ready", "fest-b");
    await rename(oldDir, newDir);

    const after = await parallel?.("t", {}, undefined, undefined, s1);
    expect(laneTasks(after!)).toEqual(["001_IMPLEMENT/01_seq/01_task-b.md"]);
    expect(tracker.festivalFor("s1")).toBe(newDir);
  });

  it("drops the claim when the festival is gone entirely", async () => {
    const root = await makeCamp();
    const dir = await makeFestival(root, "fest-b", "01_task-b.md");
    const tracker = new LoopTracker();
    const detect = new CampFsDetect();
    tracker.claimFestival("s1", dir);
    await rm(dir, { recursive: true });
    expect(await claimedFestivalDir(tracker, detect, "s1", root)).toBeUndefined();
    expect(tracker.claimedFestivalIdFor("s1")).toBeUndefined();
  });

  it("appends one transcript entry per claim change, none for repeats", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    const bDir = await makeFestival(root, "fest-b", "01_task-b.md");
    const tracker = new LoopTracker();
    const { pi, tools, appended } = makePi();
    registerTools(pi, {
      fest: {} as FestCli,
      camp: {} as CampCli,
      detect: new CampFsDetect(),
      tracker,
    });
    const parallel = tools.get("fest_parallel")?.execute;
    const s1 = ctxFor(root, "s1");

    await parallel?.("t", { festival: "fest-b" }, undefined, undefined, s1);
    await parallel?.("t", {}, undefined, undefined, s1);
    const claims = appended.filter((e) => e.customType === FESTIVAL_CLAIM_ENTRY);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.data).toMatchObject({ festivalId: "fest-b", festivalDir: bDir, campRoot: root });
  });

  it("restores a claimed festival from the transcript branch, stale dir and all", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    const bDir = await makeFestival(root, "fest-b", "01_task-b.md", "ready");
    const tracker = new LoopTracker();
    const detect = new CampFsDetect();
    const branch = [
      { type: "custom", customType: FESTIVAL_CLAIM_ENTRY, data: { festivalId: "fest-b", festivalDir: "/moved/away/fest-b" } },
      { type: "message", message: { role: "user" } },
    ];
    expect(restoreClaimFromBranch(tracker, "s9", branch)).toBe("fest-b");
    expect(await claimedFestivalDir(tracker, detect, "s9", root)).toBe(bDir);
    expect(tracker.festivalFor("s9")).toBe(bDir);
  });

  it("ignores foreign custom entries on the branch", () => {
    const tracker = new LoopTracker();
    const branch = [
      { type: "custom", customType: "com.other.state", data: { festivalId: "fest-x" } },
      { type: "custom", customType: FESTIVAL_CLAIM_ENTRY, data: {} },
    ];
    expect(restoreClaimFromBranch(tracker, "s1", branch)).toBeUndefined();
    expect(tracker.claimedFestivalIdFor("s1")).toBeUndefined();
  });
});
