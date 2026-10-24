import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeEvidenceBundle, readEvidenceBundle } from "../src/application/evidence-bundles.js";
import { INTEGRATION_CHECKS, integrationReviewStatus, recordIntegrationReview, type IntegrationCheck } from "../src/application/integration-review.js";
import { executeRelease, previewRelease } from "../src/application/release-workflow.js";
import { listProjectReservations, releaseProjectFiles, reserveProjectFiles } from "../src/application/project-conflicts.js";
import type { CampDetect, ExecRunner } from "../src/ports.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fest-quality-")); roots.push(root);
  await writeFile(join(root, "task.md"), "Approved task");
  await writeFile(join(root, ".omp-fest-owner.json"), JSON.stringify({ sessionId: "s", claimedAt: new Date(0).toISOString() }));
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

  it("rejects evidence and integration writes by unowned sessions without claiming ownership", async () => {
    const { root, detect } = await fixture();
    await expect(storeEvidenceBundle(root, { kind: "worker", summary: "No claim", details: "proof", ownerSessionId: "other" })).rejects.toThrow("explicit ownership");
    await expect(recordIntegrationReview(root, detect, {
      sessionId: "other", checks: INTEGRATION_CHECKS.map((id) => ({ id, status: "verified", proof: "Checked" })),
      comparisons: [], summary: "Unauthorized", details: "proof",
    })).rejects.toThrow("explicit ownership");
    expect(JSON.parse(await readFile(join(root, ".omp-fest-owner.json"), "utf8")) as unknown).toMatchObject({ sessionId: "s" });
  });

  it("uses compare-and-swap so overlapping integration records cannot overwrite each other", async () => {
    const { root, detect } = await fixture();
    const record = (summary: string) => recordIntegrationReview(root, detect, {
      sessionId: "s", checks: INTEGRATION_CHECKS.map((id) => ({ id, status: "verified", proof: "Checked" })),
      comparisons: [], summary, details: summary,
    });
    const outcomes = await Promise.allSettled([record("first"), record("second")]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const saved: unknown = JSON.parse(await readFile(join(root, ".ompfest", "evidence", "integration.json"), "utf8"));
    if (!saved || typeof saved !== "object" || !("evidence" in saved) || !saved.evidence || typeof saved.evidence !== "object" || !("summary" in saved.evidence)) {
      throw new Error("Integration evidence file is invalid");
    }
    expect(["first", "second"]).toContain(saved.evidence.summary);
  });

  it("recovers only dead same-host integration locks and preserves live or unknown owners", async () => {
    const { root, detect } = await fixture();
    const directory = join(root, ".ompfest", "evidence");
    await mkdir(join(directory, "integration.lock"), { recursive: true });
    await writeFile(join(directory, "integration.lock", "owner.json"), JSON.stringify({ host: hostname(), pid: 2147483647, token: "dead-owner" }));
    const input = { sessionId: "s", checks: INTEGRATION_CHECKS.map((id) => ({ id, status: "verified" as const, proof: "Checked" })), comparisons: [], summary: "Recovered", details: "Proof" };
    await expect(recordIntegrationReview(root, detect, input)).resolves.toMatchObject({ status: "verified" });
    await mkdir(join(directory, "integration.lock"), { recursive: true });
    await writeFile(join(directory, "integration.lock", "owner.json"), JSON.stringify({ host: hostname(), pid: process.pid, token: "live-owner" }));
    await expect(recordIntegrationReview(root, detect, input)).rejects.toThrow("owner is unknown");
    expect(JSON.parse(await readFile(join(directory, "integration.lock", "owner.json"), "utf8"))).toMatchObject({ token: "live-owner" });
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
    const cwdCalls: string[] = [];
    const exec: ExecRunner = { run: (command, args, cwd) => {
      const call = `${command} ${args.join(" ")}`; calls.push(call);
      if (cwd) cwdCalls.push(cwd);
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
    expect(result).toMatchObject({ status: "failed", failedStage: "test" });
    expect(calls).toContain("npm version 1.3.0 --no-git-tag-version --ignore-scripts");
    expect(calls.some((call) => call.startsWith("git commit") || call.startsWith("git push"))).toBe(false);
    expect(cwdCalls.every((cwd) => cwd === root)).toBe(true);
    expect(await listProjectReservations(root)).toEqual([]);
  });
  it("commits and pushes only from the approved preview project root", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "2.4.1", scripts: { test: "node test.js" } }));
    const calls: { command: string; cwd: string }[] = [];
    const exec: ExecRunner = { run: (command, args, cwd) => {
      calls.push({ command: `${command} ${args.join(" ")}`, cwd: cwd ?? "" });
      const stdout = args.includes("--show-prefix") ? "" : args[0] === "branch" ? "release\n" : args.includes("@{upstream}") ? "origin/release\n" : args[0] === "rev-parse" ? "head\n" : args[0] === "diff" ? "task.md\0" : "";
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    } };
    const preview = await previewRelease(root, "patch", exec);
    const result = await executeRelease(preview, "patch", "release", exec);
    expect(result).toMatchObject({ status: "pushed", version: "2.4.2" });
    const commitAndPush = calls.filter((call) => call.command.startsWith("git commit") || call.command.startsWith("git push"));
    expect(commitAndPush.map((call) => call.command)).toEqual(["git commit -m release", "git push"]);
    expect(commitAndPush.every((call) => call.cwd === root)).toBe(true);
    expect(await listProjectReservations(root)).toEqual([]);
  });
  it("releases only its own checkout reservation after every failed release stage", async () => {
    for (const failedCommand of ["npm version", "npm run", "git add", "git commit", "git push"]) {
      const { root } = await fixture();
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "3.0.0", scripts: { test: "node test.js" } }));
      const exec: ExecRunner = { run: (command, args) => {
        const call = `${command} ${args.join(" ")}`;
        const stdout = args.includes("--show-prefix") ? "" : args[0] === "branch" ? "release\n" : args.includes("@{upstream}") ? "origin/release\n" : args[0] === "rev-parse" ? "head\n" : args[0] === "diff" ? "task.md\0" : "";
        return Promise.resolve({ code: call.startsWith(failedCommand) ? 1 : 0, stdout, stderr: "" });
      } };
      const preview = await previewRelease(root, "patch", exec);
      const result = await executeRelease(preview, "patch", "release", exec);
      expect(result).toMatchObject({ status: failedCommand === "git push" ? "push_failed" : "failed" });
      expect(await listProjectReservations(root)).toEqual([]);
    }
  });
  it("rejects concurrent project writers before version mutation", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3", scripts: { test: "node test.js" } }));
    const writer = await reserveProjectFiles(root, { sessionId: "writer", assignmentId: "active", files: ["task.md"] });
    expect(writer.kind).toBe("reserved");
    const calls: string[] = [];
    const exec: ExecRunner = { run: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      const stdout = args.includes("--show-prefix") ? "" : args[0] === "branch" ? "main\n" : args.includes("@{upstream}") ? "origin/main\n" : args[0] === "rev-parse" ? "head\n" : args[0] === "diff" ? "task.md\0" : "";
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    } };
    const preview = await previewRelease(root, "patch", exec);
    const result = await executeRelease(preview, "patch", "release", exec);
    expect(result).toMatchObject({ status: "failed", failedStage: "write-locks" });
    expect(calls.some((call) => call.startsWith("npm version"))).toBe(false);
    expect(await listProjectReservations(root)).toMatchObject([{ sessionId: "writer", assignmentId: "active" }]);
    await releaseProjectFiles(root, "writer", "active");
  });
});
