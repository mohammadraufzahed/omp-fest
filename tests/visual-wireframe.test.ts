import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { registerTools, type PiLike } from "../src/adapters/omp/tools.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import { prepareVisualReferences, validateWireframe } from "../src/application/visual-references.js";
import type { CampCli, FestCli } from "../src/ports.js";

type ToolExecute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
const schema = (): { optional(): unknown; describe(): unknown } => ({ optional: schema, describe: schema });
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("fest_wireframe_create", () => {
  it("writes a validated, repeatable, categorized SVG and page spec from inspected component paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "wireframe-tool-"));
    roots.push(root);
    await mkdir(join(root, "src", "components"), { recursive: true });
    await mkdir(join(root, ".ompfest", "plans", "page.references", "pages", "staff-selection"), { recursive: true });
    await writeFile(join(root, ".ompfest", "plans", "page.STRUCTURE.md"), "# Visual plan\n");
    await writeFile(join(root, "src", "components", "Checkbox.ts"), "export const Checkbox = true;\n");
    const tools = new Map<string, ToolExecute>();
    registerTools({
      zod: { object: schema, string: schema, number: schema, boolean: schema, enum: schema, array: schema } as never,
      registerTool: (tool) => tools.set(tool.name as string, tool.execute as ToolExecute),
    } satisfies PiLike, {
      fest: {} as FestCli,
      camp: { projects: () => Promise.resolve([]) } as unknown as CampCli,
      detect: new CampFsDetect(),
      tracker: new LoopTracker(),
    });

    const call = tools.get("fest_wireframe_create");
    expect(call).toBeDefined();
    const params = {
      attachmentRole: "ui_design",
      outputDirectory: ".ompfest/plans/page.references/pages/staff-selection",
      spec: {
        title: "Staff selection",
        slug: "staff-selection",
        direction: "rtl",
        source: { width: 640, height: 360, displayWidth: 640, displayHeight: 360 },
        components: [
          { id: "staff.checkbox", category: "Permission Controls", parent: "dialog.panel", role: "staff row checkbox", kind: "tri-state-permission-control", renderAs: "checkbox", x: 552, y: 54, width: 24, height: 24, radius: 3, state: "checked" },
          { id: "staff.name", parent: "dialog.panel", role: "staff name text bar", kind: "text", x: 400, y: 60, width: 112, height: 9 },
          { id: "dialog.panel", category: "Overlay / Approval", role: "dialog surface", kind: "surface", x: 12, y: 14, width: 600, height: 330, radius: 18, fill: "#ffffff", stroke: "#dfe3ea", styles: [{ property: "radius", value: "18px", status: "estimated" }] },
        ],
        componentAudit: [{ component: "checkbox", status: "matched", sourcePaths: ["src/components/Checkbox.ts"], notes: "Existing checkbox inspected; radius differs from screenshot estimate." }],
        measurements: [{ label: "checkbox to name gap", from: "staff.checkbox", to: "staff.name", value: 18, status: "estimated" }],
        states: [{ viewport: "desktop", state: "initial", status: "observed", expected: "One selected row and role-sized name bar." }],
        openQuestions: ["Is the selected-state violet shared with the existing checkbox token?"]
      }
    };
    const result = JSON.parse((await call!("test", params, undefined, undefined, { cwd: root })).content[0]!.text) as {
      kind: string; svgPath: string; pagePath: string; componentCount: number; openQuestions: string[];
    };

    expect(result.kind).toBe("wireframe_created");
    expect(result.componentCount).toBe(3);
    expect(result.openQuestions).toEqual(params.spec.openQuestions);
    const svg = await readFile(result.svgPath, "utf8");
    const page = await readFile(result.pagePath, "utf8");
    validateWireframe(svg);
    expect(svg).toContain("PAGE SNAPSHOT");
    expect(svg).toContain("PROJECT REUSE AUDIT");
    const nameBar = /<rect\b(?=[^>]*\bid="staff\.name")[^>]*>/.exec(svg)?.[0];
    const nameBarHeight = Number(/\bheight="([^"]+)"/.exec(nameBar ?? "")?.[1]);
    expect(nameBarHeight).toBeGreaterThan(0);
    expect(nameBarHeight).toBeLessThan(params.spec.components[1]!.height);
    expect(svg.indexOf('id="dialog.panel"')).toBeLessThan(svg.indexOf('id="staff.checkbox"'));
    expect(svg).toContain('id="staff.checkbox"');
    expect(svg).toContain('id="variant.staff.checkbox.state"');
    expect(page).toContain("variant.staff.checkbox.state");
    expect(page).toContain("observed state `checked`");
    expect(page).toContain("### Permission Controls");
    expect(page).toContain("kind: `tri-state-permission-control`");
    expect(page).toContain("src/components/Checkbox\\.ts");
    expect(page).toContain("radius: 18px");
    expect(page).toContain("| mobile | initial | unknown |");
    expect(page).toContain("## States");
    expect(page).toContain("[AC-01] Every visible element has a stable ID");
    const bundle = await prepareVisualReferences(root, join(root, ".ompfest", "plans", "page.STRUCTURE.md"), join(root, ".ompfest", "plans", "page.references"));
    expect(bundle.pages).toEqual(["staff-selection"]);
    expect(page).toContain("checkbox to name gap");

    const repeated = JSON.parse((await call!("test", params, undefined, undefined, { cwd: root })).content[0]!.text) as typeof result;
    expect(await readFile(repeated.svgPath, "utf8")).toBe(svg);
    expect(await readFile(repeated.pagePath, "utf8")).toBe(page);
  });

  it("resolves audit source paths from an explicitly selected linked project, not the camp cwd", async () => {
    const campRoot = await mkdtemp(join(tmpdir(), "wireframe-camp-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "wireframe-linked-project-"));
    roots.push(campRoot, projectRoot);
    await mkdir(join(campRoot, "festivals", "planning"), { recursive: true });
    await mkdir(join(campRoot, "projects"), { recursive: true });
    await mkdir(join(campRoot, ".ompfest", "plans"), { recursive: true });
    await mkdir(join(projectRoot, "src", "components"), { recursive: true });
    await writeFile(join(projectRoot, "src", "components", "SearchBox.tsx"), "export const SearchBox = () => null;\n");
    await symlink(projectRoot, join(campRoot, "projects", "web"));
    await mkdir(join(campRoot, "projects", "mobile"));
    const tools = new Map<string, ToolExecute>();
    registerTools({
      zod: { object: schema, string: schema, number: schema, boolean: schema, enum: schema, array: schema } as never,
      registerTool: (tool) => tools.set(tool.name as string, tool.execute as ToolExecute),
    } satisfies PiLike, {
      fest: {} as FestCli,
      camp: { projects: () => Promise.resolve([]) } as unknown as CampCli,
      detect: new CampFsDetect(),
      tracker: new LoopTracker(),
    });
    const call = tools.get("fest_wireframe_create")!;
    const spec = {
      title: "Search", slug: "search", direction: "ltr" as const,
      source: { width: 100, height: 100, displayWidth: 100, displayHeight: 100 },
      components: [{ id: "search.input", role: "search input", kind: "text-field", x: 0, y: 0, width: 80, height: 20 }],
      componentAudit: [{ component: "SearchBox", status: "matched" as const, sourcePaths: ["src/components/SearchBox.tsx"], notes: "Inspected the linked project's search component." }],
      measurements: [], states: [], openQuestions: [],
    };
    const params = {
      attachmentRole: "ui_design",
      outputDirectory: ".ompfest/plans/search.references/pages/search",
      spec,
    };
    const ambiguous = JSON.parse((await call("test", params, undefined, undefined, { cwd: campRoot })).content[0]!.text) as { code: string; candidates: string[] };
    expect(ambiguous.code).toBe("WORKING_DIR_REQUIRED");
    expect(ambiguous.candidates).toEqual(expect.arrayContaining(["projects/mobile", "projects/web"]));
    const result = JSON.parse((await call("test", { ...params, workingDir: "projects/web" }, undefined, undefined, { cwd: campRoot })).content[0]!.text) as {
      kind: string; pagePath: string; auditWarnings: unknown[]; pathPolicy: { workingDir: string; outputDirectoryBase: string };
    };
    expect(result).toMatchObject({
      kind: "wireframe_created", auditWarnings: [],
      pathPolicy: { workingDir: "projects/web", outputDirectoryBase: "camp root" },
    });
    expect(result.pagePath).toBe(join(campRoot, ".ompfest", "plans", "search.references", "pages", "search", "PAGE.md"));
  });

  it("rejects invalid screenshot geometry and output paths that escape the camp root", async () => {
    const root = await mkdtemp(join(tmpdir(), "wireframe-tool-invalid-"));
    roots.push(root);
    await writeFile(join(root, "README.md"), "# Component search notes\n");
    const tools = new Map<string, ToolExecute>();
    registerTools({
      zod: { object: schema, string: schema, number: schema, boolean: schema, enum: schema, array: schema } as never,
      registerTool: (tool) => tools.set(tool.name as string, tool.execute as ToolExecute),
    } satisfies PiLike, { fest: {} as FestCli, camp: { projects: () => Promise.resolve([]) } as unknown as CampCli, detect: new CampFsDetect(), tracker: new LoopTracker() });
    const call = tools.get("fest_wireframe_create")!;
    const result = JSON.parse((await call("test", {
      attachmentRole: "ui_design",
      outputDirectory: ".wireframe",
      spec: {
        title: "Broken", slug: "broken", direction: "ltr",
        source: { width: 100, height: 100, displayWidth: 100, displayHeight: 100 },
        components: [{ id: "out-of-bounds", role: "invalid", kind: "surface", x: 90, y: 90, width: 20, height: 20 }],
        componentAudit: [{ component: "surface", status: "no_match", sourcePaths: ["README.md"], notes: "Inspected." }], measurements: [], states: [], openQuestions: [],
      }
    }, undefined, undefined, { cwd: root })).content[0]!.text) as { kind: string; error: string };
    expect(result.kind).toBe("wireframe_failed");
    expect(result.error).toContain("bounds");
    const escaped = JSON.parse((await call("test", {
      attachmentRole: "ui_design",
      outputDirectory: "../outside",
      spec: {
        title: "Valid", slug: "valid", direction: "ltr",
        source: { width: 100, height: 100, displayWidth: 100, displayHeight: 100 },
        components: [{ id: "inside", role: "in-bounds", kind: "surface", x: 0, y: 0, width: 20, height: 20 }],
        componentAudit: [{ component: "dialog", status: "no_match", sourcePaths: ["README.md"], notes: "Inspected the available project inventory; no matching component source." }], measurements: [], states: [], openQuestions: [],
      },
    }, undefined, undefined, { cwd: root })).content[0]!.text) as { kind: string; error: string };
    expect(escaped.kind).toBe("wireframe_failed");
    expect(escaped.error).toContain("outputDirectory");
    const missingAudit = JSON.parse((await call("test", {
      attachmentRole: "ui_design",
      outputDirectory: ".wireframe",
      spec: {
        title: "Audit path", slug: "audit-path", direction: "ltr",
        source: { width: 100, height: 100, displayWidth: 100, displayHeight: 100 },
        components: [{ id: "inside", role: "in-bounds", kind: "surface", x: 0, y: 0, width: 20, height: 20 }],
        componentAudit: [{ component: "dialog", status: "no_match", sourcePaths: ["src/missing-dialog.tsx", "src/missing-button.tsx"], notes: "No matching component found." }],
        measurements: [], states: [], openQuestions: [],
      },
    }, undefined, undefined, { cwd: root })).content[0]!.text) as {
      kind: string; pagePath: string; svgPath: string; auditWarnings: { component: string; missingPaths: string[] }[];
    };
    expect(missingAudit.kind).toBe("wireframe_created");
    expect(missingAudit.auditWarnings).toEqual([{
      component: "dialog",
      missingPaths: ["src/missing-dialog.tsx", "src/missing-button.tsx"],
    }]);
    const auditPage = await readFile(missingAudit.pagePath, "utf8");
    const auditSvg = await readFile(missingAudit.svgPath, "utf8");
    expect(auditPage).toContain("unverified; inspected paths: none verified");
    expect(auditPage).toContain("paths not found and not counted as evidence");
    expect(auditSvg).toContain("inside");
    const invalidAudit = await call("test", {
      attachmentRole: "ui_design",
      outputDirectory: "audit-errors",
      spec: {
        title: "Audit diagnostics", slug: "audit-errors", direction: "ltr",
        source: { width: 100, height: 100, displayWidth: 100, displayHeight: 100 },
        components: [{ id: "inside", role: "surface", kind: "surface", x: 0, y: 0, width: 20, height: 20 }],
        componentAudit: [
          { component: "PersonnelDetailsModal", status: "matched", sourcePaths: ["README.md"], notes: "x".repeat(301) },
          { component: "EmptyAudit", status: "no_match", sourcePaths: [], notes: "" },
        ],
        measurements: [], states: [], openQuestions: [],
      },
    }, undefined, undefined, { cwd: root });
    const auditFailure: unknown = JSON.parse(invalidAudit.content[0]!.text);
    expect(auditFailure).toMatchObject({
      kind: "wireframe_failed",
      diagnostics: [
        { code: "AUDIT_NOTES_TOO_LONG", field: "spec.componentAudit[0].notes", component: "PersonnelDetailsModal" },
        { code: "AUDIT_NOTES_REQUIRED", field: "spec.componentAudit[1].notes" },
        { code: "AUDIT_PATHS_REQUIRED", field: "spec.componentAudit[1].sourcePaths" },
      ],
    });
    expect(invalidAudit.content[0]!.text).toContain("301 characters; maximum is 300");
    const rejected: unknown = JSON.parse((await call("test", { attachmentRole: "error_screenshot", outputDirectory: "must-not-write", spec: {} }, undefined, undefined, { cwd: root })).content[0]!.text);
    expect(rejected).toMatchObject({ kind: "wireframe_blocked", code: "NOT_UI_DESIGN", received: "error_screenshot" });
    await expect(readFile(join(root, "must-not-write", "PAGE.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
