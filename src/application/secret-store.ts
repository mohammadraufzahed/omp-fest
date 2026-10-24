import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function run(args: string[], secret?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("secret-tool", args, { stdio: ["pipe", "pipe", "ignore"], shell: false });
    let output = ""; child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.on("error", () => { resolve(undefined); });
    child.on("close", (code) => { resolve(code === 0 ? output.replace(/\r?\n$/, "") : undefined); });
    if (secret !== undefined) child.stdin.end(`${secret}\n`); else child.stdin.end();
  });
}
export async function secureCredentialStoreAvailable(): Promise<boolean> {
  return (await run(["--version"])) !== undefined;
}
export async function storeCredential(secret: string): Promise<string | undefined> {
  if (!secret || secret.includes("\0")) return undefined;
  const reference = randomUUID();
  const child = spawn("secret-tool", ["store", "--label=omp-fest credential", "service", "omp-fest", "credential", reference], { stdio: ["pipe", "ignore", "ignore"], shell: false });
  return new Promise((resolve) => {
    child.on("error", () => { resolve(undefined); });
    child.on("close", (code) => { resolve(code === 0 ? reference : undefined); });
    child.stdin.end(`${secret}\n`);
  });
}
export async function readCredential(reference: string): Promise<string | undefined> {
  if (!/^[a-f0-9-]{36}$/.test(reference)) return undefined;
  return run(["lookup", "service", "omp-fest", "credential", reference]);
}
export async function deleteCredential(reference: string): Promise<boolean> {
  if (!/^[a-f0-9-]{36}$/.test(reference)) return false;
  const result = await run(["clear", "service", "omp-fest", "credential", reference]);
  return result !== undefined;
}
