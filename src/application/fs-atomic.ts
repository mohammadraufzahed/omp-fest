import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Write `content` to `path` via a temp file + rename so readers never see a partial file. */
export async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error: unknown) => { if (errorCode(error) !== "ENOENT") throw error; }); }
}
