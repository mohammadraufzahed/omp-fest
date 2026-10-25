import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExecResult, FestCli } from "../ports.js";

export interface NativeChainEligibility extends ExecResult {
  allowed: boolean;
  kind: "unblocked" | "not_in_chain" | "blocked" | "error";
}

/** Native chain check has no JSON mode in fest 0.9.8. Fail closed on unknown output. */
export async function checkNativeChainEligibility(fest: Pick<FestCli, "raw">, festivalDir: string): Promise<NativeChainEligibility> {
  try {
    if (!(await stat(join(festivalDir, "fest.yaml"))).isFile()) throw new Error("Not a festival root");
    const listed = await fest.raw(festivalDir, ["chain", "list", "--json"]);
    if (listed.code !== 0) return { ...listed, allowed: false, kind: "error" };
    const value: unknown = JSON.parse(listed.stdout);
    if (!value || typeof value !== "object" || !("chains" in value) || !Array.isArray(value.chains)
      || !value.chains.every((chain: unknown) => chain !== null && typeof chain === "object" && "id" in chain && typeof chain.id === "string")) {
      return { ...listed, code: 1, stderr: "Malformed native chain list JSON", allowed: false, kind: "error" };
    }
    if (value.chains.length === 0) return { ...listed, allowed: true, kind: "not_in_chain" };
    const checked = await fest.raw(festivalDir, ["chain", "check"]);
    if (checked.code !== 0) {
      const message = `${checked.stderr}\n${checked.stdout}`;
      if (message.includes("Error: festival not found") && message.includes("ensure the festival is in a chain")) {
        return { ...checked, allowed: true, kind: "not_in_chain" };
      }
      return { ...checked, allowed: false, kind: /BLOCKED|unmet|not completed/i.test(message) ? "blocked" : "error" };
    }
    if (/\bUNBLOCKED\b/.test(checked.stdout)) return { ...checked, allowed: true, kind: "unblocked" };
    return { ...checked, allowed: false, kind: /\bBLOCKED\b/.test(checked.stdout) ? "blocked" : "error" };
  } catch (error) {
    return { allowed: false, kind: "error", code: 1, stdout: "", stderr: String(error) };
  }
}
