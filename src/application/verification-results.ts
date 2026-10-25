import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceDirectory, readEvidenceBundle } from "./evidence-bundles.js";
import { approvedSourceRevision } from "./integration-review.js";
import { withStaleAwareLock } from "./fs-lock.js";
import { writeAtomically } from "./fs-atomic.js";

export interface VerificationRequirement {
  task: string;
  check: string;
  kind: "command" | "browser" | "manual" | "research";
  expected: string;
  command?: string;
  cwd?: string;
  procedure?: string;
  provenancePath?: string;
  definition: string;
}
export interface VerificationResultInput {
  task: string;
  check: string;
  status: "verified" | "failed" | "untested";
  proof: string;
  tool?: string;
  command?: string;
  cwd?: string;
  exitCode?: number;
  route?: string;
  viewport?: string;
  state?: string;
  evidenceId?: string;
}
interface VerificationResult extends VerificationResultInput {
  definition: string;
  sourceRevision?: string;
  recordedAt: string;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }

export async function verificationRequirements(festival: string, task?: string): Promise<VerificationRequirement[]> {
  const file = join(festival, "APPROVED_PLAN.json");
  const info = await lstat(file).catch((error: unknown) => { if (object(error) && error.code === "ENOENT") return undefined; throw error; });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe approved plan artifact");
  const artifact: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!object(artifact) || !object(artifact.spec) || !Array.isArray(artifact.spec.phases)) throw new Error("Invalid approved plan artifact");
  const requirements: VerificationRequirement[] = [];
  for (const phase of artifact.spec.phases) {
    if (!object(phase) || !Array.isArray(phase.sequences)) continue;
    for (const sequence of phase.sequences) {
      if (!object(sequence) || !Array.isArray(sequence.tasks)) continue;
      for (const item of sequence.tasks) {
        if (!object(item) || !nonempty(item.id) || !Array.isArray(item.verification) || (task && task !== item.id)) continue;
        for (const [index, check] of item.verification.entries()) {
          if (!object(check) || !nonempty(check.expected)) throw new Error(`Invalid verification definition for ${item.id}`);
          const kind = check.kind ?? "command";
          if (kind !== "command" && kind !== "browser" && kind !== "manual" && kind !== "research") throw new Error(`Unknown verification kind in ${item.id}`);
          requirements.push({ task: item.id, check: nonempty(check.id) ? check.id : `check-${index + 1}`, kind, expected: check.expected,
            ...(nonempty(check.command) ? { command: check.command } : {}), ...(nonempty(check.cwd) ? { cwd: check.cwd } : {}),
            ...(nonempty(check.procedure) ? { procedure: check.procedure } : {}), ...(nonempty(check.provenancePath) ? { provenancePath: check.provenancePath } : {}),
            definition: createHash("sha256").update(JSON.stringify(check)).digest("hex"),
          });
        }
      }
    }
  }
  return requirements;
}
async function results(festival: string): Promise<VerificationResult[]> {
  const path = join(await evidenceDirectory(festival), "verification-results.json");
  const info = await lstat(path).catch((error: unknown) => { if (object(error) && error.code === "ENOENT") return undefined; throw error; });
  if (!info) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error("Unsafe verification results store");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(value) || !value.every((item) => object(item) && nonempty(item.task) && nonempty(item.check) && nonempty(item.proof) && nonempty(item.definition) && nonempty(item.recordedAt) && ["verified", "failed", "untested"].includes(String(item.status)))) throw new Error("Invalid verification results store");
  // Every record passed the persisted data guard above; optional fields are inspected only when used.
  return value as VerificationResult[];
}
export async function recordVerificationResult(festival: string, input: VerificationResultInput): Promise<VerificationResult> {
  const requirement = (await verificationRequirements(festival, input.task)).find((item) => item.check === input.check);
  if (!requirement) throw new Error("Choose an exact task/check from fest_verification requirements");
  if (!["verified", "failed", "untested"].includes(input.status) || !nonempty(input.proof)) throw new Error("Verification needs actual proof or an explicit failed/untested limitation");
  if (input.status === "verified") {
    if (!nonempty(input.tool)) throw new Error("Verified results must name the actual execution or observation tool");
    if (requirement.kind === "command" && (input.command !== requirement.command || (input.cwd ?? ".") !== (requirement.cwd ?? ".") || input.exitCode !== 0)) throw new Error("Verified command results require the declared command/cwd and observed exitCode:0");
    if (requirement.kind === "browser" && ![input.route, input.viewport, input.state].every(nonempty)) throw new Error("Verified browser results require route, viewport, state and actual observation proof");
    if (!input.evidenceId) throw new Error("Verified results require an existing evidence bundle with the actual output or observations");
  }
  if (input.evidenceId) await readEvidenceBundle(festival, input.evidenceId);
  const directory = await evidenceDirectory(festival);
  return withStaleAwareLock(join(directory, ".verification-results.lock"), async () => {
    const current = await results(festival);
    const sourceRevision = await approvedSourceRevision(festival);
    const record: VerificationResult = { ...input, definition: requirement.definition, ...(sourceRevision ? { sourceRevision } : {}), recordedAt: new Date().toISOString() };
    await writeAtomically(join(directory, "verification-results.json"), JSON.stringify([...current.filter((row) => row.task !== input.task || row.check !== input.check), record], null, 2) + "\n");
    return record;
  }, { label: "Verification evidence" });
}
export async function verificationResultStatus(festival: string, task?: string) {
  const requirements = await verificationRequirements(festival, task);
  const stored = await results(festival);
  const sourceRevision = await approvedSourceRevision(festival);
  const checks = await Promise.all(requirements.map(async (requirement) => {
    const record = stored.find((row) => row.task === requirement.task && row.check === requirement.check);
    let status = !record ? "missing" : record.definition !== requirement.definition || record.sourceRevision !== sourceRevision ? "stale" : record.status;
    if (record?.status === "verified" && status === "verified") {
      try { if (!record.evidenceId) status = "stale"; else await readEvidenceBundle(festival, record.evidenceId); }
      catch { status = "stale"; }
    }
    return { ...requirement, status, ...(record ? { result: record } : {}) };
  }));
  return { checks, valid: checks.every((check) => check.status === "verified"), missingRequirements: checks.filter((check) => check.status !== "verified").map((check) => ({ task: check.task, check: check.check, status: check.status, expected: check.expected })) };
}
