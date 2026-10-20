import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { pageRevision, recordVisualEvidence, visualEvidenceStatus, type VisualEvidence } from "../src/application/visual-evidence.js";
import { installVisualReferences, prepareVisualReferences } from "../src/application/visual-references.js";
import { createVisualFixture, PAGE, TASK } from "./visual-fixture.js";

const VERIFIED: VisualEvidence = {
  page: "results", check: "AC-01", status: "verified", proof: "E2E search test passed; see test run log",
  route: "/results", viewport: "1280x800", state: "initial",
};

async function fixture() {
  const fixture = await createVisualFixture();
  await installVisualReferences(fixture.festival, await prepareVisualReferences(fixture.root, fixture.plan, fixture.referencesDir));
  return { ...fixture, detect: new CampFsDetect() };
}

describe("visual acceptance evidence", () => {
  it("requires evidence only for completed tasks and ties proof to the page revision", async () => {
    const { festival, taskPath, markDone, detect } = await fixture();
    expect((await visualEvidenceStatus(festival, detect)).issues).toEqual([]);
    await markDone();
    expect((await visualEvidenceStatus(festival, detect)).issues.join("\n")).toContain("Missing evidence for results/AC-01");
    const [record] = await recordVisualEvidence(festival, taskPath, TASK, [VERIFIED]);
    expect(record?.revision).toBe(await pageRevision(festival, "results"));
    expect((await visualEvidenceStatus(festival, detect)).verified).toHaveLength(1);
    await writeFile(join(festival, "references", "pages", "results", "PAGE.md"), PAGE.replace("Search works", "Search now debounces"));
    const stale = await visualEvidenceStatus(festival, detect);
    expect(stale.verified).toEqual([]);
    expect(stale.issues.join("\n")).toContain("Stale evidence for results/AC-01");
    expect((await detect.pendingTasks(festival))[0]?.done).toBe(true);
  });

  it("keeps untested checks visible and reports failed checks rather than counting them as verified", async () => {
    const { festival, taskPath, markDone, detect } = await fixture();
    await markDone();
    await recordVisualEvidence(festival, taskPath, TASK, [{ page: "results", check: "AC-01", status: "untested", proof: "Browser unavailable" }]);
    const pending = await visualEvidenceStatus(festival, detect);
    expect(pending.verified).toEqual([]);
    expect(pending.untested[0]?.proof).toBe("Browser unavailable");
    await recordVisualEvidence(festival, taskPath, TASK, [{ ...VERIFIED, status: "failed", proof: "Search did not filter results" }]);
    expect((await visualEvidenceStatus(festival, detect)).issues.join("\n")).toContain("Failed check results/AC-01");
  });

  it("rejects missing/extra checks, unknown IDs and verified claims without context", async () => {
    const { festival, taskPath } = await fixture();
    await expect(recordVisualEvidence(festival, taskPath, TASK, [])).rejects.toThrow("cover exactly");
    await expect(recordVisualEvidence(festival, taskPath, TASK, [{ ...VERIFIED, check: "AC-99" }])).rejects.toThrow("cover exactly");
    await expect(recordVisualEvidence(festival, taskPath, TASK, [{ ...VERIFIED, viewport: undefined }])).rejects.toThrow("route, viewport and state");
    await expect(recordVisualEvidence(festival, taskPath, TASK.replace("AC-01", "AC-99"), [{ ...VERIFIED, check: "AC-99" }])).rejects.toThrow("Unknown visual acceptance");
  });

  it("preserves independent workers' evidence when they complete concurrently", async () => {
    const { festival, taskPath, markDone, detect } = await fixture();
    const other = taskPath.replace("01_results.md", "02_results.md");
    await writeFile(join(festival, other), TASK);
    await markDone([taskPath, other]);
    await Promise.all([recordVisualEvidence(festival, taskPath, TASK, [VERIFIED]), recordVisualEvidence(festival, other, TASK, [VERIFIED])]);
    const status = await visualEvidenceStatus(festival, detect);
    expect(status.verified.map((entry) => entry.task).sort()).toEqual([taskPath, other].sort());
    expect(status.issues).toEqual([]);
  });

  it("rejects corrupt or symlinked verification stores", async () => {
    const { festival, root, detect } = await fixture();
    const file = join(festival, "references", "verification.json");
    await symlink(join(root, "private"), file);
    expect((await visualEvidenceStatus(festival, detect)).issues.join("\n")).toContain("regular file");
  });

  it("does not accept a tampered verified record with missing proof", async () => {
    const { festival, taskPath, detect } = await fixture();
    await recordVisualEvidence(festival, taskPath, TASK, [VERIFIED]);
    const file = join(festival, "references", "verification.json");
    const content = await readFile(file, "utf8");
    await writeFile(file, content.replace(VERIFIED.proof, ""));
    expect((await visualEvidenceStatus(festival, detect)).issues.join("\n")).toContain("Invalid visual verification file");
  });
});
