import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CampDetect } from "../ports.js";

const REFERENCE_LINE = /^\s*Visual reference:\s*(\S.*?)\s*$/gim;
const REFERENCE_PATH = /^references\/pages\/([a-z0-9]+(?:-[a-z0-9]+)*)\/PAGE\.md$/;
const PAGE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PAGES = 40;
const SVG_ELEMENTS = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "desc"]);
const SVG_ATTRIBUTES = new Set([
  "xmlns", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "points", "d", "transform", "id", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray",
  "stroke-linecap", "stroke-linejoin", "font-family", "font-size", "font-weight", "text-anchor", "direction",
  "opacity", "dx", "dy", "dominant-baseline", "unicode-bidi", "font-style", "letter-spacing",
]);

export interface ReferenceBundle {
  pages: string[];
  files: { path: string; content: string }[];
}

export interface PageReference {
  page: string;
  spec: string;
  wireframe: string;
  content: string;
}

function checkSvg(svg: string): void {
  if (!/^\s*<svg(?:\s|>)/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
    throw new Error("Wireframe must be a standalone SVG document");
  }
  if (/<!|<\?|&(?!(?:amp|lt|gt|quot|apos);)|url\s*\(|(?:javascript|data):/i.test(svg)) {
    throw new Error("Wireframe contains active or external SVG content; use only inert shapes and text");
  }
  const tag = /<\/?([a-z][\w:-]*)([^<>]*)>/gi;
  const stack: string[] = [];
  let rooted = false;
  const remainder = svg.replace(tag, "");
  if (remainder.includes("<") || remainder.includes(">")) {
    throw new Error("Wireframe contains invalid markup");
  }
  for (const match of svg.matchAll(tag)) {
    const name = match[1];
    if (!name || !SVG_ELEMENTS.has(name)) {
      throw new Error(`Wireframe has an unsupported element: ${name}`);
    }
    if (match[0].startsWith("</")) {
      if (stack.pop() !== name || (match[2] ?? "").trim()) {
        throw new Error("Wireframe has mismatched closing tags");
      }
      continue;
    }
    if (stack.length === 0) {
      if (rooted || name !== "svg") {
        throw new Error("Wireframe needs a single svg root");
      }
      rooted = true;
    }
    if (!match[0].endsWith("/>")) {
      stack.push(name);
    }
    const attributes = (match[2] ?? "").replace(/\/$/, "");
    const attribute = /([\w:-]+)\s*=\s*(?:"[^"]*"|'[^']*')/g;
    for (const item of attributes.matchAll(attribute)) {
      if (!item[1] || !SVG_ATTRIBUTES.has(item[1])) {
        throw new Error(`Wireframe has an unsupported attribute: ${item[1]}`);
      }
      if (/\\|\/\*/.test(item[0])) {
        throw new Error("Wireframe attributes must not use CSS escapes or comments");
      }
    }
    if (attributes.replace(attribute, "").trim()) {
      throw new Error("Wireframe attributes must be quoted and supported");
    }
  }
  if (stack.length > 0) {
    throw new Error("Wireframe has unclosed elements");
  }
}

async function regularFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) {
    throw new Error(`Reference must be a regular file smaller than 1 MiB: ${path}`);
  }
  return readFile(path, "utf8");
}

export async function prepareVisualReferences(campRoot: string, plan: string, referencesDir: string): Promise<ReferenceBundle> {
  const plansRoot = await realpath(join(campRoot, ".ompfest", "plans"));
  const camp = await realpath(campRoot);
  const plansRelative = relative(camp, plansRoot);
  if (plansRelative.split(sep)[0] === ".." || isAbsolute(plansRelative)) {
    throw new Error("Plans directory must remain inside the camp");
  }
  const absolutePlan = resolve(plan);
  if (!isAbsolute(plan) || await realpath(dirname(absolutePlan)) !== plansRoot || !basename(plan).endsWith(".STRUCTURE.md")) {
    throw new Error("Visual plans must be in <camp>/.ompfest/plans/<name>.STRUCTURE.md");
  }
  const expected = join(plansRoot, `${basename(plan).slice(0, -".STRUCTURE.md".length)}.references`);
  if (!isAbsolute(referencesDir) || resolve(referencesDir) !== expected || !(await lstat(expected)).isDirectory()) {
    throw new Error("referencesDir must be the matching, non-symlink .references directory beside the plan");
  }
  const pagesDir = join(expected, "pages");
  if (!(await lstat(pagesDir)).isDirectory()) {
    throw new Error("referencesDir must contain a real pages directory");
  }
  const pageNames = await readdir(pagesDir);
  if (pageNames.length === 0 || pageNames.length > MAX_PAGES) {
    throw new Error(`Visual plan must have between 1 and ${MAX_PAGES} pages`);
  }
  const entries = await readdir(expected);
  if (entries.length !== 1 || entries[0] !== "pages") {
    throw new Error("Only the pages directory belongs in the visual reference bundle");
  }
  const files: ReferenceBundle["files"] = [];
  for (const page of pageNames) {
    if (!PAGE_SLUG_RE.test(page) || !(await lstat(join(pagesDir, page))).isDirectory()) {
      throw new Error(`Invalid page directory: ${page}`);
    }
    const path = join(pagesDir, page);
    const names = (await readdir(path)).sort();
    if (names.join(",") !== "PAGE.md,wireframe.svg") {
      throw new Error(`Page ${page} needs exactly PAGE.md and wireframe.svg`);
    }
    const spec = await regularFile(join(path, "PAGE.md"));
    const svg = await regularFile(join(path, "wireframe.svg"));
    if (!spec.trim()) {
      throw new Error(`Page ${page} has an empty specification`);
    }
    checkSvg(svg);
    files.push({ path: `pages/${page}/PAGE.md`, content: spec });
    files.push({ path: `pages/${page}/wireframe.svg`, content: svg });
  }
  return { pages: pageNames, files };
}

export async function installVisualReferences(festivalDir: string, bundle: ReferenceBundle): Promise<void> {
  const root = join(festivalDir, "references");
  const existing = await lstat(root).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (existing && !existing.isDirectory()) {
    throw new Error(`Festival references must be a real directory: ${root}`);
  }
  if (!existing) {
    await mkdir(root);
  }
  await mkdir(join(root, "pages"));
  for (const file of bundle.files) {
    const destination = join(root, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, { flag: "wx" });
  }
}

export function linkedPages(doc: string): string[] {
  return [...new Set([...doc.matchAll(REFERENCE_LINE)]
    .map((match) => REFERENCE_PATH.exec(match[1] ?? "")?.[1])
    .filter((page): page is string => page !== undefined))];
}

export async function referencesForTask(festivalDir: string, doc: string): Promise<PageReference[]> {
  const pages = linkedPages(doc);
  const references: PageReference[] = [];
  for (const page of pages) {
    const spec = join(festivalDir, "references", "pages", page, "PAGE.md");
    const wireframe = join(festivalDir, "references", "pages", page, "wireframe.svg");
    const content = await regularFile(spec);
    if (!content.trim()) {
      throw new Error(`Page ${page} has an empty specification`);
    }
    checkSvg(await regularFile(wireframe));
    references.push({ page, spec, wireframe, content });
  }
  return references;
}

export async function validateVisualReferences(festivalDir: string, detect: CampDetect): Promise<{ pages: string[]; issues: string[] }> {
  const root = join(festivalDir, "references");
  const info = await lstat(root).catch(() => undefined);
  const directory = join(root, "pages");
  const pageInfo = await lstat(directory).catch(() => undefined);
  const tasks = await detect.pendingTasks(festivalDir);
  const taskDocs = await Promise.all(tasks.map(async (task) => ({
    path: task.path,
    doc: await readFile(join(festivalDir, task.path), "utf8"),
  })));
  const linked = new Set(taskDocs.flatMap((task) => linkedPages(task.doc)));
  const issues: string[] = [];
  for (const task of taskDocs) {
    for (const match of task.doc.matchAll(REFERENCE_LINE)) {
      if (!REFERENCE_PATH.test(match[1] ?? "")) {
        issues.push(`Invalid visual reference in ${task.path}: ${match[1]}`);
      }
    }
  }
  if (!pageInfo && linked.size === 0 && issues.length === 0) {
    return { pages: [], issues: [] };
  }
  let pages: string[] = [];
  if (!info?.isDirectory()) {
    issues.push("Festival visual references directory is missing or not a directory");
  } else {
    if (!pageInfo?.isDirectory()) {
      issues.push("Festival references/pages directory is missing or is a symlink");
    }
    const pageEntries = pageInfo?.isDirectory() ? await readdir(directory) : [];
    pages = pageEntries.filter((page) => PAGE_SLUG_RE.test(page));
    if (pageEntries.length === 0) {
      issues.push("Festival references/pages has no pages");
    }
    for (const page of pageEntries) {
      if (!PAGE_SLUG_RE.test(page)) {
        issues.push(`Invalid page directory: ${page}`);
        continue;
      }
      try {
        if (!(await lstat(join(directory, page))).isDirectory()) {
          throw new Error("page directory must not be a symlink");
        }
        if ((await readdir(join(directory, page))).sort().join(",") !== "PAGE.md,wireframe.svg") {
          throw new Error("page needs exactly PAGE.md and wireframe.svg");
        }
        await referencesForTask(festivalDir, `Visual reference: references/pages/${page}/PAGE.md`);
      } catch (error) {
        issues.push(`Page ${page}: ${String(error)}`);
      }
      if (!linked.has(page)) {
        issues.push(`Page ${page} is not linked by any task document`);
      }
    }
  }
  for (const page of linked) {
    if (!pages.includes(page)) {
      issues.push(`Task links missing visual reference: references/pages/${page}/PAGE.md`);
    }
  }
  return { pages: pages.map((page) => relative(festivalDir, join(root, "pages", page, "PAGE.md"))), issues };
}
