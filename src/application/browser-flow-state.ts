import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
async function statePath(root: string, flow: string, session: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(flow) || !session) throw new Error("Invalid flow checkpoint identity.");
  const base = await realpath(root); let dir = base;
  for (const part of [".ompfest", "flow-runs"]) {
    dir = join(dir, part);
    await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(dir); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe flow checkpoint directory.");
  }
  return join(dir, `${flow}-${createHash("sha256").update(session).digest("hex")}.json`);
}
export async function flowSubmissionCheckpoint(root: string, flow: string, session: string, revision: string): Promise<boolean> {
  const path = await statePath(root, flow, session);
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Unsafe flow checkpoint.");
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!data || typeof data !== "object" || !("submitted" in data) || typeof data.submitted !== "boolean" || !("revision" in data) || typeof data.revision !== "string") throw new Error("Corrupt flow checkpoint; block automatic retry.");
    return data.revision === revision && data.submitted;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function markFlowSubmitted(root: string, flow: string, session: string, revision: string): Promise<void> {
  const path = await statePath(root, flow, session), temp = `${path}.${randomUUID()}.tmp`;
  const existing = await lstat(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe flow checkpoint.");
  try { const file = await open(temp, "wx", 0o600); try { await file.writeFile(JSON.stringify({ submitted: true, revision, at: new Date().toISOString() })); } finally { await file.close(); } await rename(temp, path); }
  finally { await unlink(temp).catch(() => undefined); }
}
export async function clearFlowCheckpoint(root: string, flow: string, session: string): Promise<void> {
  await unlink(await statePath(root, flow, session)).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}
