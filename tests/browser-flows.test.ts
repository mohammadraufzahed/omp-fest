import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserFlow, readBrowserFlow, updateBrowserFlow, runBrowserFlow, type FlowBrowser } from "../src/application/browser-flows.js";
import { clearFlowCheckpoint, flowSubmissionCheckpoint, markFlowSubmitted } from "../src/application/browser-flow-state.js";
import { openIsolatedBrowser, playwrightAvailable } from "../src/adapters/omp/playwright-browser.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "browser-flow-")); roots.push(root);
  const flow = await createBrowserFlow(root, { name: "health-login", origin: "https://health.example", path: "/login", fields: [
    { id: "user", label: "Username", kind: "username", required: true },
    { id: "pass", label: "Password", kind: "secret", required: true },
    { id: "code", label: "One-time code", kind: "otp", required: false },
  ], selectors: { username: "#user", password: "#password", submit: "button[type=submit]", otp: "#otp", success: "[data-authenticated=true]" } });
  return { root, flow };
}
function browser(calls: string[], state: { otp: boolean; success: boolean } = { otp: true, success: false }): FlowBrowser {
  return { open: (url) => { calls.push(`open:${url}`); return url.startsWith("https://health.example/") ? Promise.resolve() : Promise.reject(Error("origin")); }, fill: (selector, value) => { calls.push(`fill:${selector}:${value}`); return Promise.resolve(); }, click: (selector) => { calls.push(`click:${selector}`); return Promise.resolve(); }, visible: (selector) => Promise.resolve(selector === "#otp" ? state.otp : state.success), close: () => { calls.push("close"); return Promise.resolve(); } };
}
describe("persisted browser flows", () => {
  it("stores procedure only, rejects origin escape and protects stale edits", async () => {
    const { root, flow } = await fixture();
    const path = join(root, ".ompfest", "flows", "health-login.flow.json");
    expect(await readFile(path, "utf8")).not.toMatch(/password-value|one-time-code-value/);
    expect((await readBrowserFlow(root, flow.id)).revision).toBe(flow.revision);
    await expect(updateBrowserFlow(root, flow.id, "stale", { path: "/secure" })).rejects.toThrow("Stale flow revision");
    await expect(updateBrowserFlow(root, flow.id, flow.revision, { origin: "https://evil.example/path" })).rejects.toThrow("HTTPS origin");
  });
  it("asks for OTP only after login submission and never claims unverified authentication", async () => {
    const { flow } = await fixture(); const calls: string[] = [];
    let submitted = false;
    const result = await runBrowserFlow(flow, browser(calls), { ask: (field) => { if (field.kind === "otp") expect(submitted).toBe(true); return Promise.resolve(field.kind === "username" ? "person" : field.kind === "secret" ? "private" : "123456"); }, getCredential: () => Promise.resolve(undefined) }, { submitted: false, onSubmitted: () => { submitted = true; return Promise.resolve(); } });
    expect(result.status).toBe("failed");
    expect(calls).toContain("click:button[type=submit]");
    expect(calls).toContain("fill:#otp:123456");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not resubmit an uncertain checkpoint", async () => {
    const { root, flow } = await fixture(); const calls: string[] = [];
    await markFlowSubmitted(root, flow.id, "session-a");
    expect(await flowSubmissionCheckpoint(root, flow.id, "session-a")).toBe(true);
    const result = await runBrowserFlow(flow, browser(calls), { ask: () => Promise.reject(Error("must not ask again")), getCredential: () => Promise.resolve(undefined) }, { submitted: true });
    expect(result.status).toBe("failed");
    expect(calls.filter((call) => call.startsWith("click:"))).toHaveLength(0);
    await clearFlowCheckpoint(root, flow.id, "session-a");
    expect(await flowSubmissionCheckpoint(root, flow.id, "session-a")).toBe(false);
  });
  it("cancellation before submission causes no browser action", async () => {
    const { flow } = await fixture(); const calls: string[] = [];
    const result = await runBrowserFlow(flow, browser(calls), { ask: () => Promise.resolve(undefined), getCredential: () => Promise.resolve(undefined) });
    expect(result.status).toBe("cancelled"); expect(calls).toEqual([]);
  });
  it("launches the isolated local browser and rejects non-HTTPS navigation", async () => {
    if (!(await playwrightAvailable())) return;
    const instance = await openIsolatedBrowser();
    try { await expect(instance.open("http://example.com/login")).rejects.toThrow("Unsafe browser navigation"); }
    finally { await instance.close(); }
  });
});
