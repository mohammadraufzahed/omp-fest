import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginFestivalCreation, completeFestivalCreation, listFestivalCreationOrphans, quarantineFestival, restoreQuarantinedFestival, recordFestivalCreation, rollbackFestivalCreation } from "../src/application/festival-creation.js";

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
    expect(JSON.parse(await readFile(join(festival, ".omp-fest-creation.json"), "utf8")) as unknown).toMatchObject({ id: receipt.id });
    expect(await listFestivalCreationOrphans(camp)).toEqual([{ receipt, festivalDir: festival }]);
    await completeFestivalCreation(receipt);
    expect(await readdir(festival)).toEqual([]);
    expect(await listFestivalCreationOrphans(camp)).toEqual([]);
  });

  it("rollback removes only the matching transaction's new festival", async () => {
    const { camp, planning } = await fixture(), receipt = await creation(camp), festival = join(planning, receipt.name);
    await mkdir(festival); await writeFile(join(festival, "content.txt"), "generated"); await recordFestivalCreation(receipt, festival);
    expect(await rollbackFestivalCreation(receipt, festival)).toBeUndefined();
    await expect(lstat(festival)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(receipt.journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
