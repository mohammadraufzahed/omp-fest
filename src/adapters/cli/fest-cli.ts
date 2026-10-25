/**
 * FestCli adapter — calls fest in the resolved directory and enables
 * headless confirmation only for task actions that support it.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { classifyNextOutput } from "../../domain/next-unit.js";
import type { FestivalSummary, NextUnit, ValidationIssue } from "../../domain/types.js";
import type { ExecRunner, FestCli } from "../../ports.js";

const CONFIRMING_TASK_ACTIONS = new Set(["completed", "blocked", "defer", "reset"]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonObject(output: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
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
    const result = await this.exec.run("fest", ["next", "--json"], festivalDir);
    return classifyNextOutput(result.stdout.trim() || result.stderr, result.code);
  }

  async taskComplete(festivalDir: string, task: string): Promise<{ ok: boolean; output: string }> {
    const args = task ? ["task", "completed", task, "--yes", "--json"] : ["task", "completed", "--yes", "--json"];
    const result = await this.exec.run("fest", args, festivalDir);
    const data = jsonObject(result.stdout);
    return { ok: result.code === 0 && data?.ok !== false && data?.success !== false, output: result.stdout + result.stderr };
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
    if ((action === "blocked" || action === "defer") && !opts.reason?.trim()) {
      throw new Error(`fest task ${action} requires a reason`);
    }
    if (action === "update" && !opts.percent?.trim()) {
      throw new Error("fest task update requires a progress percentage");
    }
    if (opts.reason?.trim() && !["blocked", "defer", "unblock"].includes(action)) {
      throw new Error(`fest task ${action} does not accept a reason or note`);
    }
    if (opts.percent?.trim() && action !== "update") {
      throw new Error(`fest task ${action} does not accept a percentage`);
    }
    if (opts.reason?.trim()) {
      args.push(action === "unblock" ? "--note" : "--reason", opts.reason);
    }
    if (action === "update" && opts.percent) {
      args.push(opts.percent);
    }
    if (CONFIRMING_TASK_ACTIONS.has(action)) args.push("--yes");
    args.push("--json");
    await this.checked(this.exec.run("fest", args, festivalDir));
  }

  async commit(festivalDir: string, message: string): Promise<string> {
    const result = await this.checked(
      this.exec.run("fest", ["commit", "-m", message], festivalDir),
    );
    return /Hash\s+(\w+)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
  }

  async validate(festivalDir: string, fix = false): Promise<{
    score: number; output: string; valid?: boolean; markersPending?: boolean; errors?: ValidationIssue[];
  }> {
    const args = fix ? ["validate", "--fix", "--json"] : ["validate", "--json"];
    const result = await this.exec.run("fest", args, festivalDir, 300_000);
    const output = result.stdout + result.stderr;
    const data = jsonObject(result.stdout);
    if (data && typeof data.valid === "boolean") {
      const errors: ValidationIssue[] = [];
      if (Array.isArray(data.issues)) {
        for (const value of data.issues) {
          if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
          const issue = value as Record<string, unknown>;
          if (issue.level !== "error") continue;
          errors.push({ file: str(issue.path), markers: [], error: str(issue.message) });
        }
      }
      if (data.ok === false || result.code !== 0 && data.valid) {
        throw new Error(output.trim() || "fest validate failed");
      }
      const score = typeof data.score === "number" && Number.isFinite(data.score)
        ? data.score : data.valid ? 100 : 0;
      return { score, output, valid: data.valid, markersPending: data.markers_pending === true, errors };
    }
    const scoreMatch = /Score\s+(\d+)\/100/i.exec(output);
    if (scoreMatch) return { score: Number(scoreMatch[1]), output, valid: result.code === 0 };
    throw new Error(output.trim() || `fest validate failed (exit ${result.code}): no validation result`);
  }

  async workflowAdvance(festivalDir: string): Promise<string> {
    const result = await this.checked(this.exec.run("fest", ["workflow", "advance"], festivalDir));
    return result.stdout;
  }

  async workflowStatus(festivalDir: string): Promise<string> {
    const result = await this.checked(this.exec.run("fest", ["workflow", "status"], festivalDir));
    return result.stdout;
  }

  async workflowApprove(festivalDir: string): Promise<string> {
    const result = await this.checked(this.exec.run("fest", ["workflow", "approve"], festivalDir));
    return result.stdout;
  }

  async workflowReject(festivalDir: string, reason: string): Promise<string> {
    const result = await this.checked(this.exec.run(
      "fest",
      ["workflow", "reject", "--reason", reason],
      festivalDir,
    ));
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

  async scaffoldFromPlan(
    campRoot: string,
    opts: { plan: string; name: string; dest?: string; dryRun?: boolean },
  ): Promise<string> {
    const args = [
      "scaffold",
      "from-plan",
      "--plan",
      opts.plan,
      "--name",
      opts.name,
      "--dest",
      opts.dest ?? "planning",
      "--agent",
    ];
    if (opts.dryRun) {
      args.push("--dry-run");
    }
    // Scaffold/validate run over whole festivals; give them room before killing.
    const result = await this.checked(this.exec.run("fest", args, campRoot, 300_000));
    return result.stdout;
  }

  async gatesApply(campRoot: string, festivalDir: string): Promise<{ created: number; output: string }> {
    const gatesDir = join(festivalDir, "gates");
    const seeded = await readdir(gatesDir).then(() => false, async (error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const source = join(
        campRoot,
        "festivals",
        ".festival",
        "templates",
        "phases",
        "implementation",
        "gates",
      );
      const target = join(gatesDir, "implementation");
      await mkdir(target, { recursive: true });
      await cp(source, target, { recursive: true });
      return true;
    });
    const result = await this.checked(this.exec.run("fest", ["gates", "apply", "--approve", "--json"], festivalDir));
    const data = jsonObject(result.stdout);
    if (!data) throw new Error("fest gates apply returned invalid JSON");
    const summary = typeof data.summary === "object" && data.summary !== null && !Array.isArray(data.summary)
      ? data.summary as Record<string, unknown> : undefined;
    const created = summary?.files_created;
    if (typeof created !== "number" || !Number.isInteger(created) || created < 0) {
      throw new Error("fest gates apply returned no valid files_created count");
    }
    return {
      created,
      output: `${seeded ? "Seeded missing gates/ templates from camp .festival templates.\n" : ""}${result.stdout}${result.stderr}`,
    };
  }

  async promote(cwd: string, name?: string): Promise<string> {
    const args = ["promote"];
    if (name) {
      args.push(name);
    }
    args.push("--json");
    const result = await this.checked(this.exec.run("fest", args, cwd));
    return result.stdout;
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

  async raw(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const action = args[0] === "task" ? args[1] : undefined;
    const isReadOnlyBlockerList = action === "blocked" && args.includes("--list");
    if (action && CONFIRMING_TASK_ACTIONS.has(action) && !isReadOnlyBlockerList && !args.includes("--yes")) {
      args = [...args, "--yes"];
    }
    return await this.exec.run("fest", args, cwd);
  }

  private async checked(promise: Promise<{ stdout: string; stderr: string; code: number }>) {
    const result = await promise;
    const data = jsonObject(result.stdout);
    if (result.code !== 0 || data?.ok === false || data?.success === false) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "fest command failed");
    }
    return result;
  }
}
