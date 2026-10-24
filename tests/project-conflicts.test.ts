import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalProjectDirectory,
  checkProjectConflicts,
  listProjectReservations,
  releaseProjectFiles,
  reserveProjectFiles,
  reclaimProjectFiles,
} from "../src/application/project-conflicts.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "project-reservations-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project reservations", () => {
  it("allows only one of two concurrent sessions to reserve the same path", async () => {
    const project = await fixture();
    const results = await Promise.all([
      reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: ["src/feature.ts"] }),
      reserveProjectFiles(project, { sessionId: "session-b", assignmentId: "b", files: ["src/feature.ts"] }),
    ]);
    expect(results.filter((row) => row.kind === "reserved")).toHaveLength(1);
    expect(results.filter((row) => row.kind === "conflict")).toHaveLength(1);
    const persisted = await listProjectReservations(project);
    expect(persisted).toHaveLength(1);
    const conflict = results.find((row) => row.kind === "conflict");
    expect(conflict?.conflicts).toEqual(persisted);
  });

  it("locks only exact files while candidate directory scopes still detect overlap", async () => {
    const project = await fixture();
    await mkdir(join(project, "src/domain"), { recursive: true });
    await expect(reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "empty", files: [] })).rejects.toThrow("exact target file paths");
    await expect(reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "directory", files: ["src/domain"] })).rejects.toThrow("not a directory");
    expect((await reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "file", files: ["src/domain/model.ts"] })).kind).toBe("reserved");
    expect((await checkProjectConflicts(project, ["src/domain"])).kind).toBe("conflict");
    expect((await checkProjectConflicts(project, ["src/domain-model.ts"])).kind).toBe("clear");
  });

  it("normalizes paths and checks broad candidate scopes against exact file locks", async () => {
    const project = await fixture();
    await reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: ["./src/../src/file.ts", join(project, "src/file.ts")] });
    expect((await listProjectReservations(project))[0]?.files).toEqual(["src/file.ts"]);
    expect((await checkProjectConflicts(project, ["."])).kind).toBe("conflict");
    await expect(reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "directory", files: ["."] })).rejects.toThrow("exact target file paths");
  });


  it("shares a registry through canonical checkout aliases and canonical file symlinks", async () => {
    const root = await fixture();
    const project = join(root, "checkout");
    const alias = join(root, "alias");
    await mkdir(join(project, "src"), { recursive: true });
    await symlink(project, alias);
    await symlink(join(project, "src"), join(project, "source"));
    await reserveProjectFiles(alias, { sessionId: "session-a", assignmentId: "a", files: ["source/new.ts"] });
    expect((await reserveProjectFiles(project, { sessionId: "session-b", assignmentId: "b", files: ["src/new.ts"] })).kind).toBe("conflict");
    expect((await checkProjectConflicts(alias, [join(alias, "src/new.ts")])).kind).toBe("conflict");
    expect((await listProjectReservations(alias))[0]).toMatchObject({ projectDir: project, files: ["src/new.ts"] });
  });

  it("isolates separate canonical worktree checkouts", async () => {
    const root = await fixture();
    const first = join(root, "worktree-one");
    const second = join(root, "worktree-two");
    await mkdir(first);
    await mkdir(second);
    await mkdir(join(root, "repository/worktrees/one"), { recursive: true });
    await mkdir(join(root, "repository/worktrees/two"), { recursive: true });
    await writeFile(join(first, ".git"), "gitdir: ../repository/worktrees/one\n");
    await writeFile(join(second, ".git"), "gitdir: ../repository/worktrees/two\n");
    expect((await reserveProjectFiles(first, { sessionId: "session-a", assignmentId: "a", files: ["src/file.ts"] })).kind).toBe("reserved");
    expect((await reserveProjectFiles(second, { sessionId: "session-b", assignmentId: "b", files: ["src/file.ts"] })).kind).toBe("reserved");
  });

  it("shares nested checkout registries while resolving boundaries from each working directory", async () => {
    const project = await fixture();
    const nested = join(project, "packages/a");
    await mkdir(join(project, ".git"));
    await mkdir(nested, { recursive: true });
    expect(await canonicalProjectDirectory(nested)).toBe(project);
    await reserveProjectFiles(nested, { sessionId: "session-a", assignmentId: "a", files: ["src/file.ts"] });
    expect((await listProjectReservations(project))[0]?.files).toEqual(["packages/a/src/file.ts"]);
    expect((await checkProjectConflicts(project, ["packages/a/src"])).kind).toBe("conflict");
    expect((await checkProjectConflicts(nested, ["src/file.ts"])).kind).toBe("conflict");
    expect((await checkProjectConflicts(project, ["src/file.ts"])).kind).toBe("clear");
    expect((await reserveProjectFiles(project, { sessionId: "session-b", assignmentId: "b", files: ["packages/a/src/file.ts"] })).kind).toBe("conflict");
    expect(await releaseProjectFiles(nested, "session-a", "a")).toEqual({ kind: "released", released: true });
  });

  it("rejects lexical and symlink escapes including dangling symlinks", async () => {
    const root = await fixture();
    const project = join(root, "checkout");
    await mkdir(project);
    await symlink(root, join(project, "outside"));
    await symlink(join(root, "not-created"), join(project, "dangling"));
    for (const file of ["../escape.ts", join(root, "absolute.ts"), "outside/escape.ts", "dangling/escape.ts"]) {
      await expect(reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: [file] })).rejects.toThrow(/outside|escapes/);
    }
    expect(await listProjectReservations(project)).toEqual([]);
  });

  it("keeps durable reservations until their exact session releases them", async () => {
    const project = await fixture();
    const request = { sessionId: "session-a", assignmentId: "same-id", files: ["file.ts"], festival: "festival-a", task: "task-a", worker: "worker-a" };
    const first = await reserveProjectFiles(project, request);
    expect(await reserveProjectFiles(project, request)).toEqual(first);
    expect(await releaseProjectFiles(project, "session-b", "same-id")).toEqual({ kind: "released", released: false });
    expect((await checkProjectConflicts(project, ["file.ts"])).kind).toBe("conflict");
    expect(await checkProjectConflicts(project, ["file.ts"], { sessionId: "session-a", assignmentId: "same-id" })).toEqual({ kind: "clear" });
    await expect(reserveProjectFiles(project, { ...request, files: ["different.ts"] })).rejects.toThrow(/boundary cannot change/);
    expect(await listProjectReservations(project)).toHaveLength(1);
    expect(await releaseProjectFiles(project, "session-a", "same-id")).toEqual({ kind: "released", released: true });
    expect(await listProjectReservations(project)).toEqual([]);
    expect((await reserveProjectFiles(project, { ...request, sessionId: "session-b" })).kind).toBe("reserved");
  });

  it.each(["{", "{}", '{"version":1,"projectDir":"different","reservations":[]}'])("fails closed for corrupt registries %s", async (text) => {
    const project = await fixture();
    const path = join(project, ".omp-fest-reservations.json");
    await writeFile(path, text);
    await expect(reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: ["src/file.ts"] })).rejects.toThrow();
    await expect(listProjectReservations(project)).rejects.toThrow();
    await expect(releaseProjectFiles(project, "session-a", "a")).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("does not turn unreadable registry records into an empty checkout", async () => {
    const project = await fixture();
    await mkdir(join(project, ".omp-fest-reservations.json"));
    await expect(reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: ["src/file.ts"] })).rejects.toThrow();
  });

  it("never deletes a preexisting lock to infer stale ownership", async () => {
    const project = await fixture();
    const lock = join(project, ".omp-fest-reservations.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner"), "another process");
    expect(await reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: ["src/file.ts"] })).toEqual({ kind: "busy" });
    expect((await stat(lock)).isDirectory()).toBe(true);
    expect(await readFile(join(lock, "owner"), "utf8")).toBe("another process");
  });

  it("reclaims only the exact reservation inspected by the human", async () => {
    const project = await fixture();
    const created = await reserveProjectFiles(project, { sessionId: "session-a", assignmentId: "a", files: ["src/a.ts"], worker: "A" });
    expect(created.kind).toBe("reserved");
    if (created.kind !== "reserved") return;
    await expect(reclaimProjectFiles(project, { ...created.reservation, reservedAt: "stale" })).rejects.toThrow("changed since inspection");
    expect(await listProjectReservations(project)).toEqual([created.reservation]);
    expect(await reclaimProjectFiles(project, created.reservation)).toEqual({ kind: "released", released: true });
    expect(await listProjectReservations(project)).toEqual([]);
  });
});
