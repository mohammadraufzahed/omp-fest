import { createBrowserFlow, deleteBrowserFlow, listBrowserFlows, readBrowserFlow, runBrowserFlow, updateBrowserFlow, type BrowserFlowInput, type BrowserFlowField } from "../../application/browser-flows.js";
import { deleteCredential, readCredential, secureCredentialStoreAvailable, storeCredential } from "../../application/secret-store.js";
import { openIsolatedBrowser, playwrightAvailable } from "./playwright-browser.js";
import type { CampDetect } from "../../ports.js";
import { clearFlowCheckpoint, flowSubmissionCheckpoint, markFlowSubmitted } from "../../application/browser-flow-state.js";
import type { ZodLike } from "./zod-types.js";
import { discoverHostCapabilities, inspectFlowUi, type FlowUi, type HostToolMetadata } from "../../application/host-capabilities.js";
import { loadConfig } from "../../domain/config.js";
import { conventionsEcho } from "../../application/conventions.js";
import { DEFAULT_CONVENTIONS } from "../../domain/types.js";
interface FlowContext { cwd: string; ui?: FlowUi; sessionManager?: { getSessionId?(): string }; agent?: { kind?: string }; getAsyncJobSnapshot?(): { running?: { id: string; type: string; status: string; label: string; agentId?: string }[]; recent?: { id: string; type: string; status: string; label: string; agentId?: string }[] } | null }
export interface FlowHost { zod: ZodLike; registerTool(tool: Record<string, unknown>): void; getAllTools?(): HostToolMetadata[]; getActiveTools?(): string[] }
interface FlowDeps { detect: CampDetect; host?: Pick<FlowHost, "getAllTools" | "getActiveTools"> }
function out(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value) }] }; }
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return true;
  return false;
}
function maskedInput(ui: FlowUi, label: string): Promise<string | undefined> {
  const onTerminalInput = ui.onTerminalInput?.bind(ui), setWidget = ui.setWidget?.bind(ui);
  if (!onTerminalInput || !setWidget) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let value = "", finished = false;
    const cleanup: { unsubscribe?: () => void } = {};
    const finish = (result: string | undefined) => {
      if (finished) return;
      finished = true; clearTimeout(timer); cleanup.unsubscribe?.(); setWidget("omp-fest-secret-input", undefined); resolve(result);
    };
    const timer = setTimeout(() => { finish(undefined); }, 120_000);
    const render = () => { setWidget("omp-fest-secret-input", [`${label}: ${"*".repeat(value.length)}`, "Enter to submit · Esc to cancel"], { placement: "aboveEditor" }); };
    cleanup.unsubscribe = onTerminalInput((data) => {
      if (data === "\r" || data === "\n") { finish(value); return { consume: true }; }
      if (data === "\u001b") { finish(undefined); return { consume: true }; }
      if (data === "\u007f" || data === "\b") { value = value.slice(0, -1); render(); return { consume: true }; }
      if (!hasControl(data)) { value += data; render(); }
      return { consume: true };
    });
    render();
  });
}
function schema(z: ZodLike) {
  return z.object({ action: z.enum(["create", "read", "update", "list", "delete", "credential_delete", "run", "resume"]), id: z.string().optional(), revision: z.string().optional(), name: z.string().optional(), origin: z.string().optional(), path: z.string().optional(), fields: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(["username", "secret", "otp", "text", "choice", "confirmation"]), required: z.boolean(), choices: z.array(z.string()).optional(), selector: z.string().optional(), credentialRef: z.string().optional() })).optional(), selectors: z.object({ username: z.string(), password: z.string(), submit: z.string(), otp: z.string().optional(), success: z.string() }).optional(), credentialRef: z.string().optional() });
}
export function registerFlowTools(pi: FlowHost, deps: FlowDeps): void {
  const z = pi.zod;
  pi.registerTool({ name: "fest_capabilities", label: "Discover Fest Capabilities", description: "Report actual omp host UI, active browser MCP, current agent role/lifecycle and secure credential-store capabilities. Agent role is not a worker-launch capability check. Does not claim unsupported tool execution or secret injection. contract:true returns the ~800-token omp-fest agent contract (lifecycle, supervisor-only tools, error codes).", parameters: z.object({ contract: z.boolean().optional().describe("Return the agent contract instead of host capabilities") }), async execute(_id: string, params: { contract?: boolean }, _signal: unknown, _update: unknown, ctx: FlowContext) {
    if (params.contract) {
      const located = await deps.detect.locate(ctx.cwd);
      const conventions = located.campRoot
        ? conventionsEcho((await loadConfig(located.campRoot)).conventions)
        : conventionsEcho(DEFAULT_CONVENTIONS);
      return out({ kind: "agent_contract", contract: [
        "LIFECYCLE: idea -> plan (fest_plan draft/preview/approve) -> scaffold -> ready -> active -> completed.",
        "You are SUPERVISOR. Workers implement units you assign; they never drive the protocol.",
        "SUPERVISOR-ONLY tools (workers get blocked): fest_next, fest_commit, fest_gate_submit, fest_plan, fest_promote, fest_complete, fest_orphans, fest_advance.",
        "FLOW: camp_status (see all) -> fest_advance (one next action) -> do it -> repeat. Festivals end with fest_complete which merges worktrees and promotes to completed.",
        "GATES: never self-approve. fest_gate_submit opens a human decision dialog; headless returns status:awaiting_human — STOP and wait for /fest approve|reject.",
        "PLANNING: fest_plan(draft) -> preview -> human approves -> scaffold. Rejects produce a fresh revision; scaffold auto-resolves the latest approved preview.",
        "WORKTREES: promote->active creates projects/worktrees/<project>/<festival> (branch fest/<name>); fest_complete merges+removes them. Dirty/conflicting merges fail with code=WORKTREE_DIRTY/MERGE_CONFLICT.",
        "ERRORS: every failure is {kind, code, retryable, nextAction}. Read nextAction before retrying; retryable=true is safe to retry. Orphans are self-healing on retry.",
        "RECOVERY: crashed mid-scaffold? Retry — dead journals auto-clear. Stuck? camp_status -> fest_advance. Orphans? fest_orphans.",
        "CAMP RULES: <camp>/RULES.md applies to every festival (camp_rules tool to read/add/remove) — a violation fails gates. Festival files embed it in a marked block; edits sync on reconcile.",
        `CONVENTIONS: ${conventions} (camp_conventions tool / /fest conventions to change; commits are validated against commitStyle before fest_commit).`,
        "WRITES: inside camp/festival dirs use native path-bearing tools; shell file mutation is blocked unless writeLocks=false.",
      ].join("\n") });
    }
    const hostCapabilities = discoverHostCapabilities(deps.host), ui = inspectFlowUi(ctx.ui);
    const jobs = ctx.getAsyncJobSnapshot?.();
    return out({ kind: "host_capabilities", metadataAvailable: hostCapabilities.metadataAvailable, uiInput: ui.input, uiConfirm: ui.confirm, maskedInput: ui.maskedInput, agentRole: ctx.agent?.kind ?? "unknown", browserMcp: hostCapabilities.browserTools.map(({ name, active }) => ({ name, active })), nativeAgentJobs: jobs ? [...(jobs.running ?? []), ...(jobs.recent ?? [])].map(({ id, type, status, label, agentId }) => ({ id, type, status, label, agentId })) : null, localPlaywright: await playwrightAvailable(), secureCredentialStore: await secureCredentialStoreAvailable(), secretInjection: "host-local Playwright only; no MCP secret injection claimed", limitations: ["Secret/OTP values are captured by a native masked terminal handler and never returned in tool results.", "Persistent browser cookies/session state are not stored.", "Keyring save requires secret-tool; without it credentials are run-only."] });
  } });
  pi.registerTool({ name: "fest_flow", label: "Reusable Secure Browser Flow", description: "Persist HTTPS-origin-bound browser procedures, manage revisions and credential references, run with native UI prompts for credentials/OTP, or resume after explicit verification. Secrets never belong in tool arguments or results. Uses isolated Playwright browser, never reuses cookies. No CAPTCHA/security challenge bypass.", parameters: schema(z), async execute(_id: string, raw: unknown, _signal: unknown, _update: unknown, ctx: FlowContext) {
    const params = raw as { action: string; id?: string; revision?: string; name?: string; origin?: string; path?: string; fields?: BrowserFlowField[]; selectors?: BrowserFlowInput["selectors"]; credentialRef?: string };
    if (ctx.agent?.kind === "sub" && params.action !== "list" && params.action !== "read") {
      return out({ kind: "flow_blocked", code: "MAIN_AGENT_REQUIRED", nextAction: "Only the main supervisor may create, run, resume, mutate or delete credential-backed browser flows. Return required page evidence through the worker channel." });
    }
    const located = await deps.detect.locate(ctx.cwd), root = located.campRoot;
    if (!root) return out({ kind: "flow_failed", code: "NO_CAMP", field: "cwd", expected: "camp", nextAction: "Run this tool inside a camp." });
    try {
      if (params.action === "credential_delete") {
        if (!params.credentialRef || !/^[a-f0-9-]{36}$/.test(params.credentialRef)) return out({ kind: "flow_failed", code: "INVALID_CREDENTIAL_REFERENCE", nextAction: "Supply an existing opaque credential reference; secret values are never accepted." });
        if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Delete saved credential?", `Delete keyring entry ${params.credentialRef}? Flows that reference it will prompt again.`))) return out({ kind: "flow_cancelled" });
        return out({ kind: "credential_deleted", deleted: await deleteCredential(params.credentialRef), credentialRef: params.credentialRef });
      }
      if (params.action === "list") return out({ kind: "browser_flows", flows: (await listBrowserFlows(root)).map(({ id, revision, name, origin, updatedAt }) => ({ id, revision, name, origin, updatedAt })) });
      if (params.action === "read") { const f = await readBrowserFlow(root, params.id ?? ""); return out({ kind: "browser_flow", flow: f }); }
      if (params.action === "create") {
        const flow = await createBrowserFlow(root, { name: params.name ?? "", origin: params.origin ?? "", path: params.path, fields: params.fields ?? [], selectors: params.selectors ?? { username: "", password: "", submit: "", success: "" }, credentialRef: params.credentialRef });
        return out({ kind: "browser_flow_created", id: flow.id, revision: flow.revision, origin: flow.origin, fields: flow.fields.map(({ id, kind, label }) => ({ id, kind, label })), secretPolicy: "No secret values persisted; credentialRef must refer to OS keyring." });
      }
      if (params.action === "update") {
        const flow = await updateBrowserFlow(root, params.id ?? "", params.revision ?? "", { name: params.name, origin: params.origin, path: params.path, fields: params.fields, selectors: params.selectors, credentialRef: params.credentialRef });
        return out({ kind: "browser_flow_updated", id: flow.id, revision: flow.revision, origin: flow.origin });
      }
      if (params.action === "delete") { await deleteBrowserFlow(root, params.id ?? "", params.revision ?? ""); return out({ kind: "browser_flow_deleted", id: params.id }); }
      const flow = await readBrowserFlow(root, params.id ?? "");
      const ui = ctx.ui;
      if (!ui?.confirm || !ui.input || !ui.onTerminalInput || !ui.setWidget) return out({ kind: "flow_blocked", code: "NATIVE_UI_REQUIRED", nextAction: "Run in interactive omp TUI with masked terminal input; this host cannot securely request credentials." });
      const confirm = ui.confirm.bind(ui), input = ui.input.bind(ui);
      const resume = params.action === "resume", session = ctx.sessionManager?.getSessionId?.() ?? "unknown-session";
      let submitted = await flowSubmissionCheckpoint(root, flow.id, session, flow.revision);
      if (submitted && !resume) return out({ kind: "flow_resume_required", code: "SUBMISSION_UNCERTAIN", nextAction: "Call action resume. Never start a second submission automatically." });
      if (submitted && resume) {
        const confirmed = await confirm("Restart uncertain login?", "First inspect the website manually. Confirm only if the previous login/OTP was not accepted and retrying is safe.");
        if (!confirmed) return out({ kind: "flow_resume_blocked", code: "MANUAL_REVIEW_REQUIRED", nextAction: "Inspect the site. Retry only after confirming the prior submission did not succeed." });
        await clearFlowCheckpoint(root, flow.id, session); submitted = false;
      }
      if (!(await confirm(resume ? "Resume website flow" : "Run website flow", `Open ${flow.origin}${flow.path} in a fresh isolated browser? No existing cookies/session will be reused.`))) return out({ kind: "flow_cancelled" });
      const browser = await openIsolatedBrowser();
      let savedSecretRef: string | undefined;
      let result: Awaited<ReturnType<typeof runBrowserFlow>>;
      try {
        result = await runBrowserFlow(flow, browser, {
          ask: async (field) => {
            if (field.kind === "confirmation") return await confirm(field.label, `Confirm ${field.label}?`) ? "yes" : undefined;
            const answer = field.kind === "secret" || field.kind === "otp"
              ? await maskedInput(ui, field.label)
              : await input(`${field.label} (${field.kind})`, "Native omp input; never include this value in tool arguments or responses");
            if (answer && field.kind === "secret" && await secureCredentialStoreAvailable() && await confirm("Save credential?", "Store this credential in the OS keyring? The secret itself is never written to festival files.")) savedSecretRef = await storeCredential(answer);
            return answer;
          },
          getCredential: readCredential,
        }, { submitted, onSubmitted: () => markFlowSubmitted(root, flow.id, session, flow.revision) });
      } finally { await browser.close(); }
      if (result.status === "authenticated") await clearFlowCheckpoint(root, flow.id, session);
      if (savedSecretRef) {
        const current = await readBrowserFlow(root, flow.id);
        await updateBrowserFlow(root, flow.id, current.revision, { credentialRef: savedSecretRef });
      }
      return out({ kind: "browser_flow_result", id: flow.id, status: result.status, reason: result.reason, secretValuesReturned: false, browserStatePersisted: false, ...(savedSecretRef ? { credentialSaved: true } : {}) });
    } catch { return out({ kind: "flow_failed", code: "FLOW_ERROR", nextAction: "Inspect the configuration and browser state; do not retry if submission may already have occurred.", error: "Browser flow failed; sensitive values and underlying errors are withheld.", secretValuesReturned: false }); }
  } });
}
