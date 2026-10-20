import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { CampDetect } from "../ports.js";
import { linkedPages, MAX_PAGES, pageChecks, referencesForTask, taskChecks, validateWireframe, withVisualReferenceLock, type ReferenceBundle } from "./visual-references.js";

function digest(bundle: ReferenceBundle): string {
  return createHash("sha256").update(JSON.stringify(bundle.files)).digest("hex");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export async function renderPlanPreview(plan: string, bundle: ReferenceBundle): Promise<{ file: string; url: string }> {
  if (!plan.endsWith(".STRUCTURE.md")) {
    throw new Error("Preview requires a .STRUCTURE.md plan");
  }
  const file = plan.replace(/\.STRUCTURE\.md$/, ".preview.html");
  const existing = await lstat(file).catch(() => undefined);
  if (existing && !existing.isFile()) {
    throw new Error("Preview output must be a regular file, not a symlink");
  }
  const sections = bundle.pages.map((page) => {
    const spec = bundle.files.find((entry) => entry.path === `pages/${page}/PAGE.md`)?.content ?? "";
    const svg = bundle.files.find((entry) => entry.path === `pages/${page}/wireframe.svg`)?.content ?? "";
    validateWireframe(svg);
    return `<section><h2>${escapeHtml(page)}</h2><div class="columns"><div class="drawing">${svg}</div><pre>${escapeHtml(spec)}</pre></div></section>`;
  });
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'"><title>Festival visual plan</title><style>body{font:16px system-ui;margin:2rem;max-width:1200px;color:#242424}section{border-top:1px solid #ccc;margin-top:2rem}.columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem}.drawing{border:1px solid #ddd;padding:1rem;overflow:auto}.drawing svg{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:1rem}@media(max-width:700px){.columns{display:block}}</style><h1>Festival visual plan</h1><p>Review the drawing, component IDs, states, unknowns and acceptance checks together. This preview does not include the original screenshot.</p>${sections.join("\n")}</html>`;
  await writeFile(file, html);
  return { file, url: pathToFileURL(file).href };
}

export async function findReuseCandidates(campRoot: string, workingDir: string | undefined, bundle: ReferenceBundle): Promise<string[]> {
  if (!workingDir || workingDir === ".") {
    return [];
  }
  const projectParent = await realpath(join(campRoot, "projects")).catch(() => undefined);
  const project = await realpath(resolve(campRoot, workingDir)).catch(() => undefined);
  if (!projectParent || !project) {
    return [];
  }
  const rel = relative(projectParent, project);
  if (!rel || rel.split(sep)[0] === ".." || isAbsolute(rel)) {
    return [];
  }
  const words = new Set(bundle.pages.flatMap((page) => page.split("-"))
    .concat(bundle.files.filter((f) => f.path.endsWith("PAGE.md"))
      .flatMap((file) => [...file.content.matchAll(/^\s*-\s*`([a-z][\w.-]+)`/gm)]
        .flatMap((match) => (match[1] ?? "").split(/[.\-_]/))))
    .map((word) => word.toLowerCase()).filter((word) => word.length >= 3));
  const categories = ["layout", "table", "form", "token", "route", "theme", "test"];
  const excluded = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "vendor"]);
  const candidates: { path: string; score: number }[] = [];
  const queue: { path: string; depth: number }[] = [{ path: project, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 2000) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    for (const entry of await readdir(current.path, { withFileTypes: true }).catch(() => [])) {
      if (++visited > 2000) {
        break;
      }
      if (entry.isDirectory() && current.depth < 5 && !excluded.has(entry.name)) {
        queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
      } else if (entry.isFile() && /\.(?:tsx?|jsx?|vue|svelte|css|scss)$/.test(entry.name)) {
        const name = entry.name.toLowerCase();
        const score = [...words].filter((word) => name.includes(word)).length * 10 +
          categories.filter((category) => name.includes(category)).length;
        if (score > 0) {
          candidates.push({ path: relative(campRoot, join(current.path, entry.name)), score });
        }
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 30).map((item) => item.path);
}

async function existingBundle(festivalDir: string): Promise<ReferenceBundle> {
  if (!(await lstat(join(festivalDir, "references"))).isDirectory()) {
    throw new Error("Festival references must be a real directory");
  }
  const directory = join(festivalDir, "references", "pages");
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Festival has no real references/pages directory");
  }
  const pages = (await readdir(directory)).sort();
  const files: ReferenceBundle["files"] = [];
  for (const page of pages) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page) || !(await lstat(join(directory, page))).isDirectory()) {
      throw new Error(`Invalid existing page: ${page}`);
    }
    if ((await readdir(join(directory, page))).sort().join(",") !== "PAGE.md,wireframe.svg") {
      throw new Error(`Invalid existing page files: ${page}`);
    }
    const [reference] = await referencesForTask(festivalDir, `Visual reference: references/pages/${page}/PAGE.md`);
    if (!reference) {
      throw new Error(`Missing existing page: ${page}`);
    }
    files.push({ path: `pages/${page}/PAGE.md`, content: reference.content });
    files.push({ path: `pages/${page}/wireframe.svg`, content: await readFile(reference.wireframe, "utf8") });
  }
  return { pages, files };
}

export interface RevisionImpact {
  baseRevision: string;
  proposalRevision: string;
  changedPages: string[];
  addedPages: string[];
  removedPages: string[];
  affectedChecks: { page: string; ids: string[] }[];
  affectedTasks: { path: string; done: boolean; pages: string[]; checks: string[]; followUp?: string }[];
}

export async function inspectReferenceRevision(festivalDir: string, proposed: ReferenceBundle, detect: CampDetect): Promise<RevisionImpact> {
  const previous = await existingBundle(festivalDir);
  const changedPages = proposed.pages.filter((page) => previous.pages.includes(page) &&
    proposed.files.some((file) => file.path.startsWith(`pages/${page}/`) &&
      file.content !== previous.files.find((old) => old.path === file.path)?.content));
  const addedPages = proposed.pages.filter((page) => !previous.pages.includes(page));
  const removedPages = previous.pages.filter((page) => !proposed.pages.includes(page));
  const changed = new Set([...changedPages, ...removedPages, ...addedPages]);
  const affectedChecks = [...changed].map((page) => ({ page, ids: [...new Set([previous, proposed].flatMap((bundle) => {
    const spec = bundle.files.find((file) => file.path === `pages/${page}/PAGE.md`);
    return spec ? pageChecks(spec.content).map((check) => check.id) : [];
  }))] }));
  const affectedTasks = (await Promise.all((await detect.pendingTasks(festivalDir)).map(async (task) => {
    const doc = await readFile(join(festivalDir, task.path), "utf8");
    const pages = linkedPages(doc).filter((page) => changed.has(page));
    const checks = taskChecks(doc).filter((check) => changed.has(check.page)).map((check) => `${check.page}/${check.id}`);
    return { path: task.path, done: task.done, pages, checks,
      ...(task.done && pages.length ? { followUp: "Reverify these checks; propose targeted implementation follow-up only if needed. Do not silently reopen this completed task." } : {}) };
  }))).filter((task) => task.pages.length > 0);
  return { baseRevision: digest(previous), proposalRevision: digest(proposed),
    changedPages, addedPages, removedPages, affectedChecks, affectedTasks };
}

export async function applyReferenceRevision(
  festivalDir: string,
  bundle: ReferenceBundle,
  detect: CampDetect,
  baseRevision: string,
  proposalRevision: string,
): Promise<RevisionImpact> {
  return withVisualReferenceLock(festivalDir, () => applyRevisionLocked(festivalDir, bundle, detect, baseRevision, proposalRevision));
}

async function applyRevisionLocked(
  festivalDir: string,
  bundle: ReferenceBundle,
  detect: CampDetect,
  baseRevision: string,
  proposalRevision: string,
): Promise<RevisionImpact> {
  const impact = await inspectReferenceRevision(festivalDir, bundle, detect);
  if (!baseRevision || !proposalRevision || impact.baseRevision !== baseRevision || impact.proposalRevision !== proposalRevision) {
    throw new Error("References changed since the preview. Review the new impact and approve again before applying.");
  }
  if (impact.affectedTasks.some((task) => task.pages.some((page) => impact.removedPages.includes(page)))) {
    throw new Error("A removed page is still linked by a task. Revise those task links before applying.");
  }
  const paths = bundle.pages.flatMap((page) => [`pages/${page}/PAGE.md`, `pages/${page}/wireframe.svg`]);
  if (!bundle.pages.length || bundle.pages.length > MAX_PAGES ||
    bundle.pages.some((page) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(page)) ||
    new Set(bundle.pages).size !== bundle.pages.length ||
    bundle.files.length !== paths.length || new Set(bundle.files.map((file) => file.path)).size !== paths.length ||
    bundle.files.some((file) => !paths.includes(file.path))) {
    throw new Error("Revised references must have exactly PAGE.md and wireframe.svg per page");
  }
  const root = join(festivalDir, "references");
  const next = join(root, `.pages-next-${randomUUID()}`);
  const previous = join(root, `.pages-previous-${randomUUID()}`);
  await mkdir(next);
  try {
    for (const file of bundle.files) {
      const target = join(next, file.path.slice("pages/".length));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx" });
    }
    await rename(join(root, "pages"), previous);
    try {
      await rename(next, join(root, "pages"));
    } catch (error) {
      await rename(previous, join(root, "pages"));
      throw error;
    }
    await rm(previous, { recursive: true });
  } finally {
    await rm(next, { recursive: true, force: true });
  }
  return impact;
}
