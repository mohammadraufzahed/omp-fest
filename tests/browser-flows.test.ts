import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHostCapabilities, inspectFlowUi } from "../src/application/host-capabilities.js";
import { createBrowserFlow, deleteBrowserFlow, readBrowserFlow, updateBrowserFlow, runBrowserFlow, type FlowBrowser } from "../src/application/browser-flows.js";
import { clearFlowCheckpoint, flowSubmissionCheckpoint, markFlowSubmitted } from "../src/application/browser-flow-state.js";
import { createGuardedBrowser, openIsolatedBrowser, playwrightAvailable } from "../src/adapters/omp/playwright-browser.js";

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
  return { open: (url, origin) => { calls.push(`open:${url}`); return new URL(url).origin === origin ? Promise.resolve() : Promise.reject(Error("origin")); }, fill: (selector, value) => { calls.push(`fill:${selector}:${value}`); return Promise.resolve(); }, click: (selector) => { calls.push(`click:${selector}`); return Promise.resolve(); }, visible: (selector) => Promise.resolve(selector === "#otp" ? state.otp : state.success), close: () => { calls.push("close"); return Promise.resolve(); } };
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
    expect(JSON.stringify(result)).not.toContain("123456");
  });
  it("does not resubmit an uncertain checkpoint and ignores a stale revision", async () => {
    const { root, flow } = await fixture(); const calls: string[] = [];
    await markFlowSubmitted(root, flow.id, "session-a", flow.revision);
    expect(await flowSubmissionCheckpoint(root, flow.id, "session-a", flow.revision)).toBe(true);
    expect(await flowSubmissionCheckpoint(root, flow.id, "session-a", "stale-revision")).toBe(false);
    const result = await runBrowserFlow(flow, browser(calls), { ask: () => Promise.reject(Error("must not ask again")), getCredential: () => Promise.resolve(undefined) }, { submitted: true });
    expect(result.status).toBe("failed");
    expect(calls.filter((call) => call.startsWith("click:"))).toHaveLength(0);
    const updated = await updateBrowserFlow(root, flow.id, flow.revision, { path: "/updated" });
    expect(updated.revision).not.toBe(flow.revision);
    expect(await flowSubmissionCheckpoint(root, flow.id, "session-a", updated.revision)).toBe(false);
    await clearFlowCheckpoint(root, flow.id, "session-a");
    expect(await flowSubmissionCheckpoint(root, flow.id, "session-a", flow.revision)).toBe(false);
  });
  it("persists an uncertain submit before the click and never retries it", async () => {
    const { root, flow } = await fixture(); const calls: string[] = [];
    const subject = browser(calls);
    subject.click = (selector) => { calls.push(`click:${selector}`); return Promise.reject(Error("response lost after submit")); };
    const result = await runBrowserFlow(flow, subject, { ask: (field) => Promise.resolve(field.kind === "username" ? "person" : field.kind === "secret" ? "private" : undefined), getCredential: () => Promise.resolve(undefined) }, {
      submitted: false, onSubmitted: () => markFlowSubmitted(root, flow.id, "uncertain", flow.revision),
    });
    expect(result.status).toBe("failed");
    expect(await flowSubmissionCheckpoint(root, flow.id, "uncertain", flow.revision)).toBe(true);
    const retryCalls: string[] = [];
    const retry = await runBrowserFlow(flow, browser(retryCalls), { ask: () => Promise.reject(Error("must not prompt")), getCredential: () => Promise.resolve(undefined) }, { submitted: true });
    expect(retry.status).toBe("failed");
    expect(retryCalls.filter((call) => call.startsWith("click:"))).toHaveLength(0);
  });
  it("does not authorize a checkpoint after deleting and recreating the same flow", async () => {
    const { root, flow } = await fixture();
    await markFlowSubmitted(root, flow.id, "recreated", flow.revision);
    await deleteBrowserFlow(root, flow.id, flow.revision);
    const recreated = await createBrowserFlow(root, { name: flow.id, origin: flow.origin, path: flow.path, fields: flow.fields, selectors: flow.selectors });
    expect(recreated.revision).not.toBe(flow.revision);
    expect(await flowSubmissionCheckpoint(root, flow.id, "recreated", recreated.revision)).toBe(false);
  });
  it("cancellation before submission causes no browser action", async () => {
    const { flow } = await fixture(); const calls: string[] = [];
    const result = await runBrowserFlow(flow, browser(calls), { ask: () => Promise.resolve(undefined), getCredential: () => Promise.resolve(undefined) });
    expect(result.status).toBe("cancelled"); expect(calls).toEqual([]);
  });
  it("launches the isolated local browser and rejects non-HTTPS navigation", async () => {
    if (!(await playwrightAvailable())) return;
    const instance = await openIsolatedBrowser();
    try {
      await expect(instance.open("http://example.com/login", "https://example.com")).rejects.toThrow("Unsafe browser navigation");
      await expect(instance.open("https://evil.example/login", "https://health.example")).rejects.toThrow("Unsafe browser navigation");
    }
    finally { await instance.close(); }
  }, 20_000);
  it("reports only supported shared host and masked-input capabilities", () => {
    expect(inspectFlowUi({ input: () => Promise.resolve(undefined), confirm: () => Promise.resolve(false), onTerminalInput: () => () => undefined, setWidget: () => undefined })).toEqual({ input: true, confirm: true, maskedInput: true });
    const caps = discoverHostCapabilities({
      getAllTools: () => [
        { name: "browser_action", sourceInfo: { source: "mcp" } },
        { name: "unrelated", sourceInfo: { source: "extension" } },
      ],
      getActiveTools: () => ["browser_action"],
    });
    expect(caps.metadataAvailable).toBe(true);
    expect(caps.browserTools).toEqual([{ name: "browser_action", source: "mcp", preferred: false, active: true }]);
    expect(caps.execution).toBe("manual_browser");
    expect(caps.secretInput).toBe("manual_browser_only");
  });
  it("halts redirects, popups, and later actions at the Playwright adapter boundary", async () => {
    const actions: string[] = [];
    let redirectOnOpen = false;
    let onPage: ((page: { close(): Promise<void> }) => void) | undefined;
    let routeRequest: ((route: { request(): { url(): string; isNavigationRequest(): boolean }; abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>) | undefined;
    let currentUrl = "about:blank";
    const frame = { url: () => currentUrl };
    const pageHandlers: { framenavigated?: (frame: unknown) => void } = {};
    const context = {
      route: (_pattern: string, handler: typeof routeRequest) => { routeRequest = handler; return Promise.resolve(); },
      on: (_event: string, handler: typeof onPage) => { onPage = handler; },
      close: () => Promise.resolve(),
    };
    const page = {
      on: (_event: string, handler: (frame: unknown) => void) => { pageHandlers.framenavigated = handler; },
      mainFrame: () => frame,
      url: () => currentUrl,
      goto: async (url: string) => {
        currentUrl = url;
        if (redirectOnOpen) await routeRequest?.({ request: () => ({ url: () => "https://evil.example/redirected", isNavigationRequest: () => true }), abort: () => Promise.resolve(), continue: () => Promise.resolve() });
        pageHandlers.framenavigated?.(frame);
      },
      locator: (selector: string) => ({
        fill: () => { actions.push(`fill:${selector}`); return Promise.resolve(); },
        click: async () => {
          actions.push(`click:${selector}`);
          if (selector === "#redirect") await routeRequest?.({ request: () => ({ url: () => "https://evil.example/landing", isNavigationRequest: () => true }), abort: () => Promise.resolve(), continue: () => Promise.resolve() });
          if (selector === "#popup") onPage?.({ close: () => Promise.resolve() });
        },
        first() { return this; },
        isVisible: () => Promise.resolve(true),
      }),
    };
    const guarded = await createGuardedBrowser({ close: () => Promise.resolve() } as never, context as never, page as never);
    await guarded.open("https://health.example/login", "https://health.example");
    await expect(guarded.click("#redirect")).rejects.toThrow("escaped");
    expect(actions).toEqual(["click:#redirect"]);
    await expect(guarded.fill("#password", "never logged")).rejects.toThrow("escaped");
    expect(actions).toEqual(["click:#redirect"]);

    currentUrl = "about:blank";
    const popupGuarded = await createGuardedBrowser({ close: () => Promise.resolve() } as never, context as never, page as never);
    await popupGuarded.open("https://health.example/login", "https://health.example");
    await expect(popupGuarded.click("#popup")).rejects.toThrow("escaped");
    expect(actions).toEqual(["click:#redirect", "click:#popup"]);
    currentUrl = "about:blank";
    redirectOnOpen = true;
    const redirectGuarded = await createGuardedBrowser({ close: () => Promise.resolve() } as never, context as never, page as never);
    await expect(redirectGuarded.open("https://health.example/login", "https://health.example")).rejects.toThrow("escaped");
  });
});
