/**
 * FestCli adapter — every call resolves the festival dir, prefers --json,
 * and always passes --yes on mutations (fest v0.9.7 refuses headless
 * confirmations otherwise). Output is returned parsed or verbatim per port.
 */
import { classifyNextOutput } from "../../domain/next-unit.js";
import type { FestivalSummary, NextUnit } from "../../domain/types.js";
import type { ExecRunner, FestCli } from "../../ports.js";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class FestCliAdapter implements FestCli {
  constructor(private readonly exec: ExecRunner) {}

  async available(): Promise<boolean> {
    const result = await this.exec.run("fest", ["--version"]).catch(() => undefined);
    return result?.code === 0;
  }

  async version(): Promise<string | undefined> {
    const result = await this.exec.run("fest", ["--version"]).catch(() => undefined);
    return result?.code === 0 ? result.stdout.trim() : undefined;
  }

  async next(festivalDir: string): Promise<NextUnit> {
    const result = await this.exec.run("fest", ["next"], festivalDir);
    return classifyNextOutput(result.stdout + result.stderr, result.code);
  }

  async taskComplete(festivalDir: string, task: string): Promise<void> {
    await this.checked(
      this.exec.run("fest", ["task", "completed", task, "--yes", "--json"], festivalDir),
    );
  }

  async taskMutate(
    festivalDir: string,
    action: "blocked" | "defer" | "unblock" | "reset" | "update",
    opts: { task?: string; reason?: string; percent?: string },
  ): Promise<void> {
    const args = ["task", action];
    if (opts.task) {
      args.push(opts.task);
    }
    if (opts.reason) {
      args.push("--reason", opts.reason);
    }
    if (action === "update" && opts.percent) {
      args.push(opts.percent);
    }
    args.push("--yes", "--json");
    await this.checked(this.exec.run("fest", args, festivalDir));
  }

  async commit(festivalDir: string, message: string): Promise<string> {
    const result = await this.checked(
      this.exec.run("fest", ["commit", "-m", message], festivalDir),
    );
    return /Hash\s+(\w+)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
  }

  async validate(festivalDir: string, fix = false): Promise<{ score: number; output: string }> {
    const args = fix ? ["validate", "--fix"] : ["validate"];
    const result = await this.exec.run("fest", args, festivalDir);
    const output = result.stdout + result.stderr;
    const score = Number(/Score\s+(\d+)\/100/.exec(output)?.[1] ?? "0");
    return { score, output };
  }

  async workflowAdvance(festivalDir: string): Promise<string> {
    const result = await this.exec.run("fest", ["workflow", "advance"], festivalDir);
    return result.stdout;
  }

  async workflowStatus(festivalDir: string): Promise<string> {
    const result = await this.exec.run("fest", ["workflow", "status"], festivalDir);
    return result.stdout;
  }

  async workflowApprove(festivalDir: string): Promise<string> {
    const result = await this.exec.run("fest", ["workflow", "approve"], festivalDir);
    return result.stdout;
  }

  async workflowReject(festivalDir: string, reason: string): Promise<string> {
    const result = await this.exec.run(
      "fest",
      ["workflow", "reject", "--reason", reason],
      festivalDir,
    );
    return result.stdout;
  }

  async markersCount(festivalDir: string): Promise<number> {
    const result = await this.exec.run("fest", ["markers", "count", "--json"], festivalDir);
    const total = /"total[^"]*"\s*:\s*(\d+)/i.exec(result.stdout)?.[1];
    return total ? Number(total) : Number(/\d+/.exec(result.stdout)?.[0] ?? "0");
  }

  async markersList(festivalDir: string): Promise<string> {
    const result = await this.exec.run("fest", ["markers", "list"], festivalDir);
    return result.stdout;
  }

  async list(campRoot: string): Promise<FestivalSummary[]> {
    const result = await this.exec.run("fest", ["list", "--json"], campRoot);
    try {
      const data = JSON.parse(result.stdout) as Record<string, Record<string, unknown>[]>;
      const summaries: FestivalSummary[] = [];
      for (const [status, items] of Object.entries(data)) {
        if (!Array.isArray(items)) {
          continue;
        }
        for (const item of items) {
          summaries.push({
            id: str(item.name),
            name: str(item.name),
            status,
            path: str(item.path),
            ...(typeof item.progress === "number" ? { progress: item.progress } : {}),
            ...(typeof item.tokens === "number" ? { tokens: item.tokens } : {}),
          });
        }
      }
      return summaries;
    } catch {
      return [];
    }
  }

  async rules(festivalDir: string): Promise<string> {
    const result = await this.exec.run("fest", ["rules"], festivalDir);
    return result.stdout;
  }

  async context(cwd: string): Promise<string> {
    const result = await this.exec.run("fest", ["context"], cwd);
    return result.stdout;
  }

  async status(festivalDir: string): Promise<string> {
    const result = await this.exec.run("fest", ["status"], festivalDir);
    return result.stdout;
  }

  async show(festivalDir: string, selector?: string): Promise<string> {
    const args = selector ? ["show", selector] : ["show"];
    const result = await this.exec.run("fest", args, festivalDir);
    return result.stdout;
  }

  private async checked(promise: Promise<{ stdout: string; stderr: string; code: number }>) {
    const result = await promise;
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "fest command failed");
    }
    return result;
  }
}
