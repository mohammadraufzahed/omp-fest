import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeEvidenceBundle, readEvidenceBundle } from "../src/application/evidence-bundles.js";
import { INTEGRATION_CHECKS, integrationReviewStatus, recordIntegrationReview, type IntegrationCheck } from "../src/application/integration-review.js";
import { executeRelease, previewRelease } from "../src/application/release-workflow.js";
import type { CampDetect, ExecRunner } from "../src/ports.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fest-quality-")); roots.push(root);
  await writeFile(join(root, "task.md"), "Approved task");
  const detect = { pendingTasks: () => Promise.resolve([{ path: "task.md", done: true, sequence: "core" }]) } as unknown as CampDetect;
  return { root, detect };
}

describe("quality evidence", () => {
  it("stores complete evidence privately and returns bounded summaries without losing details", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "capture.png"), "capture bytes");
    const details = "Real verification log\n".repeat(1000);
    const compact = await storeEvidenceBundle(root, { kind: "visual", summary: "Compared desktop modal", details, attachments: ["capture.png"] });
    expect(compact).not.toHaveProperty("details");
    const bundle = await readEvidenceBundle(root, compact.id);
    expect(bundle.details).toBe(details);
    expect(bundle.attachments[0]).toMatchObject({ path: "capture.png", bytes: 13 });
    await expect(storeEvidenceBundle(root, { kind: "worker", summary: "outside", details: "log", attachments: ["../outside"] })).rejects.toThrow();
    await mkdir(join(root, "unsafe"));
    await symlink(join(root, "unsafe"), join(root, ".ompfest", "evidence", "link"));
    await expect(readEvidenceBundle(root, "../../link")).rejects.toThrow("Invalid evidence id");
  });

  it("keeps untested distinct, rejects missing checks and invalidates changed task contracts", async () => {
    const { root, detect } = await fixture();
    expect((await integrationReviewStatus(root, detect)).status).toBe("missing");
    const checks: IntegrationCheck[] = INTEGRATION_CHECKS.map((id) => ({ id, status: "verified", proof: `Exercised ${id}` }));
    await expect(recordIntegrationReview(root, detect, { sessionId: "s", checks: checks.slice(1), comparisons: [], summary: "Incomplete", details: "Details" })).rejects.toThrow("cover exactly");
    const result = await recordIntegrationReview(root, detect, { sessionId: "s", checks: checks.map((check) => check.id === "responsive" ? { ...check, status: "untested", proof: "Viewport unavailable" } : check), comparisons: [], summary: "Review incomplete", details: "Desktop interaction exercise" });
    expect(result.status).toBe("untested");
    expect((await integrationReviewStatus(root, detect)).status).toBe("untested");
    await writeFile(join(root, "task.md"), "Changed approved task");
    expect((await integrationReviewStatus(root, detect)).status).toBe("stale");
  });

  it("never marks unresolved visual differences verified", async () => {
    const { root, detect } = await fixture();
    await expect(recordIntegrationReview(root, detect, {
      sessionId: "s", checks: INTEGRATION_CHECKS.map((id) => ({ id, status: "verified", proof: "Checked" })),
      summary: "Visual mismatch", details: "Comparison",
      comparisons: [{ page: "modal", route: "/modal", viewport: "1096x819", browserTool: "Playwright MCP", reference: "reference.png", capture: "actual.png", status: "verified", differences: ["Title wraps incorrectly"] }],
    })).rejects.toThrow("unresolved differences");
  });
});

describe("authorized release execution", () => {
  it("rejects stale approval and stops before commit/push when checks fail", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", scripts: { test: "node test.js" } }));
    const calls: string[] = [];
    const exec: ExecRunner = { run: (command, args) => {
      const call = `${command} ${args.join(" ")}`; calls.push(call);
      const stdout = args.includes("--show-prefix") ? "" : args[0] === "branch" ? "main\n" : args.includes("@{upstream}") ? "origin/main\n" : args[0] === "rev-parse" ? "head\n" : args[0] === "diff" ? "task.md\0" : "";
      return Promise.resolve({ code: command === "npm" && args[0] === "run" ? 1 : 0, stdout, stderr: "" });
    } };
    const preview = await previewRelease(root, "minor", exec);
    expect(preview.nextVersion).toBe("1.3.0");
    await writeFile(join(root, "task.md"), "Changed after review");
    await expect(executeRelease(preview, "minor", "release", exec)).rejects.toThrow("changed during approval");
    expect(calls.some((call) => call.startsWith("npm version"))).toBe(false);
    const fresh = await previewRelease(root, "minor", exec);
    const result = await executeRelease(fresh, "minor", "release", exec);
    expect(result.status).toBe("failed");
    expect(calls).toContain("npm version 1.3.0 --no-git-tag-version --ignore-scripts");
    expect(calls.some((call) => call.startsWith("git commit") || call.startsWith("git push"))).toBe(false);
  });
});
