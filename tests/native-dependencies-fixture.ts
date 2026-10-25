import { basename, dirname, join } from "node:path";
import type { ExecResult } from "../src/ports.js";

/** Native fest 0.9.8 execution-front JSON, deliberately retaining gates_evaluated:false. */
export function nativeReadyResponse(festivalDir: string, paths: readonly string[]): string {
  return JSON.stringify({ count: paths.length, gates_evaluated: false, tasks: paths.map((path) => {
    const absolute = join(festivalDir, path);
    return { id: absolute, path: absolute, name: basename(path, ".md"), number: Number.parseInt(basename(path)),
      sequence_path: dirname(absolute), phase_path: dirname(dirname(absolute)), parallel_group: 1,
      status: "pending", dependencies: null, soft_deps: null, autonomy_level: "medium" };
  }) });
}

export function nativeSchedulingResult(festivalDir: string, args: string[], paths: readonly string[]): ExecResult {
  if (args.join(" ") === "deps --ready --all --json") return { code: 0, stderr: "", stdout: nativeReadyResponse(festivalDir, paths) };
  if (args.join(" ") === "chain list --json") return { code: 0, stderr: "", stdout: '{"chains":[]}' };
  throw new Error(`Unexpected native scheduling request: ${args.join(" ")}`);
}
