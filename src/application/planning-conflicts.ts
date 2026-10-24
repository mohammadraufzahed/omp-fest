import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalProjectDirectory } from "./project-conflicts.js";
import type { StructuredPlan } from "./structured-plan.js";
export interface PlannedConflict { name: string; workingDir: string; files: string[] }
function files(spec: StructuredPlan): string[] {
  return [...new Set(spec.phases.flatMap((phase) => phase.sequences.flatMap((sequence) => sequence.tasks.flatMap((task) => task.files.map((file) => file.path)))))].sort();
}
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
export async function findPlanningConflicts(root: string, name: string, workingDir: string, spec: StructuredPlan): Promise<PlannedConflict[]> {
  const project = await canonicalProjectDirectory(resolve(root, workingDir));
  const proposedFiles = files(spec), plans = join(root, ".ompfest", "plans"), entries = await readdir(plans).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
  const conflicts: PlannedConflict[] = [];
  for (const entry of entries.filter((file) => file.endsWith(".STRUCTURE.md.json") && file !== `${name}.STRUCTURE.md.json`)) {
    const statusPath = join(plans, `${entry.slice(0, -".json".length)}.status.json`);
    const statusInfo = await lstat(statusPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (statusInfo && statusInfo.isFile() && !statusInfo.isSymbolicLink()) {
      try { const status: unknown = JSON.parse(await readFile(statusPath, "utf8")); if (status && typeof status === "object" && "state" in status && status.state === "scaffolded") continue; } catch { /* Corrupt markers do not suppress an overlap. */ }
    }
    const artifact: unknown = JSON.parse(await readFile(join(plans, entry), "utf8"));
    if (!artifact || typeof artifact !== "object" || !("name" in artifact) || typeof artifact.name !== "string" || !("workingDir" in artifact) || typeof artifact.workingDir !== "string" || !("spec" in artifact)) continue;
    const saved = artifact as { name: string; workingDir: string; spec: StructuredPlan };
    if (!Array.isArray(saved.spec.phases)) continue;
    const otherProject = await canonicalProjectDirectory(resolve(root, saved.workingDir)).catch(() => undefined);
    if (!otherProject || otherProject !== project) continue;
    const otherFiles = files(saved.spec), intersection = proposedFiles.filter((path) => otherFiles.some((other) => overlaps(path, other)));
    if (intersection.length || !proposedFiles.length || !otherFiles.length) conflicts.push({ name: saved.name, workingDir: saved.workingDir, files: intersection.length ? intersection : ["<unknown file boundary>"] });
  }
  return conflicts;
}
