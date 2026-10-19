/**
 * ExecRunner backed by node:child_process.execFile — no shell interpolation,
 * args are passed verbatim so paths/messages can't be injected.
 */
import { execFile } from "node:child_process";
import type { ExecResult, ExecRunner } from "../../ports.js";

const TIMEOUT_MS = 60_000;

export class NodeExecRunner implements ExecRunner {
  run(command: string, args: string[], cwd?: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "number") {
            resolve({ stdout, stderr, code: error.code });
            return;
          }
          if (error) {
            reject(error instanceof Error ? error : new Error("exec failed"));
            return;
          }
          resolve({ stdout, stderr, code: 0 });
        },
      );
    });
  }
}
