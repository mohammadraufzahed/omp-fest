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
import { claimedFestivalDir, resolveFestivalSelection } from "../src/application/fest-resolve.js";
import { claimFestivalOwnership } from "../src/application/festival-ownership.js";
import { joinFestivalTeam } from "../src/application/festival-team.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import {
  FESTIVAL_CLAIM_ENTRY,
  claimDataFromBranch,
  restoreClaimFromBranch,
} from "../src/application/session-claim.js";


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

async function selectFestival(root: string, dir: string, sessionId: string, tracker: LoopTracker): Promise<void> {
  const ownership = await claimFestivalOwnership(dir, sessionId);
  if (ownership.kind !== "claimed") throw new Error(`Cannot select test festival: ${ownership.kind}`);
  await joinFestivalTeam(root, dir, sessionId, sessionId);
  tracker.claimFestival(sessionId, dir);
}


describe("session festival claim", () => {
  it("pins each session to its own explicitly selected festival without cross-talk", async () => {
    const root = await makeCamp();
    const festivalA = await makeFestival(root, "fest-a", "01_task-a.md");
    const festivalB = await makeFestival(root, "fest-b", "01_task-b.md");
    const tracker = new LoopTracker(), detect = new CampFsDetect();
    await selectFestival(root, festivalB, "s1", tracker);
    await selectFestival(root, festivalA, "s2", tracker);
    expect(await claimedFestivalDir(tracker, detect, "s1", root)).toBe(festivalB);
    expect(await claimedFestivalDir(tracker, detect, "s2", root)).toBe(festivalA);
    expect(await claimedFestivalDir(tracker, detect, "fresh", root)).toBeUndefined();
    expect(tracker.claimedFestivalIdFor("fresh")).toBeUndefined();
  });

  it("keeps a new session unselected until it explicitly chooses a festival", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    const tracker = new LoopTracker();
    expect(await claimedFestivalDir(tracker, new CampFsDetect(), "fresh", root)).toBeUndefined();
    expect(tracker.claimedFestivalIdFor("fresh")).toBeUndefined();
  });

  it("keeps the claim live across a promote-style status-dir rename", async () => {
    const root = await makeCamp();
    await makeFestival(root, "fest-a", "01_task-a.md");
    const oldDir = await makeFestival(root, "fest-b", "01_task-b.md");
    const tracker = new LoopTracker(), detect = new CampFsDetect();
    await selectFestival(root, oldDir, "s1", tracker);
    await mkdir(join(root, "festivals", "ready"), { recursive: true });
    const newDir = join(root, "festivals", "ready", "fest-b");
    await rename(oldDir, newDir);
    expect(await claimedFestivalDir(tracker, detect, "s1", root)).toBe(newDir);
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

  it("centralizes explicit selector, session claim, role, pending, and owner-race metadata", () => {
    const festival = { id: "alpha", name: "Alpha", status: "active", path: "/camp/alpha" };
    const second = { ...festival, id: "alphabet", name: "Alphabet", path: "/camp/alphabet" };
    expect(resolveFestivalSelection([festival, second], { selector: "alph", sessionId: "s" })).toMatchObject({
      kind: "ambiguous", source: "explicit-selector",
    });
    expect(resolveFestivalSelection([festival], { sessionId: "s" })).toEqual({ kind: "unselected", source: "session-claim" });
    expect(resolveFestivalSelection([festival], { selector: "alpha", sessionId: "s", pendingCreationIds: ["alpha"] }))
      .toMatchObject({ kind: "pending-creation", source: "explicit-selector" });
    expect(resolveFestivalSelection([festival], {
      claimedFestival: festival, sessionId: "s", ownershipAttempt: { kind: "owned", owner: { sessionId: "other", claimedAt: "t" } },
    })).toMatchObject({ kind: "resolved", source: "session-claim", ownership: "collaborator" });
    expect(resolveFestivalSelection([festival], {
      selector: "alpha", sessionId: "s", ownershipAttempt: { kind: "changed", owner: { sessionId: "other", claimedAt: "t" } },
    })).toMatchObject({ kind: "resolved", ownership: "changed" });
    expect(resolveFestivalSelection([festival], {
      selector: "alpha", sessionId: "s", ownershipAttempt: { kind: "busy" },
    })).toMatchObject({ kind: "resolved", ownership: "busy" });
    const branch = [{ type: "custom", customType: FESTIVAL_CLAIM_ENTRY, data: { festivalId: "alpha", source: "explicit-selector" } }];
    expect(claimDataFromBranch(branch)).toMatchObject({ festivalId: "alpha", source: "explicit-selector" });
  });
});
