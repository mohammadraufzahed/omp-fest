import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlanArtifact } from "./plan-artifacts.js";
import { campRelativeWorkingDir } from "./sequence-goals.js";
import { renderTaskContract, structuredHierarchyName, structuredPhaseName, type StructuredPlan } from "./structured-plan.js";

const START = "<!-- omp-fest:approved-contract:start -->";
const END = "<!-- omp-fest:approved-contract:end -->";
const MARKER = /\[(?:FILL|REPLACE):/;
const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function display(text: string): string {
  return text.replace(/[\\`*_{}<>#|[\]]/g, (character) => `\\${character}`);
}

function nameOf(content: string): string | undefined {
  const value = block.exec(content)?.[1]?.match(/^fest_name:\s*(.*?)\s*$/m)?.[1];
  if (value?.startsWith('"')) return JSON.parse(value) as string;
  if (value?.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

async function existing(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe scaffold document: ${path}`);
  return readFile(path, "utf8");
}

function retainedBody(body: string): string {
  const start = body.indexOf(START);
  if (start !== -1) {
    const end = body.indexOf(END, start);
    if (end === -1) throw new Error("Incomplete generated approved-contract block");
    return (body.slice(0, start) + body.slice(end + END.length)).trim();
  }
  if (!MARKER.test(body)) return body.trim();
  // Discard obsolete template sections as units. Never replace placeholders with guessed prose.
  // Marker-free sections are user-owned and survive the scaffold cutover.
  return body.split(/\n(?=#{1,6} )/).filter((section) => !MARKER.test(section)).join("\n").trim();
}

function document(content: string | undefined, type: string, name: string, body: string, workingDir?: string): string {
  const match = content ? block.exec(content) : undefined;
  if (content !== undefined && !match && type !== "festival") throw new Error(`Scaffold ${name} is missing required frontmatter`);
  let frontmatter = match?.[1] ?? `fest_type: ${type}\nfest_id: ${JSON.stringify(name)}\nfest_name: ${JSON.stringify(name)}\nfest_status: pending`;
  if (workingDir) {
    const line = `fest_working_dir: ${JSON.stringify(workingDir)}`;
    frontmatter = /^fest_working_dir:.*$/m.test(frontmatter)
      ? frontmatter.replace(/^fest_working_dir:.*$/m, line)
      : `${frontmatter}\n${line}`;
  }
  const retained = retainedBody(content?.slice(match?.[0].length ?? 0) ?? "");
  const result = `---\n${frontmatter}\n---\n\n${START}\n${body.trim()}\n${END}\n${retained ? `\n${retained}\n` : ""}`;
  if (MARKER.test(result)) throw new Error(`Scaffold ${name} contains unresolved markers outside the replaceable template body`);
  return result;
}

function bullets(items: string[], fallback = "None."): string[] {
  return items.length ? items.map((item) => `- ${display(item)}`) : [`- ${fallback}`];
}

function acceptance(spec: StructuredPlan, ids?: Set<string>): string[] {
  const result = spec.acceptance.filter((item) => !ids || ids.has(item.id)).map((item) => `- [ ] ${display(item.id)}: ${display(item.description)}`);
  return result.length ? result : ["- [ ] All approved task contracts in this scope are complete."];
}


function contractOverview(artifact: PlanArtifact): string {
  const spec = artifact.spec;
  return [
    `# Festival Goal: ${display(artifact.name)}`, "", "## Objective", display(spec.goal),
    "", "## Scope", ...bullets(spec.scope), "", "## Exclusions", ...bullets(spec.exclusions),
    "", "## Success Criteria", ...acceptance(spec), "", "## Constraints & Rules", artifact.rules.trim() || "No additional constraints were supplied in the approved plan.",
    "", "## Open Questions", ...bullets(spec.questions.map((item) => `Nonblocking: ${item.question}`)),
  ].join("\n");
}

async function numbered(path: string, kind: "directory" | "file") {
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => /^\d+_/.test(entry.name) && (kind === "directory" ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(".md")))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
}

/** Finalize the freshly scaffolded tree before gates or validation. All structure is checked before writing. */
export async function finalizeApprovedScaffold(root: string, festival: string, artifact: PlanArtifact): Promise<{ files: string[]; workingDir: string }> {
  const workingDir = await campRelativeWorkingDir(root, artifact.workingDir);
  const phases = await numbered(festival, "directory");
  if (phases.length !== artifact.spec.phases.length) throw new Error("Scaffold phase tree differs from approved plan");
  const writes: { path: string; content: string }[] = [];
  const queue = async (path: string, type: string, name: string, body: string, expected?: string, cwd?: string) => {
    const current = await existing(path);
    if (expected !== undefined && (!current || nameOf(current) !== expected)) throw new Error(`Scaffold name differs from approved plan: ${path}`);
    writes.push({ path, content: document(current, type, name, body, cwd) });
  };
  await queue(join(festival, "FESTIVAL_GOAL.md"), "festival", artifact.name, contractOverview(artifact));
  await queue(join(festival, "FESTIVAL_OVERVIEW.md"), "festival", artifact.name, [
    `# Festival Overview: ${display(artifact.name)}`, "", "## Goal", display(artifact.spec.goal),
    "", "## Working Directory", `Camp-relative project: ${display(workingDir)}`,
    "", "## Phases", ...artifact.spec.phases.map((phase, index) => `- ${index + 1}. ${display(phase.name)} (${phase.type}) — ${display(phase.id)}`),
    "", "## Acceptance Criteria", ...acceptance(artifact.spec),
    "", "## Repository Inspection", ...artifact.spec.inspection.map((item) => `- ${display(item.path)}: ${display(item.reason)}`),
    "", "## Constraints & Rules", artifact.rules.trim() || "No additional constraints were supplied in the approved plan.",
  ].join("\n"));
  for (const [p, phase] of artifact.spec.phases.entries()) {
    const phaseEntry = phases[p];
    if (!phaseEntry || Number.parseInt(phaseEntry.name) !== p + 1) throw new Error("Scaffold phase order differs from approved plan");
    const phaseDir = join(festival, phaseEntry.name);
    const sequences = await numbered(phaseDir, "directory");
    if (sequences.length !== phase.sequences.length) throw new Error(`Scaffold sequences differ for ${phase.id}`);
    const phaseTasks = phase.sequences.flatMap((sequence) => sequence.tasks);
    await queue(join(phaseDir, "PHASE_GOAL.md"), "phase", phase.name, [
      `# Phase Goal: ${display(phase.name)}`, "", "## Objective", display(phase.objective),
      "", `Approved phase: ${display(phase.id)} (${phase.type}).`, "", "## Scope",
      ...phase.sequences.map((sequence) => `- ${display(sequence.id)}: ${display(sequence.name)}`),
      "", "## Success Criteria",
      ...phase.completionCriteria.map((criterion) => `- [ ] ${display(criterion)}`),
      ...acceptance(artifact.spec, new Set(phaseTasks.flatMap((task) => [...task.implements, ...task.verifies]))),
      "", "## Deliverables", ...phase.deliverables.map((item) => `- ${display(item)}`),
      ...phaseTasks.map((task) => `- ${display(task.id)}: ${display(task.description)}`),
    ].join("\n"), structuredPhaseName(phase.name).toLowerCase());
    for (const [s, sequence] of phase.sequences.entries()) {
      const sequenceEntry = sequences[s];
      if (!sequenceEntry || Number.parseInt(sequenceEntry.name) !== s + 1) throw new Error("Scaffold sequence order differs from approved plan");
      const sequenceDir = join(phaseDir, sequenceEntry.name);
      await queue(join(sequenceDir, "SEQUENCE_GOAL.md"), "sequence", sequence.name, [
        `# Sequence Goal: ${display(sequence.name)}`, "", "## Objective", display(artifact.spec.goal),
        "", `Approved sequence: ${display(sequence.id)}.`, "", "## Scope",
        ...sequence.tasks.map((task) => `- ${display(task.id)}: ${display(task.description)}`),
        "", "## Success Criteria", ...acceptance(artifact.spec, new Set(sequence.tasks.flatMap((task) => [...task.implements, ...task.verifies]))),
        "", "## Tasks", ...sequence.tasks.map((task) => `- ${display(task.id)}: ${display(task.title)}; dependencies: ${task.dependsOn.map(display).join(", ") || "none"}`),
      ].join("\n"), structuredHierarchyName(sequence.name), workingDir);
      const tasks = await numbered(sequenceDir, "file");
      if (tasks.length !== sequence.tasks.length) throw new Error(`Scaffold tasks differ for ${sequence.id}`);
      for (const [t, task] of sequence.tasks.entries()) {
        const entry = tasks[t];
        if (!entry || Number.parseInt(entry.name) !== t + 1) throw new Error("Scaffold task order differs from approved plan");
        const pages = [...new Set([...task.implements, ...task.verifies].filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*\/AC-\d+$/.test(id)).map((id) => id.slice(0, id.indexOf("/"))))];
        await queue(join(sequenceDir, entry.name), "task", task.title, [
          `# Task: ${display(task.title)}`, "", ...pages.map((page) => `Visual reference: references/pages/${page}/PAGE.md`),
          "", "## Approved Plan Contract", renderTaskContract(artifact.spec, task).trim(),
        ].join("\n"), structuredHierarchyName(task.title));
      }
    }
  }
  const approvedPath = join(festival, "APPROVED_PLAN.json");
  await existing(approvedPath);
  writes.push({ path: approvedPath, content: JSON.stringify({ ...artifact, workingDir }, null, 2) + "\n" });
  for (const item of writes) await writeFile(item.path, item.content);
  return { files: writes.map((item) => item.path), workingDir };
}
