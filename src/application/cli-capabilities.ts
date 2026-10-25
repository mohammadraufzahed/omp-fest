import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { ExecResult, ExecRunner } from "../ports.js";
import type { NativeBinary } from "./native-command-policy.js";

/** Installed versions inspected for this integration. Newer versions must also
 * satisfy every help probe; passing is not a claim of future CLI compatibility.
 */
export const REQUIRED_CLI_VERSIONS: Readonly<Record<NativeBinary, string>> = { fest: "0.9.8", camp: "0.16.2" };
export interface CliCapabilityProbe {
  id: string;
  command: string[];
  requiredFlags: string[];
  supported: boolean;
  code: number;
  diagnostic?: string;
}
export interface NativeCliCapabilities {
  executable: string;
  path?: string;
  version?: string;
  requiredVersion: string;
  available: boolean;
  compatible: boolean;
  ready: boolean;
  probes: CliCapabilityProbe[];
  diagnostics: string[];
}
export interface CliCapabilitiesReport {
  ready: boolean;
  binaries: Record<NativeBinary, NativeCliCapabilities>;
}
export interface CliCapabilityOptions {
  cwd?: string;
  executables?: Partial<Record<NativeBinary, string>>;
}
interface ProbeDefinition { id: string; args: string[]; flags: string[] }
const PROBES: Readonly<Record<NativeBinary, readonly ProbeDefinition[]>> = {
  fest: [
    { id: "next-json", args: ["next"], flags: ["--json"] },
    { id: "workflow-status-json", args: ["workflow", "status"], flags: ["--json"] },
    { id: "task-completion", args: ["task", "completed"], flags: ["--yes", "--json"] },
    { id: "validation-json", args: ["validate"], flags: ["--json", "--fix"] },
    { id: "planning-scaffold", args: ["scaffold", "from-plan"], flags: ["--plan", "--name", "--dest", "--dry-run", "--json"] },
    { id: "workflow-phase", args: ["workflow", "advance"], flags: ["--phase"] },
    { id: "status-json", args: ["status"], flags: ["--json"] },
  ],
  camp: [
    { id: "projects-json", args: ["project", "list"], flags: ["--json"] },
    { id: "worktrees-list", args: ["project", "worktree", "list"], flags: ["--project"] },
    { id: "ideas-json", args: ["idea", "list"], flags: ["--json"] },
    { id: "workitems-json", args: ["workitem", "list"], flags: ["--json"] },
    { id: "triage-review", args: ["triage", "apply"], flags: ["--dry-run", "--json", "--run"] },
    { id: "workflow-doctor", args: ["workflow", "doctor"], flags: ["--json"] },
    { id: "camp-doctor", args: ["doctor"], flags: ["--json", "--no-drain"] },
  ],
};

interface ParsedVersion { text: string; parts: readonly [number, number, number]; prerelease: boolean }
function parseVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return undefined;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parts.every(Number.isSafeInteger)) return undefined;
  return { text: value.trim().replace(/^v/, ""), parts, prerelease: !!match[4] };
}
function versionAtLeast(actual: ParsedVersion, required: ParsedVersion): boolean {
  for (let i = 0; i < 3; i++) {
    const left = actual.parts[i] ?? 0;
    const right = required.parts[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return !actual.prerelease;
}
function readVersion(stdout: string): ParsedVersion | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || !("version" in value)) return undefined;
    return parseVersion(value.version);
  } catch { return undefined; }
}
async function executablePath(executable: string, cwd?: string): Promise<string | undefined> {
  const candidates = executable.includes("/") || executable.includes("\\")
    ? [isAbsolute(executable) ? executable : resolve(cwd ?? process.cwd(), executable)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(cwd ?? process.cwd(), directory, executable));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* inspect the next PATH entry */ }
  }
  return undefined;
}
function diagnostic(result: ExecResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 2000);
}
function hasHelpFlag(help: string, flag: string): boolean {
  return help.split("\n").some((line) => {
    // Only option declarations count, not example prose or suggested commands.
    if (!/^\s+-/.test(line)) return false;
    const declaration = line.split(/\s{2,}/).find(Boolean) ?? "";
    return declaration.split(/[\s,=]+/).includes(flag);
  });
}
async function runProbe(exec: ExecRunner, executable: string, definition: ProbeDefinition, cwd?: string): Promise<CliCapabilityProbe> {
  const command = [...definition.args, "--help"];
  try {
    const result = await exec.run(executable, command, cwd, 10_000);
    const missing = definition.flags.filter((flag) => !hasHelpFlag(result.stdout, flag));
    const supported = result.code === 0 && missing.length === 0;
    return {
      id: definition.id, command, requiredFlags: [...definition.flags], supported, code: result.code,
      ...(!supported ? { diagnostic: result.code !== 0 ? diagnostic(result) : `Missing required flags: ${missing.join(", ")}` } : {}),
    };
  } catch (error) {
    return { id: definition.id, command, requiredFlags: [...definition.flags], supported: false, code: -1, diagnostic: error instanceof Error ? error.message : String(error) };
  }
}
async function detectBinary(exec: ExecRunner, binary: NativeBinary, options: CliCapabilityOptions): Promise<NativeCliCapabilities> {
  const executable = options.executables?.[binary] ?? binary;
  const path = await executablePath(executable, options.cwd);
  const report: NativeCliCapabilities = {
    executable, ...(path ? { path } : {}), requiredVersion: REQUIRED_CLI_VERSIONS[binary],
    available: false, compatible: false, ready: false, probes: [], diagnostics: [],
  };
  if (!path) report.diagnostics.push(`Executable path was not resolved on this host: ${executable}. Check PATH or configure an absolute executable.`);
  let versionResult: ExecResult;
  try { versionResult = await exec.run(executable, ["version", "--json"], options.cwd, 10_000); }
  catch (error) {
    report.diagnostics.push(`${executable} version --json failed: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }
  report.available = true;
  if (versionResult.code !== 0) {
    report.diagnostics.push(`${executable} version --json exited ${versionResult.code}: ${diagnostic(versionResult)}`);
    return report;
  }
  const version = readVersion(versionResult.stdout);
  if (!version) {
    report.diagnostics.push(`${executable} version --json did not return a valid semantic version in its version field.`);
    return report;
  }
  report.version = version.text;
  const required = parseVersion(report.requiredVersion);
  if (!required) throw new Error(`Invalid built-in required version: ${report.requiredVersion}`);
  report.compatible = versionAtLeast(version, required);
  if (!report.compatible) {
    report.diagnostics.push(`${executable} ${version.text} is below the required stable baseline ${report.requiredVersion}. Upgrade before using native tools.`);
    return report;
  }
  report.probes = await Promise.all(PROBES[binary].map((probe) => runProbe(exec, executable, probe, options.cwd)));
  for (const probe of report.probes) {
    if (!probe.supported) report.diagnostics.push(`${executable} ${probe.command.join(" ")}: ${probe.diagnostic}`);
  }
  report.ready = report.probes.every((probe) => probe.supported);
  if (report.ready && version.text !== report.requiredVersion) {
    report.diagnostics.push(`Version ${version.text} is newer than inspected baseline ${report.requiredVersion}; required help surfaces are present, but future behavior is not certified.`);
  }
  return report;
}

/** Read-only version/help discovery. No config writes, shell, camp mutations,
 * task claims, or lock changes. The host decides when to cache/refresh the report.
 */
export async function detectCliCapabilities(exec: ExecRunner, options: CliCapabilityOptions = {}): Promise<CliCapabilitiesReport> {
  const [fest, camp] = await Promise.all([detectBinary(exec, "fest", options), detectBinary(exec, "camp", options)]);
  return { ready: fest.ready && camp.ready, binaries: { fest, camp } };
}
