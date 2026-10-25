import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LockBusyError, processIsAlive, withStaleAwareLock } from "../src/application/fs-lock.js";
import { beginFestivalCreation, classifyCreationOrphan, clearCreationJournal, creationJournalMayBeLive, listFestivalCreationOrphans } from "../src/application/festival-creation.js";
import { claimFestivalOwnership, festivalOwner, touchFestivalOwnership } from "../src/application/festival-ownership.js";
import { createPlanDraft, deletePlanDraft, deletePlanDraftsForPlan, listPlanDrafts, sweepPlanDraftDebris } from "../src/application/plan-drafts.js";
import { expireStalePlanPreviews, listPlanPreviews } from "../src/application/plan-artifacts.js";
import { checkProjectConflicts, reserveProjectFiles, sweepProjectReservations } from "../src/application/project-conflicts.js";
import { reconcileCamp } from "../src/application/reconcile.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-reliability-"));
  roots.push(root);
  return root;
}

async function camp(): Promise<string> {
  const root = await fixture();
  await mkdir(join(root, "festivals", "planning"), { recursive: true });
  return root;
}

/** A pid that cannot be a live process on this host. */
function deadPid(): number {
  for (const candidate of [4_000_000, 3_000_000, 2_000_000]) {
    if (!processIsAlive(candidate)) return candidate;
  }
  throw new Error("Could not find a dead pid");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("crash-safe locks", () => {
  it("keeps a live foreign lock busy and releases its own", async () => {
    const root = await fixture();
    const lock = join(root, "held.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "other", pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() }));
    await expect(withStaleAwareLock(lock, async () => Promise.resolve("never"), { busyMs: 150, staleMs: 60_000 })).rejects.toBeInstanceOf(LockBusyError);
    // Our own acquisition still works once the foreign lock is gone.
    await rm(lock, { recursive: true });
    await expect(withStaleAwareLock(lock, async () => Promise.resolve("ran"), { busyMs: 150 })).resolves.toBe("ran");
  });

  it("reclaims a stale lock directory left by a killed process", async () => {
    const root = await fixture();
    const lock = join(root, "stale.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead", pid: deadPid(), host: hostname(), acquiredAt: new Date(0).toISOString() }));
    const past = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, past, past);
    await expect(withStaleAwareLock(lock, async () => Promise.resolve("reclaimed"), { busyMs: 500, staleMs: 60_000 })).resolves.toBe("reclaimed");
    // The lock is released after the action, not left behind again.
    await expect(readdir(root)).resolves.not.toContain("stale.lock");
  });

  it("reclaims a same-host lock whose recorded owner pid is dead", async () => {
    const root = await fixture();
    const lock = join(root, "dead-owner.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "dead", pid: deadPid(), host: hostname(), acquiredAt: new Date().toISOString() }));
    await expect(withStaleAwareLock(lock, async () => Promise.resolve("reclaimed"), { busyMs: 500, staleMs: 60_000 })).resolves.toBe("reclaimed");
  });

  it("rejects a lock path replaced by a symlink", async () => {
    const root = await fixture();
    const real = join(root, "real");
    await mkdir(real);
    await symlink(real, join(root, "link.lock"));
    await expect(withStaleAwareLock(join(root, "link.lock"), async () => Promise.resolve("never"), { busyMs: 100 })).rejects.toThrow(/unsafe/i);
  });
});

describe("creation journal recovery", () => {
  it("classifies orphans as resume, stale, or in_flight", () => {
    const fresh = { receipt: { id: "1", name: "f", planPath: "p", sessionId: "s", startedAt: new Date().toISOString(), journalPath: "j" } };
    const old = { receipt: { ...fresh.receipt, startedAt: new Date(Date.now() - 60 * 60_000).toISOString() } };
    expect(classifyCreationOrphan({ ...fresh, festivalDir: "dir" })).toBe("resume");
    expect(classifyCreationOrphan({ ...old, festivalDir: "dir" })).toBe("resume");
    expect(classifyCreationOrphan(fresh)).toBe("in_flight");
    expect(classifyCreationOrphan(old)).toBe("stale");
  });

  it("blocks a same-name retry while a journal is in flight, then auto-clears it once stale", async () => {
    const root = await camp();
    const plan = join(root, "plan.md");
    await writeFile(plan, "# plan\n");
    const first = await beginFestivalCreation(root, "retry-festival", plan, "session-1");
    await expect(beginFestivalCreation(root, "retry-festival", plan, "session-2")).rejects.toThrow("incomplete creation transaction");
    // Simulate the crashed scaffold aging past the stale window.
    const journal = JSON.parse(await readFile(first.journalPath, "utf8")) as { startedAt: string };
    journal.startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeFile(first.journalPath, JSON.stringify(journal));
    const retried = await beginFestivalCreation(root, "retry-festival", plan, "session-2");
    expect(retried.id).not.toBe(first.id);
    expect((await listFestivalCreationOrphans(root)).filter((orphan) => orphan.receipt.name === "retry-festival")).toHaveLength(1);
  });

  it("treats a journal whose recorded pid is dead as stale and lets retry through", async () => {
    const root = await camp();
    const plan = join(root, "plan.md");
    await writeFile(plan, "# plan\n");
    const first = await beginFestivalCreation(root, "dead-pid-festival", plan, "session-1");
    // Simulate a killed scaffold: fresh journal, but the owner pid no longer exists.
    const journal = JSON.parse(await readFile(first.journalPath, "utf8")) as Record<string, unknown>;
    journal.pid = deadPid();
    journal.host = hostname();
    await writeFile(first.journalPath, JSON.stringify(journal));
    const orphan = (await listFestivalCreationOrphans(root)).find((item) => item.receipt.name === "dead-pid-festival");
    expect(orphan).toBeDefined();
    expect(classifyCreationOrphan(orphan!)).toBe("stale");
    expect(creationJournalMayBeLive(orphan!, "session-2")).toBe(false);
    const retried = await beginFestivalCreation(root, "dead-pid-festival", plan, "session-2");
    expect(retried.id).not.toBe(first.id);
  });

  it("never lets a journal from the same session block its own retry", async () => {
    const root = await camp();
    const plan = join(root, "plan.md");
    await writeFile(plan, "# plan\n");
    const first = await beginFestivalCreation(root, "own-retry", plan, "session-1");
    const orphan = (await listFestivalCreationOrphans(root)).find((item) => item.receipt.name === "own-retry");
    expect(creationJournalMayBeLive(orphan!, "session-1")).toBe(false);
    const retried = await beginFestivalCreation(root, "own-retry", plan, "session-1");
    expect(retried.id).not.toBe(first.id);
  });

  it("still flags a fresh journal from a live foreign process as possibly live", async () => {
    const root = await camp();
    const plan = join(root, "plan.md");
    await writeFile(plan, "# plan\n");
    await beginFestivalCreation(root, "live-peer", plan, "session-1");
    const orphan = (await listFestivalCreationOrphans(root)).find((item) => item.receipt.name === "live-peer");
    // The journal records this process's pid — alive — so another session must not clear it.
    expect(creationJournalMayBeLive(orphan!, "session-2")).toBe(true);
    await expect(beginFestivalCreation(root, "live-peer", plan, "session-2")).rejects.toThrow("incomplete creation transaction");
  });

  it("clearCreationJournal removes the journal so retry proceeds", async () => {
    const root = await camp();
    const plan = join(root, "plan.md");
    await writeFile(plan, "# plan\n");
    await beginFestivalCreation(root, "clearable", plan, "session-1");
    const orphan = (await listFestivalCreationOrphans(root)).find((item) => item.receipt.name === "clearable");
    await clearCreationJournal(root, orphan!);
    expect((await listFestivalCreationOrphans(root)).filter((item) => item.receipt.name === "clearable")).toHaveLength(0);
    await expect(beginFestivalCreation(root, "clearable", plan, "session-2")).resolves.toBeDefined();
  });
});

describe("festival ownership liveness", () => {
  it("a dead owner never blocks the next claim", async () => {
    const festival = await fixture();
    await writeFile(join(festival, ".omp-fest-owner.json"), JSON.stringify({
      sessionId: "dead-session", claimedAt: new Date(Date.now() - 60_000).toISOString(),
      pid: deadPid(), host: hostname(), heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
    }));
    const claim = await claimFestivalOwnership(festival, "live-session");
    expect(claim.kind).toBe("claimed");
    expect(await festivalOwner(festival)).toMatchObject({ sessionId: "live-session" });
  });

  it("touch refreshes only the owning session's heartbeat", async () => {
    const festival = await fixture();
    await claimFestivalOwnership(festival, "owner-session");
    const before = (await festivalOwner(festival))!;
    await touchFestivalOwnership(festival, "other-session");
    expect((await festivalOwner(festival))?.heartbeatAt).toBe(before.heartbeatAt);
    await touchFestivalOwnership(festival, "owner-session");
    expect((await festivalOwner(festival))?.pid).toBe(process.pid);
  });
});

describe("plan lifecycle garbage collection", () => {
  it("deletes drafts and sweeps draft debris left by crashes", async () => {
    const root = await fixture();
    const draft = await createPlanDraft(root, { name: "gc-plan" });
    expect(await deletePlanDraft(root, draft.draftId)).toBe(true);
    expect(await listPlanDrafts(root)).toEqual([]);
    const plansDir = join(root, ".ompfest", "plans");
    await writeFile(join(plansDir, "stale.tmp"), "{}");
    await writeFile(join(plansDir, "fresh.tmp"), "{}");
    const past = new Date(Date.now() - 30 * 60_000);
    await utimes(join(plansDir, "stale.tmp"), past, past);
    expect(await sweepPlanDraftDebris(root)).toEqual(["stale.tmp"]);
    expect((await readdir(plansDir)).sort()).toEqual(["fresh.tmp"]);
  });

  it("deletePlanDraftsForPlan removes only matching drafts", async () => {
    const root = await fixture();
    const keep = await createPlanDraft(root, { name: "keep-plan" });
    await createPlanDraft(root, { name: "drop-plan" });
    await createPlanDraft(root, { name: "drop-plan" });
    expect((await deletePlanDraftsForPlan(root, "drop-plan"))).toHaveLength(2);
    expect((await listPlanDrafts(root)).map((draft) => draft.draftId)).toEqual([keep.draftId]);
  });

  it("lists preview tombstones and expires stale saved/approved previews", async () => {
    const root = await fixture();
    const plansDir = join(root, ".ompfest", "plans");
    await mkdir(plansDir, { recursive: true });
    for (const [name, state] of [["old-saved", "saved_preview"], ["fresh-saved", "saved_preview"], ["done", "scaffolded"]] as const) {
      await writeFile(join(plansDir, `${name}.STRUCTURE.md.status.json`), JSON.stringify({ state }));
    }
    const past = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(join(plansDir, "old-saved.STRUCTURE.md.status.json"), past, past);
    expect((await listPlanPreviews(root)).map((preview) => preview.state).sort()).toEqual(["saved_preview", "saved_preview", "scaffolded"]);
    expect(await expireStalePlanPreviews(root)).toEqual(["old-saved"]);
    const states = (await listPlanPreviews(root)).map((preview) => `${preview.name}:${preview.state}`).sort();
    expect(states).toEqual(["done:scaffolded", "fresh-saved:saved_preview", "old-saved:expired"]);
  });
});

describe("reservation liveness", () => {
  it("sweeps reservation rows whose owner pid is dead", async () => {
    const project = await fixture();
    await mkdir(join(project, ".git"));
    await reserveProjectFiles(project, { sessionId: "dead", assignmentId: "a", files: ["src/f.ts"] });
    const registryPath = join(project, ".git", "omp-fest", ".omp-fest-reservations.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { reservations: { pid?: number; host?: string }[] };
    registry.reservations[0]!.pid = deadPid();
    registry.reservations[0]!.host = hostname();
    await writeFile(registryPath, JSON.stringify(registry));
    expect(await sweepProjectReservations(project)).toBe(1);
    expect((await checkProjectConflicts(project, ["src/f.ts"])).kind).toBe("clear");
  });
});

describe("startup reconcile", () => {
  it("cleans plan debris, stale journals, and dead reservations in one pass", async () => {
    const root = await camp();
    const project = join(root, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    // Debris + a stale journal + a dead reservation.
    const plansDir = join(root, ".ompfest", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(join(plansDir, "junk.tmp"), "{}");
    const past = new Date(Date.now() - 30 * 60_000);
    await utimes(join(plansDir, "junk.tmp"), past, past);
    const plan = join(root, "plan.md");
    await writeFile(plan, "# plan\n");
    const receipt = await beginFestivalCreation(root, "crashed", plan, "session-1");
    const journal = JSON.parse(await readFile(receipt.journalPath, "utf8")) as { startedAt: string };
    journal.startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    await writeFile(receipt.journalPath, JSON.stringify(journal));
    await reserveProjectFiles(project, { sessionId: "dead", assignmentId: "a", files: ["f.ts"] });
    const registryPath = join(project, ".git", "omp-fest", ".omp-fest-reservations.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as { reservations: { pid?: number; host?: string }[] };
    registry.reservations[0]!.pid = deadPid();
    registry.reservations[0]!.host = hostname();
    await writeFile(registryPath, JSON.stringify(registry));

    const summary = await reconcileCamp(root, async () => Promise.resolve([project]));
    expect(summary.errors).toEqual([]);
    expect(summary.planDebris).toBe(1);
    expect(summary.clearedJournals).toBe(1);
    expect(summary.sweptReservations).toBe(1);
    expect(summary.total).toBe(3);
  });
});
