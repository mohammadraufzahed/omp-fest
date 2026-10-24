import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimFestivalOwnership, festivalOwner } from "../src/application/festival-ownership.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "festival-owner-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("festival ownership", () => {
  it("does not steal ownership without an explicit transfer", async () => {
    const root = await fixture();
    const first = await claimFestivalOwnership(root, "session-a");
    const second = await claimFestivalOwnership(root, "session-b");
    expect(first.kind).toBe("claimed");
    expect(second).toMatchObject({ kind: "owned", owner: { sessionId: "session-a" } });
    expect((await festivalOwner(root))?.sessionId).toBe("session-a");
  });

  it("transfers atomically only with the confirmed owner token", async () => {
    const root = await fixture();
    const initial = await claimFestivalOwnership(root, "session-a");
    if (initial.kind !== "claimed") throw new Error("Initial claim failed.");
    const transferred = await claimFestivalOwnership(root, "session-b", initial.owner);
    expect(transferred).toMatchObject({ kind: "claimed", transferredFrom: { sessionId: "session-a" } });
    expect((await festivalOwner(root))?.sessionId).toBe("session-b");
    expect(JSON.parse(await readFile(join(root, ".omp-fest-owner.json"), "utf8"))).toMatchObject({ sessionId: "session-b" });
  });

  it("lets only one concurrent confirmation replace the confirmed owner", async () => {
    const root = await fixture();
    const initial = await claimFestivalOwnership(root, "session-a");
    if (initial.kind !== "claimed") throw new Error("Initial claim failed.");
    const results = await Promise.all([
      claimFestivalOwnership(root, "session-b", initial.owner),
      claimFestivalOwnership(root, "session-c", initial.owner),
    ]);
    const claimed = results.filter((result) => result.kind === "claimed");
    const changed = results.filter((result) => result.kind === "changed");
    expect(claimed).toHaveLength(1);
    expect(changed).toHaveLength(1);
    expect(await festivalOwner(root)).toEqual(claimed[0]?.owner);
    expect(changed[0]?.owner).toEqual(claimed[0]?.owner);
  });

  it("compares claimedAt as well as session, rejecting an ABA transfer", async () => {
    const root = await fixture();
    const first = await claimFestivalOwnership(root, "session-a");
    if (first.kind !== "claimed") throw new Error("Initial claim failed.");
    const second = await claimFestivalOwnership(root, "session-b", first.owner);
    if (second.kind !== "claimed") throw new Error("Transfer failed.");
    const third = await claimFestivalOwnership(root, "session-a", second.owner);
    if (third.kind !== "claimed") throw new Error("Transfer back failed.");
    expect(third.owner.claimedAt).not.toBe(first.owner.claimedAt);
    expect(await claimFestivalOwnership(root, "session-c", first.owner)).toEqual({ kind: "changed", owner: third.owner });
    expect(await festivalOwner(root)).toEqual(third.owner);
  });

  it("preserves an existing same-session claim and its token", async () => {
    const root = await fixture();
    const first = await claimFestivalOwnership(root, "session-a");
    expect(await claimFestivalOwnership(root, "session-a")).toEqual(first);
  });

  it("does not claim an unowned festival using a disappeared owner's confirmation", async () => {
    const root = await fixture();
    expect(await claimFestivalOwnership(root, "session-b", { sessionId: "session-a", claimedAt: "old" })).toEqual({ kind: "changed" });
    expect(await festivalOwner(root)).toBeUndefined();
  });

  it.each(["{", "null", "{}", '{"sessionId":"session-a","claimedAt":5}'])("fails closed for corrupt ownership %s", async (record) => {
    const root = await fixture();
    const path = join(root, ".omp-fest-owner.json");
    await writeFile(path, record);
    await expect(claimFestivalOwnership(root, "session-b")).rejects.toThrow();
    await expect(festivalOwner(root)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(record);
  });

  it("propagates ownership read errors rather than replacing the record", async () => {
    const root = await fixture();
    await mkdir(join(root, ".omp-fest-owner.json"));
    await expect(claimFestivalOwnership(root, "session-a")).rejects.toThrow();
  });
});
