import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withStaleAwareLock } from "./fs-lock.js";
import type { CampDetect } from "../ports.js";

const REFERENCE_LINE = /^\s*Visual reference:\s*(\S.*?)\s*$/gim;
const REFERENCE_PATH = /^references\/pages\/([a-z0-9]+(?:-[a-z0-9]+)*)\/PAGE\.md$/;
const PAGE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_PAGES = 250;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const SVG_ELEMENTS = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title", "desc"]);
const SVG_ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "version", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
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
  checks: { id: string; description: string }[];
}

const ACCEPTANCE_LINE = /^[ \t]*-[ \t]*\[[ xX]?\][ \t]*Acceptance:[ \t]*([a-z0-9]+(?:-[a-z0-9]+)*)\/(AC-\d+)[ \t]+[—:-][ \t]*\S[^\r\n]*$/gm;
const SVG_TAG = /<\/?([a-z][\w:-]*)([^<>]*)>/gi;
const SVG_ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function section(markdown: string, heading: string): string {
  const match = new RegExp(`^## ${heading}\\s*$`, "im").exec(markdown);
  if (!match) {
    throw new Error(`Page specification needs a ## ${heading} section`);
  }
  const rest = markdown.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

export function pageChecks(markdown: string): { id: string; description: string }[] {
  const lines = section(markdown, "Acceptance checks");
  const checks = [...lines.matchAll(/^[ \t]*-[ \t]*\[(AC-\d+)\][ \t]+([^\r\n]+)$/gm)]
    .map((m) => ({ id: m[1] ?? "", description: (m[2] ?? "").trim() }));
  const bullets = lines.split("\n").filter((line) => /^\s*-\s*\[/.test(line));
  if (!checks.length || checks.length !== bullets.length || checks.some((check) => !check.description) ||
    new Set(checks.map((c) => c.id)).size !== checks.length) {
    throw new Error("Page acceptance checks must have unique [AC-01] identifiers");
  }
  return checks;
}

export function taskChecks(markdown: string): { page: string; id: string }[] {
  return [...markdown.matchAll(ACCEPTANCE_LINE)].map((m) => ({ page: m[1] ?? "", id: m[2] ?? "" }));
}

function checkPageSpec(spec: string, svg: string): void {
  const components = [...section(spec, "Components").matchAll(/^\s*-\s*`([a-z][\w.-]+)`\s+.+$/gm)]
    .map((m) => m[1] ?? "");
  if (!components.length || new Set(components).size !== components.length) {
    throw new Error("Page components need unique backticked IDs");
  }
  const svgIds = new Set([...svg.matchAll(SVG_TAG)].flatMap((tag) => [...(tag[2] ?? "").matchAll(SVG_ATTRIBUTE)]
    .filter((attribute) => attribute[1] === "id").map((attribute) => attribute[2] ?? attribute[3] ?? "")));
  for (const id of components) {
    if (!svgIds.has(id)) {
      throw new Error(`Wireframe has no matching component ID: ${id}`);
    }
  }
  for (const id of svgIds) {
    if (!components.includes(id)) {
      throw new Error(`Wireframe component ID is not documented in PAGE.md: ${id}`);
    }
  }
  pageChecks(spec);
  const rows = section(spec, "States").split("\n").filter((line) => /^\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim().toLowerCase()));
  if (rows[0]?.join("|") !== "viewport|state|status|expected" ||
      !rows[1]?.every((cell) => /^:?-+:?$/.test(cell))) {
    throw new Error("Page states need a Viewport | State | Status | Expected table");
  }
  const states = rows.slice(2);
  const required = ["initial", "loading", "empty", "error"];
  if (states.some((row) => row.length !== 4 || !row.every(Boolean) || !["observed", "agreed", "unknown", "n/a"].includes(row[2] ?? "")) ||
      !states.some((row) => row[0] === "mobile") ||
      !states.some((row) => row[0] === "desktop") ||
      required.some((state) => !states.some((row) => row[1] === state))) {
    throw new Error("Document mobile and initial/loading/empty/error states as observed, agreed, unknown or n/a");
  }
}

export function validateWireframe(svg: string): void {
  if (!/^\s*<svg(?:\s|>)/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) {
    throw new Error("Wireframe must be a standalone SVG document");
  }
  if (/<!|<\?|&(?!(?:amp|lt|gt|quot|apos);)|url\s*\(|(?:javascript|data):/i.test(svg)) {
    throw new Error("Wireframe contains active or external SVG content; use only inert shapes and text");
  }
  const stack: string[] = [];
  const ids = new Set<string>();
  let rooted = false;
  const remainder = svg.replace(SVG_TAG, "");
  if (remainder.includes("<") || remainder.includes(">")) {
    throw new Error("Wireframe contains invalid markup");
  }
  for (const match of svg.matchAll(SVG_TAG)) {
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
    const names = new Set<string>();
    for (const item of attributes.matchAll(SVG_ATTRIBUTE)) {
      if (!item[1] || !SVG_ATTRIBUTES.has(item[1])) {
        throw new Error(`Wireframe has an unsupported attribute: ${item[1]}`);
      }
      if (names.has(item[1])) {
        throw new Error(`Wireframe has a duplicate attribute: ${item[1]}`);
      }
      names.add(item[1]);
      if (item[1] === "id") {
        const id = item[2] ?? item[3] ?? "";
        if (!/^[a-zA-Z_][\w.:-]*$/.test(id) || ids.has(id)) {
          throw new Error(`Wireframe has an invalid or duplicate component ID: ${id}`);
        }
        ids.add(id);
      }
      if (/\\|\/\*/.test(item[0])) {
        throw new Error("Wireframe attributes must not use CSS escapes or comments");
      }
    }
    if (attributes.replace(SVG_ATTRIBUTE, "").trim()) {
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
  const pageNames = (await readdir(pagesDir)).sort();
  if (pageNames.length === 0 || pageNames.length > MAX_PAGES) {
    throw new Error(`Visual plan must have between 1 and ${MAX_PAGES} pages`);
  }
  const entries = await readdir(expected);
  if (entries.length !== 1 || entries[0] !== "pages") {
    throw new Error("Only the pages directory belongs in the visual reference bundle");
  }
  const files: ReferenceBundle["files"] = [];
  let bundleBytes = 0;
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
    bundleBytes += Buffer.byteLength(spec, "utf8") + Buffer.byteLength(svg, "utf8");
    if (bundleBytes > MAX_BUNDLE_BYTES) {
      throw new Error(`Visual reference bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
    }
    if (!spec.trim()) {
      throw new Error(`Page ${page} has an empty specification`);
    }
    validateWireframe(svg);
    checkPageSpec(spec, svg);
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
    const root = join(festivalDir, "references");
    for (const directory of [root, join(root, "pages"), join(root, "pages", page)]) {
      if (!(await lstat(directory)).isDirectory()) {
        throw new Error(`Visual reference directory must not be a symlink: ${directory}`);
      }
    }
    const spec = join(festivalDir, "references", "pages", page, "PAGE.md");
    const wireframe = join(festivalDir, "references", "pages", page, "wireframe.svg");
    const content = await regularFile(spec);
    if (!content.trim()) {
      throw new Error(`Page ${page} has an empty specification`);
    }
    const svg = await regularFile(wireframe);
    validateWireframe(svg);
    checkPageSpec(content, svg);
    references.push({ page, spec, wireframe, content, checks: pageChecks(content) });
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
  const coverage = taskDocs.flatMap((task) => taskChecks(task.doc).map((check) => ({ ...check, task: task.path })));
  for (const task of taskDocs) {
    const acceptance = taskChecks(task.doc);
    const lines = task.doc.split("\n").filter((line) => /^\s*-.*Acceptance:/i.test(line));
    if ((linkedPages(task.doc).length || pageInfo) &&
      (lines.length !== acceptance.length || new Set(acceptance.map((check) => `${check.page}/${check.id}`)).size !== acceptance.length)) {
      issues.push(`Invalid or duplicate acceptance marker in ${task.path}`);
    }
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
        const [reference] = await referencesForTask(festivalDir, `Visual reference: references/pages/${page}/PAGE.md`);
        const expected = new Set(reference?.checks.map((check) => check.id));
        for (const check of reference?.checks ?? []) {
          if (!coverage.some((entry) => entry.page === page && entry.id === check.id &&
            taskDocs.some((task) => task.path === entry.task && linkedPages(task.doc).includes(page)))) {
            issues.push(`Page ${page}/${check.id} has no linked task Done-When`);
          }
        }
        for (const entry of coverage.filter((item) => item.page === page && !expected.has(item.id))) {
          issues.push(`Unknown acceptance check ${page}/${entry.id} in ${entry.task}`);
        }
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
  for (const entry of coverage) {
    const task = taskDocs.find((item) => item.path === entry.task);
    if (task && !linkedPages(task.doc).includes(entry.page)) {
      issues.push(`Acceptance check ${entry.page}/${entry.id} in ${entry.task} needs a visual reference link`);
    }
  }
  return { pages: pages.map((page) => relative(festivalDir, join(root, "pages", page, "PAGE.md"))), issues };
}

export async function withVisualReferenceLock<T>(festivalDir: string, action: () => Promise<T>): Promise<T> {
  const root = join(festivalDir, "references");
  if (!(await lstat(root)).isDirectory()) {
    throw new Error("Visual references must be a real directory");
  }
  try {
    return await withStaleAwareLock(join(root, ".ompfest-visual.lock"), action, { label: "Visual references", busyMs: 2_000 });
  } catch (error) {
    if (error instanceof Error && error.name === "LockBusyError") {
      throw new Error("Visual references are locked by another writer; retry shortly", { cause: error });
    }
    throw error;
  }
}
