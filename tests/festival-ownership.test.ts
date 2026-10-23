import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimFestivalOwnership, festivalOwner } from "../src/application/festival-ownership.js";

describe("festival ownership", () => {
  it("does not steal ownership without an explicit transfer", async () => {
    const root = await mkdtemp(join(tmpdir(), "festival-owner-"));
    await mkdir(root, { recursive: true });
    const first = await claimFestivalOwnership(root, "session-a");
    const second = await claimFestivalOwnership(root, "session-b");
    expect(first.kind).toBe("claimed");
    expect(second).toMatchObject({ kind: "owned", owner: { sessionId: "session-a" } });
    expect((await festivalOwner(root))?.sessionId).toBe("session-a");
  });

  it("transfers atomically only when requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "festival-owner-"));
    await claimFestivalOwnership(root, "session-a");
    const transferred = await claimFestivalOwnership(root, "session-b", true);
    expect(transferred).toMatchObject({ kind: "claimed", transferredFrom: { sessionId: "session-a" } });
    expect((await festivalOwner(root))?.sessionId).toBe("session-b");
    expect(JSON.parse(await readFile(join(root, ".omp-fest-owner.json"), "utf8"))).toMatchObject({ sessionId: "session-b" });
  });
});
