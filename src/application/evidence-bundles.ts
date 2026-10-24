import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface EvidenceAttachment { path: string; sha256: string; bytes: number }
export interface EvidenceBundleInput {
  kind: "integration" | "visual" | "worker" | "release";
  summary: string;
  details: string;
  attachments?: string[];
}
export interface EvidenceBundle {
  id: string;
  kind: EvidenceBundleInput["kind"];
  summary: string;
  details: string;
  attachments: EvidenceAttachment[];
  createdAt: string;
}

export async function evidenceDirectory(festivalDir: string): Promise<string> {
  const root = await realpath(festivalDir);
  let current = root;
  for (const part of [".ompfest", "evidence"]) {
    current = join(current, part);
    await mkdir(current).catch((error: unknown) => {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Evidence storage must be a real directory, not a symlink");
  }
  return current;
}

export async function storeEvidenceBundle(festivalDir: string, input: EvidenceBundleInput) {
  if (!input.summary.trim() || input.summary.length > 600) throw new Error("Evidence summary must contain 1–600 characters");
  if (!input.details.trim() || Buffer.byteLength(input.details) > 2 * 1024 * 1024) throw new Error("Evidence details must be nonempty and at most 2 MiB");
  const root = await realpath(festivalDir);
  const attachments: EvidenceAttachment[] = [];
  for (const path of input.attachments ?? []) {
    if (isAbsolute(path)) throw new Error("Evidence attachment paths must be festival-relative");
    const target = await realpath(resolve(root, path));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Evidence attachment escapes festival");
    const info = await lstat(target);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Evidence attachment must be a regular file at most 32 MiB");
    const bytes = await readFile(target);
    attachments.push({ path: rel.split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
  }
  const id = randomUUID();
  const bundle: EvidenceBundle = { id, kind: input.kind, summary: input.summary, details: input.details, attachments, createdAt: new Date().toISOString() };
  const directory = await evidenceDirectory(root);
  const path = join(directory, `${id}.json`);
  await writeFile(path, JSON.stringify(bundle, null, 2), { flag: "wx", mode: 0o600 });
  return { id, path, summary: input.summary, kind: input.kind, attachments };
}

export async function readEvidenceBundle(festivalDir: string, id: string): Promise<EvidenceBundle> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid evidence id");
  const path = join(await evidenceDirectory(festivalDir), `${id}.json`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 3 * 1024 * 1024) throw new Error("Unsafe evidence bundle");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || !("id" in value) || value.id !== id || !("summary" in value) || typeof value.summary !== "string" || !("details" in value) || typeof value.details !== "string" || !("attachments" in value) || !Array.isArray(value.attachments) || !("kind" in value) || !["integration", "visual", "worker", "release"].includes(String(value.kind))) throw new Error("Invalid evidence bundle");
  return value as EvidenceBundle;
}
