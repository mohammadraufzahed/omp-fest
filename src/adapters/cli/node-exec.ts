/**
 * ExecRunner backed by node:child_process.execFile — no shell interpolation,
 * args are passed verbatim so paths/messages can't be injected.
 */
import { execFile } from "node:child_process";
import type { ExecResult, ExecRunner } from "../../ports.js";

const TIMEOUT_MS = 60_000;

export class NodeExecRunner implements ExecRunner {
  run(command: string, args: string[], cwd?: string, timeoutMs = TIMEOUT_MS): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && typeof error.code === "number") {
            resolve({ stdout, stderr, code: error.code });
            return;
          }
          if (error) {
            const timedOut = error.killed === true || error.signal === "SIGTERM";
            reject(timedOut
              ? new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s; it may still be running — inspect state before retrying.`)
              : error instanceof Error ? error : new Error("exec failed"));
            return;
          }
          resolve({ stdout, stderr, code: 0 });
        },
      );
    });
  }
}
