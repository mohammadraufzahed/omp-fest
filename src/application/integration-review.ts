import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { festivalOwner } from "./festival-ownership.js";
import type { CampDetect } from "../ports.js";
import { evidenceDirectory, storeEvidenceBundle } from "./evidence-bundles.js";
import { validateVisualReferences } from "./visual-references.js";
import { approvedWorktreeSourceDirectory } from "./festival-worktrees.js";
import { festivalCampRoot } from "../domain/festival-lifecycle.js";

interface IntegrationLockOwner { host: string; pid: number; token: string }
const integrationLockOwnerPath = (lock: string) => join(lock, "owner.json");

async function readIntegrationLockOwner(lock: string): Promise<IntegrationLockOwner | undefined> {
  try {
    const lockInfo = await lstat(lock);
    const ownerPath = integrationLockOwnerPath(lock);
    const ownerInfo = await lstat(ownerPath);
    if (!lockInfo.isDirectory() || lockInfo.isSymbolicLink() || !ownerInfo.isFile() || ownerInfo.isSymbolicLink()) return undefined;
    const parsed: unknown = JSON.parse(await readFile(ownerPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !("host" in parsed) || typeof parsed.host !== "string" || !("pid" in parsed) || !Number.isSafeInteger(parsed.pid) || !("token" in parsed) || typeof parsed.token !== "string" || !parsed.token) return undefined;
    return parsed as IntegrationLockOwner;
  } catch { return undefined; }
}

function processIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function acquireIntegrationLock(lock: string): Promise<IntegrationLockOwner> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner: IntegrationLockOwner = { host: hostname(), pid: process.pid, token: randomUUID() };
    try {
      await mkdir(lock);
      try {
        await writeFile(integrationLockOwnerPath(lock), JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
        return owner;
      } catch (error) {
        await rm(lock, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const staleOwner = await readIntegrationLockOwner(lock);
    if (staleOwner?.host !== hostname() || !processIsDead(staleOwner.pid)) throw new Error("Another integration review is being recorded or its lock owner is unknown; reread its status.");
    const quarantine = `${lock}.${randomUUID()}.stale`;
    try { await rename(lock, quarantine); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const movedOwner = await readIntegrationLockOwner(quarantine);
    if (movedOwner?.host === staleOwner.host && movedOwner.pid === staleOwner.pid && movedOwner.token === staleOwner.token && processIsDead(movedOwner.pid)) {
      await rm(quarantine, { recursive: true, force: true });
    } else {
      await mkdir(lock).then(() => rename(quarantine, lock)).catch(() => undefined);
    }
  }
  throw new Error("Could not recover the stale integration review lock safely; retry after inspecting its owner.");
}

async function releaseIntegrationLock(lock: string, owner: IntegrationLockOwner): Promise<void> {
  const current = await readIntegrationLockOwner(lock);
  if (current?.host === owner.host && current.pid === owner.pid && current.token === owner.token) await rm(lock, { recursive: true, force: true });
}


export const INTEGRATION_GUIDE = "Run the final integration pass before presenting the completion gate: inspect combined changes and approved acceptance; exercise target routes, interactions, responsive sizes and console errors. Prefer Playwright MCP when exposed. Compare real rendered captures to reference at the original viewport, list concrete layout/typography/spacing differences and fix them. Inspect UI-exported PDFs directly. Record actual checks with fest_integration; mark unavailable checks untested, never passed. Small cleanup stays within approved scope; larger scope changes need approval.";
export interface IntegrationCheck { id: string; status: "verified" | "failed" | "untested" | "not_applicable"; proof: string }
export interface VisualComparison {
  page: string; route: string; viewport: string; browserTool: string;
  reference: string; capture: string; differences: string[]; status: "verified" | "failed" | "untested";
}
export const INTEGRATION_CHECKS = ["acceptance", "integration", "layout", "interactions", "responsive", "console"] as const;


/** Content identity for the source files declared by the approved project plan. */
export async function approvedSourceRevision(festivalDir: string): Promise<string | undefined> {
  const content = await readFile(join(festivalDir, "APPROVED_PLAN.json"), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (content === undefined) return undefined;
  const artifact: unknown = JSON.parse(content);
  if (!artifact || typeof artifact !== "object" || !("workingDir" in artifact) || typeof artifact.workingDir !== "string" || !artifact.workingDir.trim() ||
      !("spec" in artifact) || !artifact.spec || typeof artifact.spec !== "object" || !("phases" in artifact.spec) || !Array.isArray(artifact.spec.phases)) return undefined;
  const camp = festivalCampRoot(festivalDir);
  if (!camp && !isAbsolute(artifact.workingDir)) throw new Error("Cannot resolve the approved project's camp root");
  const logicalProject = isAbsolute(artifact.workingDir) ? artifact.workingDir : resolve(camp ?? "", artifact.workingDir);
  const project = await approvedWorktreeSourceDirectory(festivalDir, artifact.workingDir) ?? logicalProject;
  const sourcePaths = new Set<string>();
  for (const phase of artifact.spec.phases as unknown[]) {
    if (!phase || typeof phase !== "object" || !("sequences" in phase) || !Array.isArray(phase.sequences)) continue;
    for (const sequence of phase.sequences as unknown[]) {
      if (!sequence || typeof sequence !== "object" || !("tasks" in sequence) || !Array.isArray(sequence.tasks)) continue;
      for (const task of sequence.tasks as unknown[]) {
        if (!task || typeof task !== "object" || !("files" in task) || !Array.isArray(task.files)) continue;
        for (const entry of task.files as unknown[]) if (entry && typeof entry === "object" && "path" in entry && typeof entry.path === "string") sourcePaths.add(entry.path);
      }
    }
  }
  if (!sourcePaths.size) return undefined;
  const hash = createHash("sha256").update(content).update("\0").update(logicalProject);
  for (const path of [...sourcePaths].sort()) {
    const target = resolve(project, path);
    const rel = relative(project, target);
    if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Approved source file escapes project");
    hash.update("\0").update(path).update("\0");
    try {
      const contents = await readFile(target);
      hash.update("present:").update(String(contents.length)).update("\0").update(contents);
    }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") hash.update("missing"); else throw error; }
  }
  return hash.digest("hex");
}
async function reviewRevision(festivalDir: string, detect: CampDetect) {
  const hash = createHash("sha256");
  const tasks = await detect.pendingTasks(festivalDir);
  for (const task of [...tasks].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(task.path).update(String(task.done)).update(await readFile(join(festivalDir, task.path), "utf8"));
  }
  for (const file of ["APPROVED_PLAN.json", "references/verification.json"]) {
    try { hash.update(await readFile(join(festivalDir, file), "utf8")); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (file === "APPROVED_PLAN.json") hash.update(await approvedSourceRevision(festivalDir) ?? "no-approved-source-revision");
  }
  return hash.digest("hex");
}

async function recordSnapshot(path: string) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

export async function recordIntegrationReview(festivalDir: string, detect: CampDetect, input: { sessionId: string; checks: IntegrationCheck[]; comparisons: VisualComparison[]; summary: string; details: string }) {
  if ((await festivalOwner(festivalDir))?.sessionId !== input.sessionId) throw new Error("Integration mutation requires explicit ownership by this session.");
  const directory = await evidenceDirectory(festivalDir);
  const recordPath = join(directory, "integration.json");
  const previousRecord = await recordSnapshot(recordPath);
  if (input.checks.length !== INTEGRATION_CHECKS.length || new Set(input.checks.map((check) => check.id)).size !== INTEGRATION_CHECKS.length || input.checks.some((check) => !INTEGRATION_CHECKS.some((id) => id === check.id) || !check.proof.trim())) throw new Error(`Integration checks must cover exactly ${INTEGRATION_CHECKS.join(", ")} with real evidence or an explicit limitation`);
  if (input.checks.some((check) => !["verified", "failed", "untested", "not_applicable"].includes(check.status) || (["acceptance", "integration"].includes(check.id) && check.status === "not_applicable"))) throw new Error("Acceptance/integration cannot be not_applicable; use actual verified, failed or untested evidence");
  const visual = await validateVisualReferences(festivalDir, detect);
  if (visual.issues.length) throw new Error(`Repair visual references: ${visual.issues.slice(0, 3).join("; ")}`);
  const comparisons = new Set(input.comparisons.map((comparison) => comparison.page));
  if (comparisons.size !== input.comparisons.length || visual.pages.some((page) => !comparisons.has(page))) throw new Error("Visual integration needs one comparison per referenced page, including explicit untested limitations");
  const files: string[] = [];
  for (const comparison of input.comparisons) {
    if (![comparison.page, comparison.route, comparison.viewport, comparison.browserTool, comparison.reference].every((value) => value.trim()) || (comparison.status !== "untested" && !comparison.capture.trim())) throw new Error("Visual comparison needs page, route, viewport, browser tool, reference and actual capture (capture may be empty only when untested)");
    if (comparison.status === "verified" && comparison.differences.length) throw new Error("Visual comparison with unresolved differences cannot be verified");
    if (!["verified", "failed", "untested"].includes(comparison.status) || (comparison.status === "untested" && !comparison.differences.length)) throw new Error("Untested visual comparisons need an explicit limitation in differences");
    files.push(comparison.reference, ...(comparison.capture ? [comparison.capture] : []));
  }
  const lock = join(directory, "integration.lock");
  const lockOwner = await acquireIntegrationLock(lock);
  let bundlePath: string | undefined;
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    if (await recordSnapshot(recordPath) !== previousRecord) throw new Error("Concurrent integration review changed the record; reread status and retry.");
    const revision = await reviewRevision(festivalDir, detect);
    const bundle = await storeEvidenceBundle(festivalDir, {
      kind: "integration", summary: input.summary,
      details: JSON.stringify({ checks: input.checks, comparisons: input.comparisons, notes: input.details }, null, 2),
      attachments: files, ownerSessionId: input.sessionId,
    });
    bundlePath = bundle.path;
    const record = { sessionId: input.sessionId, revision, checks: input.checks, comparisons: input.comparisons, evidence: bundle, createdAt: new Date().toISOString() };
    await writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, recordPath);
    bundlePath = undefined;
    return { status: input.checks.some((check) => check.status === "failed") || input.comparisons.some((comparison) => comparison.status === "failed") ? "failed" : input.checks.some((check) => check.status === "untested") || input.comparisons.some((comparison) => comparison.status === "untested") ? "untested" : "verified", evidence: bundle };
  } catch (error) {
    await rm(temporary, { force: true });
    if (bundlePath) await rm(bundlePath, { force: true });
    throw error;
  } finally {
    await releaseIntegrationLock(lock, lockOwner);
  }
}

export async function integrationReviewStatus(festivalDir: string, detect: CampDetect) {
  const path = join(await evidenceDirectory(festivalDir), "integration.json");
  const info = await lstat(path).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { status: "missing", hint: INTEGRATION_GUIDE };
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("Unsafe integration review record");
  const record: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!record || typeof record !== "object" || !("revision" in record) || !("checks" in record) || !Array.isArray(record.checks) || !("comparisons" in record) || !Array.isArray(record.comparisons)) throw new Error("Invalid integration review record");
  if (record.revision !== await reviewRevision(festivalDir, detect)) return { status: "stale", hint: INTEGRATION_GUIDE };
  const checks: unknown[] = record.checks;
  const comparisons: unknown[] = record.comparisons;
  const results = [...checks, ...comparisons];
  const failed = results.some((item) => item && typeof item === "object" && "status" in item && item.status === "failed");
  const untested = results.some((item) => item && typeof item === "object" && "status" in item && item.status === "untested");
  return { status: failed ? "failed" : untested ? "untested" : "verified", path };
}
