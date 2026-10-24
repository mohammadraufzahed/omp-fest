import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExecRunner } from "../ports.js";
import { releaseProjectFiles, reserveProjectCheckout } from "./project-conflicts.js";

export interface ReleasePreview { cwd: string; branch: string; currentVersion: string; nextVersion: string; files: string[]; checks: string[]; revision: string }

export async function previewRelease(cwd: string, bump: "patch" | "minor" | "major", exec: ExecRunner): Promise<ReleasePreview> {
  const root = await realpath(cwd);
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Release requires a package.json with a stable semantic version");
  const parts = manifest.version.split(".").map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  const nextVersion = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  const branch = await exec.run("git", ["branch", "--show-current"], root);
  const prefix = await exec.run("git", ["rev-parse", "--show-prefix"], root);
  if (prefix.code || prefix.stdout.trim()) throw new Error("Release working directory must be the Git checkout root; use the root package release scripts for a monorepo");
  const upstream = await exec.run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], root);
  if (branch.code || !branch.stdout.trim() || upstream.code) throw new Error("Release needs a named branch with an existing upstream; no forced push or detached HEAD release");
  const tracked = await exec.run("git", ["diff", "HEAD", "--name-only", "-z"], root);
  const untracked = await exec.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], root);
  const head = await exec.run("git", ["rev-parse", "HEAD"], root);
  if (tracked.code || untracked.code || head.code) throw new Error("Unable to inspect release changes");
  const files = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort();
  const hash = createHash("sha256").update(head.stdout).update(branch.stdout).update(upstream.stdout).update(manifest.version).update(nextVersion);
  for (const file of files) {
    hash.update(file);
    try {
      const info = await lstat(join(root, file));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Release changes must be regular files (no symlinks/submodules)");
      hash.update(await readFile(join(root, file)));
    } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") hash.update("deleted"); else throw error; }
  }
  const scripts = "scripts" in manifest && manifest.scripts && typeof manifest.scripts === "object" ? manifest.scripts : {};
  const checks = ["test", "typecheck", "lint", "build"].filter((script) => script in scripts);
  if (!checks.length) throw new Error("No supported package verification scripts found; define test/typecheck/lint/build before release");
  return { cwd: root, branch: branch.stdout.trim(), currentVersion: manifest.version, nextVersion, files, checks, revision: hash.digest("hex") };
}

export async function executeRelease(preview: ReleasePreview, bump: "patch" | "minor" | "major", message: string, exec: ExecRunner) {
  if (!message.trim()) throw new Error("Commit message required");
  const identity = { sessionId: "omp-release", assignmentId: randomUUID() };
  const reservation = await reserveProjectCheckout(preview.cwd, identity);
  if (reservation.kind !== "reserved") return { status: "failed", failedStage: "write-locks", log: [], hint: reservation.kind === "conflict" ? "Active project writes remain; no version, commit or push performed." : "Project write-lock registry is busy; no version, commit or push performed." };
  const log: { step: string; code: number; stdout: string; stderr: string }[] = [];
  let releaseFailure: string | undefined;
  const outcome = await (async () => {
    try {
      const current = await previewRelease(preview.cwd, bump, exec);
      if (current.cwd !== preview.cwd || current.revision !== preview.revision) throw new Error("Release inputs changed during approval; preview and approve again");
      const run = async (step: string, command: string, args: string[]) => {
        try {
          const result = await exec.run(command, args, preview.cwd);
          log.push({ step, ...result });
          return result.code === 0;
        } catch (error) {
          log.push({ step, code: 1, stdout: "", stderr: String(error) });
          return false;
        }
      };
      if (!await run("version", "npm", ["version", preview.nextVersion, "--no-git-tag-version", "--ignore-scripts"])) return { status: "failed", failedStage: "version", log, hint: "Version step failed; changes retained, nothing committed or pushed." };
      for (const check of preview.checks) if (!await run(check, "npm", ["run", check])) return { status: "failed", failedStage: check, log, hint: "Verification failed; version/files retained. No commit or push." };
      const files = [...new Set([...preview.files, "package.json", "package-lock.json"])];
      const lock = await lstat(join(preview.cwd, "package-lock.json")).catch(() => undefined);
      const stage = files.filter((file) => file !== "package-lock.json" || lock);
      if (!await run("stage", "git", ["add", "--", ...stage])) return { status: "failed", failedStage: "stage", log, hint: "Staging failed; no commit or push." };
      if (!await run("commit", "git", ["commit", "-m", message])) return { status: "failed", failedStage: "commit", log, hint: "Commit failed; no push." };
      if (!await run("push", "git", ["push"])) return { status: "push_failed", failedStage: "push", log, hint: "Local commit retained; fix remote/authentication and retry push, never force." };
      return { status: "pushed", version: preview.nextVersion, log };
    } finally {
      try {
        const released = await releaseProjectFiles(preview.cwd, identity.sessionId, identity.assignmentId);
        if (released.kind !== "released" || !released.released) releaseFailure = "Project reservation could not be confirmed released.";
      } catch (error) {
        releaseFailure = String(error);
      }
    }
  })();
  if (releaseFailure) return { status: "failed", failedStage: "reservation-release", log, hint: `${releaseFailure} Inspect the project write-lock registry before another release.` };
  return outcome;
}
