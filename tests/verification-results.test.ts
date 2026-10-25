import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeEvidenceBundle } from "../src/application/evidence-bundles.js";
import { recordVerificationResult, verificationRequirements, verificationResultStatus } from "../src/application/verification-results.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "verification-result-")); roots.push(root);
  const festival = join(root, "festivals", "active", "feature-FE0001");
  await mkdir(festival, { recursive: true });
  await mkdir(join(root, "projects", "app"), { recursive: true });
  await writeFile(join(root, "projects", "app", "feature.js"), "export const state = 1;\n");
  const checks = [
    { id: "syntax", kind: "command", command: "node --check feature.js", cwd: ".", provenancePath: "feature.js", expected: "The source parses" },
    { id: "interaction", kind: "browser", procedure: "Open / and type a query, verify suggestions", expected: "Matching suggestions are selectable" },
    { id: "review", kind: "research", procedure: "Compare findings to linked requirements", expected: "Findings cite requirements and limitations" },
  ];
  await writeFile(join(festival, "APPROVED_PLAN.json"), JSON.stringify({ name: "feature", workingDir: "projects/app", spec: { phases: [{ sequences: [{ tasks: [{ id: "implement", files: [{ path: "feature.js", status: "existing" }], verification: checks }] }] }] } }));
  return { root, festival };
}
describe("actual verification evidence", () => {
  it("does not treat planned provenance as execution evidence", async () => {
    const { festival } = await fixture();
    const status = await verificationResultStatus(festival, "implement");
    expect(status.valid).toBe(false);
    expect(status.missingRequirements).toEqual([
      { task: "implement", check: "syntax", status: "missing", expected: "The source parses" },
      { task: "implement", check: "interaction", status: "missing", expected: "Matching suggestions are selectable" },
      { task: "implement", check: "review", status: "missing", expected: "Findings cite requirements and limitations" },
    ]);
    expect((await verificationRequirements(festival))[0]?.provenancePath).toBe("feature.js");
  });
  it("requires matching command output and invalidates results when source changes", async () => {
    const { root, festival } = await fixture();
    const bundle = await storeEvidenceBundle(festival, { kind: "worker", summary: "Syntax check", details: "node --check feature.js exited 0, no diagnostics" });
    await expect(recordVerificationResult(festival, { task: "implement", check: "syntax", status: "verified", proof: "Exited zero", tool: "bash", command: "node --check feature.js", exitCode: 1, evidenceId: bundle.id })).rejects.toThrow("observed exitCode:0");
    await recordVerificationResult(festival, { task: "implement", check: "syntax", status: "verified", proof: "Exited zero with no diagnostics", tool: "bash", command: "node --check feature.js", exitCode: 0, evidenceId: bundle.id });
    expect((await verificationResultStatus(festival)).checks.find((check) => check.check === "syntax")?.status).toBe("verified");
    await writeFile(join(root, "projects", "app", "feature.js"), "export const state = 2;\n");
    expect((await verificationResultStatus(festival)).checks.find((check) => check.check === "syntax")?.status).toBe("stale");
  });
  it("retains browser limitations instead of converting them into passing checks", async () => {
    const { festival } = await fixture();
    await recordVerificationResult(festival, { task: "implement", check: "interaction", status: "untested", proof: "Browser tool unavailable; interactions not exercised" });
    const status = await verificationResultStatus(festival);
    expect(status.valid).toBe(false);
    expect(status.checks.find((check) => check.check === "interaction")?.status).toBe("untested");
    const bundle = await storeEvidenceBundle(festival, { kind: "visual", summary: "Observed suggestions", details: "Opened / at 1280x800; typed query; selected matching suggestion" });
    await expect(recordVerificationResult(festival, { task: "implement", check: "interaction", status: "verified", proof: "Observed selection", tool: "Playwright", evidenceId: bundle.id })).rejects.toThrow("route, viewport, state");
    await recordVerificationResult(festival, { task: "implement", check: "interaction", status: "verified", proof: "Typed query and selected matching suggestion", tool: "Playwright", route: "/", viewport: "1280x800", state: "typed query", evidenceId: bundle.id });
    expect((await verificationResultStatus(festival)).checks.find((check) => check.check === "interaction")?.status).toBe("verified");
  });
});
