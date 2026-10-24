import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginFestivalCreation, completeFestivalCreation, listFestivalCreationOrphans, listQuarantinedFestivals, quarantineFestival, restoreQuarantinedFestival, recordFestivalCreation, rollbackFestivalCreation } from "../src/application/festival-creation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const camp = await mkdtemp(join(tmpdir(), "festival-creation-")); roots.push(camp);
  await mkdir(join(camp, "festivals", "planning"), { recursive: true });
  return { camp, planning: join(camp, "festivals", "planning") };
}
async function creation(camp: string, name = "new-festival") {
  return beginFestivalCreation(camp, name, `.ompfest/plans/${name}.STRUCTURE.md`, "session-1");
}

describe("festival creation lifecycle", () => {
  it("journals scaffolding, records marker, lists it, and completes cleanly", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), festival = join(planning, receipt.name);
    expect(JSON.parse(await readFile(receipt.journalPath, "utf8"))).toMatchObject({ id: receipt.id, state: "scaffolding" });
    await mkdir(festival); await recordFestivalCreation(receipt, festival);
    await mkdir(join(camp, ".ompfest", "plans"), { recursive: true });
    await writeFile(join(camp, receipt.planPath), "# Approved plan\n");
    await writeFile(join(camp, `${receipt.planPath}.status.json`), JSON.stringify({ state: "scaffolded", festivalDir: festival }));
    expect(JSON.parse(await readFile(join(festival, ".omp-fest-creation.json"), "utf8")) as unknown).toMatchObject({ id: receipt.id });
    expect(await listFestivalCreationOrphans(camp)).toEqual([{ receipt, festivalDir: festival }]);
    await completeFestivalCreation(receipt);
    expect(await readdir(festival)).toEqual([]);
    expect(await listFestivalCreationOrphans(camp)).toEqual([]);
  });

  it("refuses to finalize a scaffold when its transaction marker no longer matches", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), festival = join(planning, receipt.name);
    await mkdir(festival); await recordFestivalCreation(receipt, festival);
    await mkdir(join(camp, ".ompfest", "plans"), { recursive: true });
    await writeFile(join(camp, receipt.planPath), "# Approved plan\n");
    await writeFile(join(camp, `${receipt.planPath}.status.json`), JSON.stringify({ state: "scaffolded", festivalDir: festival }));
    await writeFile(join(festival, ".omp-fest-creation.json"), JSON.stringify({ id: "different-transaction" }));
    await expect(completeFestivalCreation(receipt)).rejects.toThrow("marker no longer matches");
    expect(await readFile(receipt.journalPath, "utf8")).toBeTruthy();
    expect(await readFile(join(festival, ".omp-fest-creation.json"), "utf8")).toContain("different-transaction");
  });

  it("quarantines an owned failed scaffold, preserves every entry, permits retry, and restores", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), festival = join(planning, receipt.name);
    await mkdir(join(festival, "generated", "nested"), { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "id: generated\n");
    await writeFile(join(festival, "generated", "nested", "content.bin"), Buffer.from([0, 255, 1, 128]));
    await recordFestivalCreation(receipt, festival);
    await writeFile(join(festival, "user-notes.txt"), "keep exactly");
    expect(await rollbackFestivalCreation(receipt, festival)).toBeUndefined();
    expect(await readdir(planning)).toEqual([]);
    expect(await listFestivalCreationOrphans(camp)).toEqual([]);
    await expect(lstat(receipt.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
    const [archived] = await listQuarantinedFestivals(camp);
    expect(archived?.name).toBe(receipt.name);
    const archiveDir = join(camp, ".ompfest", "orphans", archived!.id);
    expect(await readFile(join(archiveDir, "fest.yaml"), "utf8")).toBe("id: generated\n");
    expect([...await readFile(join(archiveDir, "generated", "nested", "content.bin"))]).toEqual([0, 255, 1, 128]);
    expect(await readFile(join(archiveDir, "user-notes.txt"), "utf8")).toBe("keep exactly");
    const retry = await creation(camp, receipt.name);
    const restored = await restoreQuarantinedFestival(camp, archiveDir);
    expect(restored).toBe(festival);
    expect(await readFile(join(restored, "user-notes.txt"), "utf8")).toBe("keep exactly");
    await expect(rollbackFestivalCreation(retry, restored)).resolves.toMatchObject({ festivalDir: restored });
    expect(await readFile(join(restored, "fest.yaml"), "utf8")).toBe("id: generated\n");
    expect(await readFile(retry.journalPath, "utf8")).toBeTruthy();
  });

  it("preserves pre-existing and mismatched targets with journals retained", async () => {
    const { camp, planning } = await fixture(), preexisting = join(planning, "old");
    await mkdir(preexisting); await writeFile(join(preexisting, "keep.txt"), "pre-existing");
    const receipt = await creation(camp, "new-name");
    await expect(rollbackFestivalCreation(receipt, preexisting)).resolves.toMatchObject({ festivalDir: preexisting });
    expect(await readFile(join(preexisting, "keep.txt"), "utf8")).toBe("pre-existing");
    expect(await readFile(receipt.journalPath, "utf8")).toBeTruthy();
    const mismatched = join(planning, receipt.name);
    await mkdir(mismatched); await writeFile(join(mismatched, ".omp-fest-creation.json"), JSON.stringify({ id: "not-this-transaction" }));
    await expect(rollbackFestivalCreation(receipt, mismatched)).resolves.toMatchObject({ festivalDir: mismatched });
    expect(await readFile(join(mismatched, ".omp-fest-creation.json"), "utf8")).toContain("not-this-transaction");
    expect(await readFile(receipt.journalPath, "utf8")).toBeTruthy();
  });

  it("leaves target and journal inspectable when quarantine storage prevents the move", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), festival = join(planning, receipt.name);
    await mkdir(festival); await writeFile(join(festival, "keep.txt"), "inspect");
    await recordFestivalCreation(receipt, festival);
    await symlink(join(camp, "outside"), join(camp, ".ompfest", "orphans"));
    await mkdir(join(camp, "outside"));
    await expect(rollbackFestivalCreation(receipt, festival)).resolves.toMatchObject({ festivalDir: festival });
    expect(await readFile(join(festival, "keep.txt"), "utf8")).toBe("inspect");
    expect(await readFile(receipt.journalPath, "utf8")).toBeTruthy();
    expect(await listFestivalCreationOrphans(camp)).toHaveLength(1);
  });

  it("preserves a pre-existing directory even if asked to roll it back", async () => {
    const { camp, planning } = await fixture(), festival = join(planning, "old");
    await mkdir(festival); await writeFile(join(festival, "keep.txt"), "user data");
    const receipt = await creation(camp, "attempt");
    const orphan = await rollbackFestivalCreation(receipt, festival);
    expect(orphan?.festivalDir).toBe(festival);
    expect(await readFile(join(festival, "keep.txt"), "utf8")).toBe("user data");
    expect(await readFile(receipt.journalPath, "utf8")).toBeTruthy();
  });

  it("rejects invalid, out-of-root, and symlink targets", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), outside = join(camp, "outside");
    await mkdir(outside);
    await expect(recordFestivalCreation(receipt, outside)).rejects.toThrow();
    await expect(recordFestivalCreation(receipt, join(planning, "missing"))).rejects.toThrow();
    await symlink(outside, join(planning, "linked"));
    await expect(recordFestivalCreation(receipt, join(planning, "linked"))).rejects.toThrow();
    await writeFile(receipt.journalPath, "{}");
    await expect(listFestivalCreationOrphans(camp)).resolves.toEqual([]);
  });

  it("lists stale journals without treating ordinary unmarked festivals as rollback-safe", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), festival = join(planning, "unmarked");
    await mkdir(festival); await writeFile(join(festival, "important.txt"), "keep");
    expect(await listFestivalCreationOrphans(camp)).toEqual([{ receipt }]);
    const result = await rollbackFestivalCreation(receipt, festival);
    expect(result?.festivalDir).toBe(festival);
    expect(await readFile(join(festival, "important.txt"), "utf8")).toBe("keep");
    expect(await readFile(receipt.journalPath, "utf8")).toBeTruthy();
  });

  it("quarantines an unowned planning festival reversibly", async () => {
    const { camp, planning } = await fixture(), festival = join(planning, "old");
    await mkdir(festival); await writeFile(join(festival, "content.txt"), "preserve");
    const destination = await quarantineFestival(camp, festival);
    expect(destination).toContain(join(camp, ".ompfest", "orphans"));
    expect(await readFile(join(destination, "content.txt"), "utf8")).toBe("preserve");
    await expect(readFile(festival, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await restoreQuarantinedFestival(camp, destination)).toBe(festival);
    expect(await readFile(join(festival, "content.txt"), "utf8")).toBe("preserve");
  });

  it.each([".omp-fest-owner.json", "APPROVED_PLAN.json", ".omp-fest-creation.json"])("refuses to quarantine a festival with %s", async (file) => {
    const { camp, planning } = await fixture(), festival = join(planning, "protected");
    await mkdir(festival); await writeFile(join(festival, file), "{}");
    await expect(quarantineFestival(camp, festival)).rejects.toThrow();
    expect(await readFile(join(festival, file), "utf8")).toBe("{}");
  });

  it("refuses quarantine targets outside planning and symlinked targets", async () => {
    const { camp, planning } = await fixture(), outside = join(camp, "outside");
    await mkdir(outside); await mkdir(join(planning, "nested"), { recursive: true });
    await expect(quarantineFestival(camp, outside)).rejects.toThrow();
    await symlink(outside, join(planning, "link"));
    await expect(quarantineFestival(camp, join(planning, "link"))).rejects.toThrow();
  });
});
