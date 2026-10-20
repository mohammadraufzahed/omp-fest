import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CampDetect } from "../ports.js";
import { linkedPages, referencesForTask, taskChecks, withVisualReferenceLock } from "./visual-references.js";

export type VerificationStatus = "verified" | "failed" | "untested";

export interface VisualEvidence {
  page: string;
  check: string;
  status: VerificationStatus;
  proof: string;
  route?: string;
  viewport?: string;
  state?: string;
  task?: string;
}

interface EvidenceRecord extends VisualEvidence {
  task: string;
  revision: string;
}

interface EvidenceStore {
  version: 1;
  records: EvidenceRecord[];
}

export interface EvidenceStatus {
  verified: EvidenceRecord[];
  untested: EvidenceRecord[];
  issues: string[];
}

function storePath(dir: string): string {
  return join(dir, "references", "verification.json");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is EvidenceRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return ["task", "page", "check", "revision", "proof"].every((key) => nonempty(record[key])) &&
    ["verified", "failed", "untested"].includes(String(record.status)) &&
    (record.status !== "verified" || ["route", "viewport", "state"].every((key) => nonempty(record[key])));
}

async function readStore(dir: string): Promise<EvidenceStore> {
  const file = storePath(dir);
  const info = await lstat(file).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!info) {
    return { version: 1, records: [] };
  }
  if (!info.isFile() || info.size > 1024 * 1024) {
    throw new Error("Visual verification must be a small regular file");
  }
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 ||
    !("records" in data) || !Array.isArray(data.records) || !data.records.every(isRecord)) {
    throw new Error("Invalid visual verification file");
  }
  if (new Set(data.records.map((record) => `${record.task}/${record.page}/${record.check}`)).size !== data.records.length) {
    throw new Error("Duplicate visual verification records");
  }
  return data as EvidenceStore;
}

export async function pageRevision(dir: string, page: string): Promise<string> {
  const [reference] = await referencesForTask(dir, `Visual reference: references/pages/${page}/PAGE.md`);
  if (!reference) {
    throw new Error(`Missing visual reference: ${page}`);
  }
  const svg = await readFile(reference.wireframe);
  return createHash("sha256").update(reference.content).update("\0").update(svg).digest("hex");
}

export async function validateVisualEvidenceForTask(
  dir: string,
  task: string,
  taskDoc: string,
  entries: VisualEvidence[],
): Promise<EvidenceRecord[]> {
  const expected = taskChecks(taskDoc);
  const linked = linkedPages(taskDoc);
  const keys = expected.map((item) => `${item.page}/${item.id}`);
  if (entries.length !== keys.length || new Set(entries.map((entry) => `${entry.page}/${entry.check}`)).size !== keys.length ||
    entries.some((entry) => !keys.includes(`${entry.page}/${entry.check}`))) {
    throw new Error(`Visual evidence for ${task} must cover exactly: ${keys.join(", ") || "no checks"}`);
  }
  const records: EvidenceRecord[] = [];
  const references = await referencesForTask(dir, taskDoc);
  const revisions = new Map<string, string>();
  for (const entry of entries) {
    if (!linked.includes(entry.page) || !["verified", "failed", "untested"].includes(entry.status) ||
      typeof entry.proof !== "string" || !entry.proof.trim() ||
      (entry.status === "verified" && (!entry.route?.trim() || !entry.viewport?.trim() || !entry.state?.trim()))) {
      throw new Error(`Evidence for ${entry.page}/${entry.check} needs a valid status and proof; verified checks also need route, viewport and state`);
    }
    const reference = references.find((item) => item.page === entry.page);
    if (!reference?.checks.some((check) => check.id === entry.check)) {
      throw new Error(`Unknown visual acceptance check: ${entry.page}/${entry.check}`);
    }
    if (!revisions.has(entry.page)) {
      revisions.set(entry.page, await pageRevision(dir, entry.page));
    }
    records.push({ ...entry, task, revision: revisions.get(entry.page) ?? "" });
  }
  return records;
}

export async function recordVisualEvidence(
  dir: string,
  task: string,
  taskDoc: string,
  entries: VisualEvidence[],
): Promise<EvidenceRecord[]> {
  return withVisualReferenceLock(dir, async () => {
    const records = await validateVisualEvidenceForTask(dir, task, taskDoc, entries);
    const store = await readStore(dir);
    const next: EvidenceStore = {
      version: 1,
      records: [...store.records.filter((item) => item.task !== task), ...records],
    };
    const file = storePath(dir);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return records;
  });
}

export async function visualEvidenceStatus(dir: string, detect: CampDetect): Promise<EvidenceStatus> {
  let store: EvidenceStore;
  try {
    store = await readStore(dir);
  } catch (error) {
    return { verified: [], untested: [], issues: [`Cannot read visual verification: ${String(error)}`] };
  }
  const tasks = (await detect.pendingTasks(dir)).filter((task) => task.done);
  const verified: EvidenceRecord[] = [];
  const untested: EvidenceRecord[] = [];
  const issues: string[] = [];
  const revisions = new Map<string, string>();
  for (const task of tasks) {
    const doc = await readFile(join(dir, task.path), "utf8");
    for (const { page, id } of taskChecks(doc)) {
      if (!revisions.has(page)) {
        revisions.set(page, await pageRevision(dir, page));
      }
      const record = store.records.find((entry) => entry.task === task.path && entry.page === page && entry.check === id);
      if (!record) {
        issues.push(`Missing evidence for ${page}/${id} (${task.path})`);
      } else if (record.revision !== revisions.get(page)) {
        issues.push(`Stale evidence for ${page}/${id} (${task.path}) — reverify the changed reference`);
      } else if (record.status === "failed") {
        issues.push(`Failed check ${page}/${id} (${task.path}): ${record.proof}`);
      } else if (record.status === "untested") {
        untested.push(record);
      } else {
        verified.push(record);
      }
    }
  }
  return { verified, untested, issues };
}
