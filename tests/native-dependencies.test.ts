import { describe, expect, it, vi } from "vitest";
import { applyNativeDependencies, nativeTaskIdentity, parseNativeReadyTasks, readNativeReadyTasks } from "../src/application/native-dependencies.js";
import { nativeReadyResponse } from "./native-dependencies-fixture.js";

const first = "001_BUILD/01_core/01_first.md";
const second = "001_BUILD/02_other/01_second.md";
const third = "002_SHIP/01_verify/01_third.md";
const source = "---\nfest_type: task\nfest_status: pending\n---\n\nDependencies: logical-id\n";

describe("native dependencies", () => {
  it("maps plan labels to native sequence-relative filenames and replaces old metadata idempotently", () => {
    const paths = new Map([["first", first], ["second", second], ["third", third]]);
    const generated = applyNativeDependencies(source, third, ["first", "second"], paths);
    expect(generated).toContain("fest_dependencies:\n  - ../../001_BUILD/01_core/01_first.md\n  - ../../001_BUILD/02_other/01_second.md\n");
    expect(generated).toContain("fest_status: pending");
    expect(generated).toContain("Dependencies: logical-id");
    // Mirrors fest 0.9.8's legacy metadata parser: the safe sentinel terminates its first match.
    expect(/Dependencies[:\s*]+([^|]+)/i.exec(generated)?.[1]?.trim()).toBe("none");
    expect(applyNativeDependencies(generated, third, ["first", "second"], paths)).toBe(generated);
    const empty = applyNativeDependencies(generated, third, [], paths);
    expect(empty).not.toContain("fest_dependencies:");
    expect(empty).toContain("fest_status: pending");
  });

  it("uses plain list references for same-sequence dependencies and rejects missing/self identities", () => {
    const next = "001_BUILD/01_core/02_next.md";
    const paths = new Map([["first", first], ["next", next]]);
    expect(applyNativeDependencies(source, next, ["first"], paths)).toContain("  - 01_first.md\n");
    expect(() => applyNativeDependencies(source, next, ["missing"], paths)).toThrow("Unknown approved dependency");
    expect(() => applyNativeDependencies(source, next, ["next"], paths)).toThrow("itself");
    expect(() => applyNativeDependencies("# no frontmatter", next, [], paths)).toThrow("missing frontmatter");
  });

  it("normalizes absolute native identities and keeps gates separate from readiness", () => {
    const response: unknown = JSON.parse(nativeReadyResponse("/festival", [second]));
    expect(parseNativeReadyTasks("/festival", response)).toEqual({ gatesEvaluated: false, tasks: [{ path: second, dependencies: [] }] });
    const explicit: unknown = { count: 1, gates_evaluated: false, tasks: [{ id: `/festival/${second}`, path: `/festival/${second}`, status: "pending", dependencies: ["../01_core/01_first.md"] }] };
    expect(parseNativeReadyTasks("/festival", explicit).tasks[0]?.dependencies).toEqual([first]);
    expect(nativeTaskIdentity("/festival", first)).toBe(first);
    expect(() => nativeTaskIdentity("/festival", "../other/task.md")).toThrow("outside");
    expect(() => parseNativeReadyTasks("/festival", { count: 1, gates_evaluated: false, tasks: [] })).toThrow("Invalid native");
    expect(() => parseNativeReadyTasks("/festival", { count: 0, tasks: [] })).toThrow("gates_evaluated");
    expect(() => parseNativeReadyTasks("/festival", { count: 1, gates_evaluated: false, tasks: [{ id: `/festival/${second}`, path: `/festival/${second}`, status: "blocked", dependencies: null }] })).toThrow("executable status");
  });

  it("calls authoritative native readiness and propagates nonzero exits and malformed JSON", async () => {
    const raw = vi.fn().mockResolvedValue({ code: 0, stdout: nativeReadyResponse("/festival", [first]), stderr: "" });
    expect((await readNativeReadyTasks({ raw }, "/festival")).tasks[0]?.path).toBe(first);
    expect(raw).toHaveBeenCalledWith("/festival", ["deps", "--ready", "--all", "--json"]);
    raw.mockResolvedValueOnce({ code: 7, stdout: "", stderr: "dependency store unavailable" });
    await expect(readNativeReadyTasks({ raw }, "/festival")).rejects.toThrow("exit 7");
    raw.mockResolvedValueOnce({ code: 0, stdout: "not json", stderr: "" });
    await expect(readNativeReadyTasks({ raw }, "/festival")).rejects.toThrow("valid JSON");
  });
});
