import { describe, expect, it, vi } from "vitest";
import type { ExecResult, ExecRunner } from "../src/ports.js";
import { detectCliCapabilities, REQUIRED_CLI_VERSIONS } from "../src/application/cli-capabilities.js";

const FLAG_HELP = [
  "--json", "--yes", "--fix", "--plan", "--name", "--dest", "--dry-run", "--phase", "--project", "--run", "--no-drain",
].map((flag) => `      ${flag}    supported option`).join("\n");
function runner(reply?: (command: string, args: string[]) => Partial<ExecResult>) {
  return {
    run: vi.fn<ExecRunner["run"]>((command, args) => {
      const version = command === "camp" ? "v0.16.2" : "v0.9.8";
      return Promise.resolve({ code: 0, stderr: "", stdout: args[0] === "version" ? JSON.stringify({ version }) : FLAG_HELP, ...reply?.(command, args) });
    }),
  };
}

describe("native CLI capability discovery", () => {
  it("requires inspected baselines and help declarations without executing mutations", async () => {
    const exec = runner();
    const report = await detectCliCapabilities(exec, { cwd: "/isolated" });
    expect(REQUIRED_CLI_VERSIONS).toEqual({ fest: "0.9.8", camp: "0.16.2" });
    expect(report.ready).toBe(true);
    expect(report.binaries.fest.version).toBe("0.9.8");
    expect(report.binaries.camp.version).toBe("0.16.2");
    expect(report.binaries.fest.probes.find((probe) => probe.id === "planning-scaffold")?.requiredFlags).toContain("--dest");
    expect(report.binaries.camp.probes.find((probe) => probe.id === "worktrees-list")?.requiredFlags).not.toContain("--json");
    for (const call of exec.run.mock.calls) {
      expect(call[1]).toEqual(call[1][0] === "version" ? ["version", "--json"] : expect.arrayContaining(["--help"]));
      expect(call[2]).toBe("/isolated");
      expect(call[3]).toBe(10_000);
    }
  });

  it.each(["v0.9.7", "v0.9.8-rc.1", "dev", "9.8", "v9007199254740992.0.0"])('rejects unsupported fest version %s', async (version) => {
    const exec = runner((command, args) => command === "fest" && args[0] === "version" ? { stdout: JSON.stringify({ version }) } : {});
    const report = await detectCliCapabilities(exec);
    expect(report.ready).toBe(false);
    expect(report.binaries.fest.ready).toBe(false);
    expect(report.binaries.fest.diagnostics.length).toBeGreaterThan(0);
    expect(report.binaries.fest.probes).toEqual([]);
  });

  it("does not mistake a failed version command for availability and compatibility", async () => {
    const report = await detectCliCapabilities(runner((command, args) => command === "camp" && args[0] === "version" ? { code: 7, stderr: "version failed" } : {}));
    expect(report.binaries.camp.available).toBe(true);
    expect(report.binaries.camp.compatible).toBe(false);
    expect(report.binaries.camp.ready).toBe(false);
    expect(report.binaries.camp.diagnostics.join("\n")).toContain("exited 7: version failed");
  });

  it("fails closed when the executable cannot start", async () => {
    const exec: ExecRunner = { run: vi.fn(() => Promise.reject(new Error("ENOENT"))) };
    const report = await detectCliCapabilities(exec);
    expect(report.ready).toBe(false);
    expect(report.binaries.fest.available).toBe(false);
    expect(report.binaries.fest.diagnostics.join("\n")).toContain("ENOENT");
  });

  it("checks flags even for newer versions, without certifying future behavior", async () => {
    const report = await detectCliCapabilities(runner((_command, args) => args[0] === "version" ? { stdout: '{"version":"v1.0.0"}' } : {}));
    expect(report.ready).toBe(true);
    expect(report.binaries.fest.probes.length).toBeGreaterThan(0);
    expect(report.binaries.fest.diagnostics.join("\n")).toContain("future behavior is not certified");
  });

  it("rejects missing flags mentioned only in examples", async () => {
    const report = await detectCliCapabilities(runner((command, args) => command === "fest" && args[0] === "next" ? { stdout: "Examples:\n  fest next --json\nFlags:\n  -h, --help    help\n" } : {}));
    expect(report.ready).toBe(false);
    const probe = report.binaries.fest.probes.find((entry) => entry.id === "next-json");
    expect(probe?.supported).toBe(false);
    expect(probe?.diagnostic).toContain("Missing required flags: --json");
  });

  it("propagates help failure diagnostics and nonzero status", async () => {
    const report = await detectCliCapabilities(runner((command, args) => command === "camp" && args[0] === "triage" ? { code: 2, stdout: FLAG_HELP, stderr: "unknown command triage" } : {}));
    expect(report.ready).toBe(false);
    expect(report.binaries.camp.probes.find((entry) => entry.id === "triage-review")?.code).toBe(2);
    expect(report.binaries.camp.diagnostics.join("\n")).toContain("unknown command triage");
  });

  it("parses external JSON defensively", async () => {
    for (const stdout of ["not json", "null", "[]", '{"version":98}', '{"version":"v0.9.8 trailing"}']) {
      const report = await detectCliCapabilities(runner((_command, args) => args[0] === "version" ? { stdout } : {}));
      expect(report.ready).toBe(false);
      expect(report.binaries.fest.diagnostics.join("\n")).toContain("valid semantic version");
    }
  });

  it("reports resolved executable paths without a shell lookup command", async () => {
    const exec = runner();
    const report = await detectCliCapabilities(exec, { executables: { fest: process.execPath, camp: process.execPath } });
    expect(report.binaries.fest.path).toBeTruthy();
    expect(report.binaries.fest.executable).toBe(process.execPath);
    expect(exec.run.mock.calls.every(([command]) => command === process.execPath)).toBe(true);
  });
});
