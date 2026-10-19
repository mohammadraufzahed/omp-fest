/**
 * CampCli adapter — wraps the camp command surface the plugin needs:
 * projects, idea capture, notifications, and deferred-commit job lanes.
 */
import type { CampProject } from "../../domain/types.js";
import type { CampCli, ExecRunner } from "../../ports.js";

export class CampCliAdapter implements CampCli {
  constructor(private readonly exec: ExecRunner) {}

  async available(): Promise<boolean> {
    const result = await this.exec.run("camp", ["--version"]).catch(() => undefined);
    return result?.code === 0;
  }

  async projects(campRoot: string): Promise<CampProject[]> {
    const result = await this.exec.run("camp", ["project", "list"], campRoot);
    const projects: CampProject[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = /^\s*(?:[•*-]\s*)?(\S+)\s+(.+)$/.exec(line);
      if (match && !/^name/i.test(line)) {
        projects.push({ name: match[1] ?? "", path: (match[2] ?? "").trim() });
      }
    }
    return projects;
  }

  async raw(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return await this.exec.run("camp", args, cwd);
  }

  async ideaAdd(campRoot: string, text: string): Promise<string> {
    const result = await this.exec.run("camp", ["idea", "add", text], campRoot);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "camp idea add failed");
    }
    return result.stdout.trim();
  }

  async notify(campRoot: string, message: string): Promise<void> {
    await this.exec.run("camp", ["notify", "send", message], campRoot).catch(() => {
      // camp notify send is best-effort — the inbox is secondary to ui.notify
    });
  }

  async jobsPending(campRoot: string): Promise<number> {
    const result = await this.exec.run("camp", ["jobs", "list"], campRoot);
    const pending = result.stdout.match(/pending|queued/gi);
    return pending ? pending.length : 0;
  }
}
