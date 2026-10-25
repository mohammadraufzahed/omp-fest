import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withStaleAwareLock } from "./fs-lock.js";

export type FlowFieldKind = "username" | "secret" | "otp" | "text" | "choice" | "confirmation";
export interface BrowserFlowField { id: string; label: string; kind: FlowFieldKind; required: boolean; choices?: string[]; selector?: string; credentialRef?: string }
export interface BrowserLoginFlow {
  id: string; revision: string; name: string; origin: string; path: string;
  fields: BrowserFlowField[];
  selectors: { username: string; password: string; submit: string; otp?: string; success: string };
  credentialRef?: string; updatedAt: string;
}
export interface BrowserFlowInput { name: string; origin: string; path?: string; fields: BrowserFlowField[]; selectors: BrowserLoginFlow["selectors"]; credentialRef?: string }

function slug(value: string) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return true;
  return false;
}
function safeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Flow origin must be an HTTPS origin only; do not include credentials, path, query, or fragment.");
  return url.origin;
}
function canonicalInput(input: BrowserFlowInput): BrowserFlowInput {
  return {
    name: input.name, origin: input.origin, path: input.path ?? "/",
    fields: input.fields.map(({ id, label, kind, required, choices, selector, credentialRef }) => ({ id, label, kind, required, ...(choices ? { choices: [...choices] } : {}), ...(selector ? { selector } : {}), ...(credentialRef ? { credentialRef } : {}) })),
    selectors: { username: input.selectors.username, password: input.selectors.password, submit: input.selectors.submit, ...(input.selectors.otp ? { otp: input.selectors.otp } : {}), success: input.selectors.success },
    ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
  };
}
function validateInput(raw: BrowserFlowInput): BrowserFlowInput {
  const input = canonicalInput(raw);
  if (!slug(input.name)) throw new Error("Flow name must be a lowercase slug.");
  const origin = safeOrigin(input.origin);
  if (!input.path?.startsWith("/") || input.path.startsWith("//") || input.path.includes("\\")) throw new Error("Flow path must be an origin-relative path.");
  if (!input.selectors.username || !input.selectors.password || !input.selectors.submit || !input.selectors.success) throw new Error("Username, password, submit, and authenticated-success selectors are required.");
  if (new Set(input.fields.map((field) => field.id)).size !== input.fields.length) throw new Error("Flow field IDs must be unique.");
  for (const field of input.fields) {
    if (!slug(field.id) || !field.label.trim() || hasControl(field.label) || !["username", "secret", "otp", "text", "choice", "confirmation"].includes(field.kind)) throw new Error("Flow fields need a stable ID, safe label, and supported kind.");
    if (field.kind === "choice" && (!field.choices?.length || field.choices.some((item) => !item.trim() || hasControl(item)))) throw new Error("Choice fields need safe explicit options.");
    if (field.kind !== "secret" && field.kind !== "otp" && field.credentialRef) throw new Error("Only secrets and OTPs may use credential references.");
  }
  return { ...input, origin };
}
async function directory(root: string): Promise<string> {
  const base = await realpath(root); let current = base;
  for (const part of [".ompfest", "flows"]) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe browser-flow storage directory.");
  }
  return current;
}
function pathOf(dir: string, id: string) { if (!slug(id)) throw new Error("Invalid flow ID."); return join(dir, `${id}.flow.json`); }
export async function createBrowserFlow(root: string, input: BrowserFlowInput) {
  const dir = await directory(root), clean = validateInput(input), id = clean.name, path = pathOf(dir, id);
  const flow: BrowserLoginFlow = { ...clean, path: clean.path ?? "/", id, revision: `${createHash("sha256").update(JSON.stringify(clean)).digest("hex")}-${randomUUID()}`, updatedAt: new Date().toISOString() };
  await writeFile(path, JSON.stringify(flow, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return flow;
}
export async function readBrowserFlow(root: string, id: string): Promise<BrowserLoginFlow> {
  const dir = await directory(root), path = pathOf(dir, id), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error("Unsafe or oversized browser flow.");
  const flow = JSON.parse(await readFile(path, "utf8")) as BrowserLoginFlow;
  if (flow.id !== id || !flow.revision.startsWith(`${createHash("sha256").update(JSON.stringify(validateInput(flow))).digest("hex")}-`) || !/^[a-f0-9-]{36}$/.test(flow.revision.slice(65))) throw new Error("Browser flow is corrupt or has been modified outside its revision.");
  return flow;
}
export async function listBrowserFlows(root: string) {
  const dir = await directory(root), entries = await readdir(dir);
  return Promise.all(entries.filter((entry) => entry.endsWith(".flow.json")).sort().map((entry) => readBrowserFlow(root, entry.slice(0, -".flow.json".length))));
}
export async function updateBrowserFlow(root: string, id: string, revision: string, patch: Partial<BrowserFlowInput>) {
  const dir = await directory(root), path = pathOf(dir, id);
  try {
    return await withStaleAwareLock(`${path}.lock`, async () => {
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        const prior = await readBrowserFlow(root, id); if (prior.revision !== revision) throw new Error("Stale flow revision; reread before editing.");
        const clean = validateInput({ ...prior, ...patch, name: id });
        const flow: BrowserLoginFlow = { ...clean, path: clean.path ?? "/", id, revision: `${createHash("sha256").update(JSON.stringify(clean)).digest("hex")}-${randomUUID()}`, updatedAt: new Date().toISOString() };
        await writeFile(temp, JSON.stringify(flow, null, 2) + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, path); return flow;
      } finally { await unlink(temp).catch(() => undefined); }
    }, { label: "Browser flow" });
  } catch (error) {
    if (error instanceof Error && error.name === "LockBusyError") throw new Error("Flow is being edited; reread its revision.", { cause: error });
    throw error;
  }
}
export async function deleteBrowserFlow(root: string, id: string, revision: string) {
  const flow = await readBrowserFlow(root, id); if (flow.revision !== revision) throw new Error("Stale flow revision; reread before deleting.");
  await unlink(pathOf(await directory(root), id));
}

export interface FlowBrowser {
  open(url: string, configuredOrigin: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  visible(selector: string): Promise<boolean>;
  close(): Promise<void>;
}
export interface FlowInputProvider { ask(field: BrowserFlowField): Promise<string | undefined>; getCredential(reference: string): Promise<string | undefined> }
export async function runBrowserFlow(flow: BrowserLoginFlow, browser: FlowBrowser, inputs: FlowInputProvider, checkpoint?: { submitted: boolean; onSubmitted?: () => Promise<void> }): Promise<{ status: "authenticated" | "needs_otp" | "cancelled" | "failed"; reason?: string }> {
  const origin = safeOrigin(flow.origin), url = new URL(flow.path || "/", origin);
  if (url.origin !== origin) return { status: "failed", reason: "Navigation escaped the configured origin." };
  if (checkpoint?.submitted) {
    try {
      await browser.open(url.toString(), origin);
      return await browser.visible(flow.selectors.success)
        ? { status: "authenticated" }
        : { status: "failed", reason: "Previous submission is uncertain in a fresh browser; verify the site manually before explicitly restarting." };
    } catch { return { status: "failed", reason: "Could not verify prior authentication state. Do not resubmit automatically." }; }
  }
  const values = new Map<string, string>();
  const otpField = flow.fields.find((field) => field.kind === "otp");
  for (const field of flow.fields.filter((row) => row.kind !== "otp")) {
    let value = field.credentialRef ? await inputs.getCredential(field.credentialRef) : undefined;
    if (value === undefined && field.kind === "secret" && flow.credentialRef) value = await inputs.getCredential(flow.credentialRef);
    value ??= await inputs.ask(field);
    if (value === undefined) return { status: "cancelled" };
    if (field.kind === "confirmation" && !/^(?:yes|y|confirm)$/i.test(value.trim())) return { status: "cancelled" };
    if (field.kind === "choice" && !field.choices?.includes(value)) return { status: "failed", reason: "Invalid choice." };
    if (!value && field.required) return { status: "failed", reason: `Required input missing: ${field.id}` };
    values.set(field.id, value);
  }
  const user = flow.fields.find((field) => field.kind === "username"), pass = flow.fields.find((field) => field.kind === "secret");
  if (!user || !pass) return { status: "failed", reason: "Flow requires username and secret fields." };
  try {
    await browser.open(url.toString(), origin);
    for (const field of flow.fields.filter((row) => row.kind !== "otp")) {
      const selector = field.kind === "username" ? flow.selectors.username : field.kind === "secret" ? flow.selectors.password : field.selector;
      if (selector && field.kind !== "confirmation") await browser.fill(selector, values.get(field.id) ?? "");
    }
    if (checkpoint) { checkpoint.submitted = true; await checkpoint.onSubmitted?.(); }
    await browser.click(flow.selectors.submit);
    if (flow.selectors.otp && await browser.visible(flow.selectors.otp)) {
      if (!otpField) return { status: "needs_otp", reason: "OTP challenge detected; add an OTP input field and resume after verifying state." };
      const code = await inputs.ask(otpField); if (!code) return { status: "needs_otp" };
      await browser.fill(flow.selectors.otp, code);
      if (checkpoint) await checkpoint.onSubmitted?.();
      await browser.click(flow.selectors.submit);
    }
    return await browser.visible(flow.selectors.success) ? { status: "authenticated" } : { status: "failed", reason: "Configured authenticated-success condition was not observed." };
  } catch { return { status: "failed", reason: "Browser operation failed; sensitive values were not included in the error." }; }
}

export function safeFlowError(_error: unknown) { return { code: "FLOW_FAILED", nextAction: "Check the configured origin, browser connection, selectors, and authentication state; retry only after verifying whether submission occurred." }; }
