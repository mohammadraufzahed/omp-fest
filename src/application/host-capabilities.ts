/** Supported omp discovery contract, inspected against upstream extensions/types.ts.
 * getAllTools exposes schemas/provenance, not an executor. Never infer an executor,
 * password input, or credential store from a tool name or plain ui.input.
 */
export interface HostToolMetadata {
  name: string;
  description?: string;
  parameters?: unknown;
  sourceInfo?: { source: string; path: string; scope?: string; origin?: string };
}
export interface FlowUi {
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined>;
  confirm?(title: string, message: string): Promise<boolean>;
}
export interface BrowserCheckpoint {
  origin: string;
  path: string;
  authenticatedSelector: string;
}
export interface BrowserObservation {
  /** URL stays host-side. Must never include it in model-visible output. */
  url: string;
  availableSelectors: string[];
}
/** A trusted embedding may supply this bridge, never a model-callable MCP proxy.
 * Implementations MUST avoid transcript/tool-event logging of all supplied values,
 * atomically recheck allowedOrigins + expected URL before each action, and refuse
 * cross-origin frames, redirects and page changes. inspect must not return DOM.
 * verify must observe both the URL and the authenticated-only selector freshly.
 */
export interface ProtectedBrowserBridge {
  inspect(allowedOrigins: readonly string[]): Promise<BrowserObservation>;
  navigate(url: string, allowedOrigins: readonly string[]): Promise<void>;
  fill(request: { selector: string; value: string; expectedUrl: string; allowedOrigins: readonly string[] }): Promise<void>;
  click(request: { selector: string; expectedUrl: string; allowedOrigins: readonly string[] }): Promise<void>;
  verify(checkpoint: BrowserCheckpoint, allowedOrigins: readonly string[]): Promise<boolean>;
}
/** Provider operations and masked prompt MUST be private host-side operations with
 * no model/tool-event logging. References are opaque identifiers, never values.
 * Cookie/session state may only be stored internally by this protected provider.
 */
export interface ProtectedCredentialProvider {
  id: string;
  promptSecret(label: string, kind: "secret" | "otp"): Promise<string | undefined>;
  get(reference: string): Promise<string | undefined>;
  save(value: string, binding: { flowId: string; inputId: string; origins: readonly string[] }): Promise<string>;
  saveBrowserSession?(binding: { flowId: string; origins: readonly string[] }): Promise<string>;
  restoreBrowserSession?(reference: string, binding: { flowId: string; origins: readonly string[] }): Promise<void>;
}
export interface FlowHostBridge {
  /** Bind to the actual supported pi.getAllTools API, if present. */
  getAllTools?(): HostToolMetadata[];
  getActiveTools?(): string[];
  browser?: ProtectedBrowserBridge;
  credentials?: ProtectedCredentialProvider;
}
export function discoverHostCapabilities(host: FlowHostBridge = {}) {
  let tools: HostToolMetadata[] = [];
  let metadataAvailable = false;
  try { if (host.getAllTools) { tools = host.getAllTools(); metadataAvailable = true; } } catch { /* unsupported discovery stays unavailable */ }
  const browserTools = tools.filter((tool) => tool.sourceInfo?.source === "mcp" &&
    /playwright|browser/i.test(`${tool.name} ${tool.description ?? ""} ${tool.sourceInfo.path}`));
  const sorted = [...browserTools].sort((a, b) => Number(/playwright/i.test(`${b.name} ${b.sourceInfo?.path}`)) - Number(/playwright/i.test(`${a.name} ${a.sourceInfo?.path}`)) || a.name.localeCompare(b.name));
  let active: string[] = [];
  try { active = host.getActiveTools?.() ?? []; } catch { /* discovery must not expose host errors */ }
  return {
    kind: "fest_capabilities" as const,
    metadataAvailable,
    browserTools: sorted.map((tool) => ({ name: tool.name, source: "mcp", preferred: /playwright/i.test(`${tool.name} ${tool.sourceInfo?.path}`), active: active.includes(tool.name) })),
    execution: host.browser ? "protected_host_bridge" : "manual_browser",
    secretInput: host.browser && host.credentials ? "protected_native_prompt" : "manual_browser_only",
    credentialStorage: host.browser && host.credentials ? "explicit_consent_protected_provider" : "unavailable",
    persistentSessions: !!(host.browser && host.credentials?.saveBrowserSession && host.credentials.restoreBrowserSession),
    guidance: "Tool metadata is discovery only, not permission to execute tools. Without a protected host bridge, use /fest flows and enter credentials directly in the browser; checkpoint confirmation is explicitly human-attested.",
  };
}
