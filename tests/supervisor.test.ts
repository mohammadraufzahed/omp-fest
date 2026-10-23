import { describe, expect, it, vi } from "vitest";
import { Supervisor, SUPERVISOR_ENTRY } from "../src/application/supervisor.js";
import { supervisorCommands } from "../src/adapters/omp/supervisor-commands.js";

describe("festival supervisor", () => {
  it("requires a real dispatch and independent review before acceptance", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "Implementation", ["src/a.ts"]);
    expect(() => supervisor.update("s", row.id, "submit", "Tests passed")).toThrow("running worker");
    expect(() => supervisor.update("s", row.id, "accept", "Reviewed")).toThrow("submitted results");
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Changed src/a.ts; command npm test passed");
    expect(() => supervisor.update("s", row.id, "accept", " ")).toThrow("evidence");
    supervisor.update("s", row.id, "revise", "Handle the empty state");
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Empty state now verified");
    expect(supervisor.update("s", row.id, "accept", "Independently exercised empty state").status).toBe("accepted");
    expect(() => supervisor.update("s", row.id, "running", "")).toThrow("cannot be changed");
  });

  it("bounds independent work, prevents overlap and preserves running work on pause", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "a.md", "A", ["src/a"]);
    supervisor.update("s", row.id, "running", "");
    expect(() => supervisor.assign("s", "festival", "b.md", "B", ["src/a/child.ts"])).toThrow("overlaps");
    expect(() => supervisor.assign("s", "festival", "b.md", "B", [])).toThrow("unknown");
    supervisor.assign("s", "festival", "b.md", "B", ["src/b.ts"]);
    supervisor.assign("s", "festival", "c.md", "C", ["src/c.ts"]);
    expect(() => supervisor.assign("s", "festival", "d.md", "D", ["src/d.ts"])).toThrow("Three assignments");
    supervisor.pause("s", true);
    expect(supervisor.state("s").workers[0]?.status).toBe("running");
    expect(() => supervisor.assign("s", "festival", "d.md", "D", ["src/d.ts"])).toThrow("paused");
    supervisor.update("s", row.id, "submit", "Completed during pause");
    expect(supervisor.state("s").workers[0]?.status).toBe("ready_for_review");
  });

  it("restores only this session branch and isolates worker authority", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    expect(() => supervisor.update("worker-session", row.id, "accept", "self approval")).toThrow("Unknown assignment");
    supervisor.pause("s", true);
    const snapshot = supervisor.state("s");
    const resumed = new Supervisor();
    resumed.restore("s", [{ customType: SUPERVISOR_ENTRY, data: snapshot }]);
    expect(resumed.state("s")).toEqual(snapshot);
    resumed.restore("s", []);
    expect(resumed.state("s")).toEqual({ paused: false, workers: [] });
  });

  it("native review cancellation preserves submission; acceptance records evidence only", async () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Worker reported test passed");
    const messages: string[] = [];
    const commands = supervisorCommands({ registerCommand: vi.fn(), sendMessage: (message) => { messages.push(String(message.content)); } }, supervisor);
    const ctx = {
      cwd: "/camp", sessionManager: { getSessionId: () => "s" },
      ui: { notify: vi.fn(), select: () => Promise.resolve("Keep pending"), input: () => Promise.resolve("Independent smoke passed") },
    };
    await commands.review.run([row.id], ctx);
    expect(supervisor.state("s").workers[0]?.status).toBe("ready_for_review");
    ctx.ui.select = () => Promise.resolve("Accept after verification");
    await commands.review.run([row.id], ctx);
    expect(supervisor.state("s").workers[0]).toMatchObject({ status: "accepted", review: "Independent smoke passed" });
    expect(messages.at(-1)).toContain("must still integrate");
  });
});
