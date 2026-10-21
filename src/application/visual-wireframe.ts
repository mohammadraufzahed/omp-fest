import { SVG, withWindow, type Svg } from "@svgdotjs/svg.js";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { createSVGWindow } from "svgdom";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type WireframeCategory = string;
export type WireframeKind = string;
export type WireframePrimitive = "rectangle" | "text-bar" | "line" | "circle" | "ellipse" | "chevron" | "checkbox";
export type EvidenceStatus = "observed" | "estimated" | "unknown" | "agreed" | "n/a";
export type StateStatus = "observed" | "unknown" | "agreed" | "n/a";

export interface WireframeStyle {
  property: string;
  value: string;
  status: EvidenceStatus;
}

export interface WireframeComponent {
  id: string;
  category?: WireframeCategory;
  renderAs?: WireframePrimitive;
  parent?: string;
  role: string;
  kind: WireframeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  state?: string;
  styles?: WireframeStyle[];
}

export interface WireframeState {
  viewport: string;
  state: string;
  status: StateStatus;
  expected: string;
}

export interface WireframeSpec {
  title: string;
  slug: string;
  direction: "ltr" | "rtl";
  source: { width: number; height: number; displayWidth: number; displayHeight: number };
  components: WireframeComponent[];
  states: WireframeState[];
  componentAudit: WireframeComponentAudit[];
  openQuestions: string[];
  measurements: WireframeMeasurement[];
}

export interface WireframeComponentAudit {
  component: string;
  status: "matched" | "no_match";
  sourcePaths: string[];
  notes: string;
}

export interface WireframeAuditWarning {
  component: string;
  missingPaths: string[];
}

export interface WireframeMeasurement {
  label: string;
  from: string;
  to: string;
  value: number;
  status: EvidenceStatus;
}

const ID = /^[a-z][a-z0-9.-]{0,79}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/;
const STATUSES = new Set<EvidenceStatus>(["observed", "estimated", "unknown", "agreed", "n/a"]);
const MAX_COMPONENTS = 500;
const MAX_TEXT = 300;
const PRIMITIVES = new Set<WireframePrimitive>(["rectangle", "text-bar", "line", "circle", "ellipse", "chevron", "checkbox"]);
function componentCategory(component: WireframeComponent): string {
  if (component.category?.trim()) return component.category.trim();
  const id = component.id.toLowerCase();
  if (id.includes("status") || /badge|pill/.test(component.role.toLowerCase())) return "Status";
  if (id.startsWith("header.")) return "Header";
  if (id.startsWith("page.") || id.startsWith("content.") || id.includes("panel") || id.includes("surface")) return "Page structure";
  if (/^(search|filter)\./.test(id)) return "Search and filters";
  if (/^(table|row)\./.test(id)) return "Data table";
  if (id.includes("action")) return "Actions";
  const root = id.split(".")[0] ?? "Other";
  return root.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function componentGroups(spec: WireframeSpec): [string, WireframeComponent[]][] {
  const groups = new Map<string, WireframeComponent[]>();
  for (const component of spec.components) {
    const category = componentCategory(component);
    const entries = groups.get(category) ?? [];
    entries.push(component);
    groups.set(category, entries);
  }
  return [...groups.entries()];
}

function drawingOrder(spec: WireframeSpec): WireframeComponent[] {
  const byId = new Map(spec.components.map((component) => [component.id, component]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: WireframeComponent[] = [];
  const visit = (component: WireframeComponent) => {
    if (visited.has(component.id)) return;
    if (visiting.has(component.id)) throw new Error(`component hierarchy contains a cycle at ${component.id}`);
    visiting.add(component.id);
    const parent = component.parent ? byId.get(component.parent) : undefined;
    if (parent) visit(parent);
    visiting.delete(component.id);
    visited.add(component.id);
    ordered.push(component);
  };
  for (const component of spec.components) visit(component);
  return ordered;
}

function primitive(component: WireframeComponent): WireframePrimitive {
  if (component.renderAs) return component.renderAs;
  switch (component.kind) {
    case "checkbox": return "checkbox";
    case "circle": return "circle";
    case "divider": return "line";
    case "chevron": return "chevron";
    case "text": return "text-bar";
    default: return "rectangle";
  }
}

function md(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\x5B\x5D()#+.!|]/g, "\\$&").replace(/\r?\n/g, " ");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function validate(spec: WireframeSpec, workingDirectory: string): Promise<WireframeAuditWarning[]> {
  if (!spec.title.trim() || spec.title.length > MAX_TEXT) {
    throw new Error("title must be a non-empty string up to 300 characters");
  }
  if (!SLUG.test(spec.slug)) throw new Error("slug must be lowercase kebab-case");
  const source = spec.source;
  if (![source.width, source.height, source.displayWidth, source.displayHeight].every(finite) ||
      source.width <= 0 || source.height <= 0 || source.displayWidth <= 0 || source.displayHeight <= 0) {
    throw new Error("source dimensions must be positive finite numbers");
  }
  if (!Array.isArray(spec.components) || spec.components.length === 0 || spec.components.length > MAX_COMPONENTS) {
    throw new Error(`components must contain 1–${MAX_COMPONENTS} entries`);
  }
  if (!Array.isArray(spec.states) || !Array.isArray(spec.openQuestions) || !Array.isArray(spec.componentAudit) || !Array.isArray(spec.measurements)) {
    throw new Error("states, componentAudit, measurements and openQuestions must be arrays");
  }
  if (spec.componentAudit.length === 0) throw new Error("componentAudit must include at least one inspected match or no-match result");
  const ids = new Set<string>(["screen.frame"]);
  for (const component of spec.components) {
    if (!ID.test(component.id) || ids.has(component.id)) throw new Error(`invalid or duplicate component id: ${component.id}`);
    ids.add(component.id);
    if (component.parent && !ID.test(component.parent)) throw new Error(`invalid parent id for ${component.id}`);
    if (typeof component.role !== "string" || !component.role.trim() || component.role.length > MAX_TEXT) throw new Error(`invalid role for ${component.id}`);
    if (typeof component.kind !== "string" || !component.kind.trim() || component.kind.length > 80) throw new Error(`invalid semantic kind for ${component.id}`);
    if (component.category !== undefined && (typeof component.category !== "string" || !component.category.trim() || component.category.length > 80)) throw new Error(`invalid category for ${component.id}`);
    if (component.renderAs !== undefined && !PRIMITIVES.has(component.renderAs)) throw new Error(`unsupported render primitive for ${component.id}`);
    if (![component.x, component.y, component.width, component.height].every(finite) || component.x < 0 || component.y < 0 ||
        component.width <= 0 || component.height <= 0 || component.x + component.width > source.width || component.y + component.height > source.height) {
      throw new Error(`component bounds must be positive and inside source dimensions: ${component.id}`);
    }
    if (component.radius !== undefined && (!finite(component.radius) || component.radius < 0)) throw new Error(`invalid radius for ${component.id}`);
    for (const [name, color] of [["fill", component.fill], ["stroke", component.stroke]] as const) {
      if (color !== undefined && !COLOR.test(color)) throw new Error(`${name} must be a hex color for ${component.id}`);
    }
    if (component.strokeWidth !== undefined && (!finite(component.strokeWidth) || component.strokeWidth < 0)) throw new Error(`invalid strokeWidth for ${component.id}`);
    if (component.styles) for (const style of component.styles) {
      if (!style.property.trim() || !style.value.trim() || style.property.length > 80 || style.value.length > MAX_TEXT || !STATUSES.has(style.status)) {
        throw new Error(`invalid style evidence for ${component.id}`);
      }
    }
  }
  for (const component of observedStateSamples(spec)) {
    const variant = variantId(component);
    if (!ID.test(variant) || ids.has(variant)) throw new Error(`invalid or duplicate state specimen id: ${variant}`);
    ids.add(variant);
  }
  const missingAuditPaths = new Map<string, string[]>();
  const audited = new Set<string>();
  for (const entry of spec.componentAudit) {
    if (!entry.component.trim() || entry.component.length > MAX_TEXT || audited.has(entry.component)) {
      throw new Error(`invalid or duplicate component audit entry: ${entry.component}`);
    }
    audited.add(entry.component);
    if (!entry.notes.trim() || entry.notes.length > MAX_TEXT || !entry.sourcePaths.length) {
      throw new Error(`component audit requires inspected paths and notes: ${entry.component}`);
    }
    for (const sourcePath of entry.sourcePaths) {
      if (isAbsolute(sourcePath)) throw new Error(`component audit paths must be relative: ${sourcePath}`);
      const resolved = resolve(workingDirectory, sourcePath);
      const projectPath = relative(resolve(workingDirectory), resolved);
      if (projectPath === ".." || projectPath.startsWith(`..${sep}`) || isAbsolute(projectPath)) {
        throw new Error(`component audit path escapes the project: ${sourcePath}`);
      }
      const info = await lstat(resolved).catch(() => undefined);
      if (!info) {
        const missing = missingAuditPaths.get(entry.component) ?? [];
        missing.push(sourcePath);
        missingAuditPaths.set(entry.component, missing);
        continue;
      }
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        throw new Error(`component audit path must be a regular file or directory: ${sourcePath}`);
      }
      const actual = await realpath(resolved);
      const actualRelative = relative(resolve(workingDirectory), actual);
      if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
        throw new Error(`component audit path resolves outside the project: ${sourcePath}`);
      }
    }
  }
  const auditWarnings = [...missingAuditPaths].map(([component, missingPaths]) => ({ component, missingPaths }));
  for (const component of spec.components) if (component.parent && !ids.has(component.parent)) throw new Error(`missing parent ${component.parent} for ${component.id}`);
  for (const state of spec.states) {
    if (!state.viewport.trim() || !state.state.trim() || !state.expected.trim() ||
        !["observed", "unknown", "agreed", "n/a"].includes(state.status)) throw new Error("invalid state evidence");
  }
  for (const measurement of spec.measurements) {
    if (!measurement.label.trim() || !measurement.from.trim() || !measurement.to.trim() || measurement.label.length > MAX_TEXT ||
        !finite(measurement.value) || measurement.value < 0 || !STATUSES.has(measurement.status) ||
        !ids.has(measurement.from) || !ids.has(measurement.to)) {
      throw new Error(`invalid measurement: ${measurement.label}`);
    }
  }
  for (const question of spec.openQuestions) if (typeof question !== "string" || !question.trim() || question.length > MAX_TEXT) throw new Error("open questions must be non-empty strings up to 300 characters");
  return auditWarnings;
}
function coveredStates(spec: WireframeSpec): WireframeState[] {
  const states = [...spec.states];
  const required: [string, string][] = [["desktop", "initial"], ["mobile", "initial"], ["desktop", "loading"], ["desktop", "empty"], ["desktop", "error"]];
  for (const [viewport, name] of required) {
    if (!states.some((entry) => entry.viewport === viewport && entry.state === name)) {
      states.push({ viewport, state: name, status: "unknown", expected: "Not shown in supplied evidence." });
    }
  }
  return states;
}

function observedStateSamples(spec: WireframeSpec): WireframeComponent[] {
  const unique = new Map<string, WireframeComponent>();
  for (const component of spec.components) {
    if (!component.state) continue;
    const signature = JSON.stringify([component.kind, component.state, component.fill, component.stroke, component.strokeWidth, component.radius]);
    if (!unique.has(signature)) unique.set(signature, component);
  }
  return [...unique.values()];
}

function variantId(component: WireframeComponent): string {
  return `variant.${component.id}.state`;
}

function renderSvg(spec: WireframeSpec, auditWarnings: WireframeAuditWarning[]): string {
  const { width, height, displayWidth, displayHeight } = spec.source;
  const railX = width + 64;
  const railWidth = 620;
  const viewWidth = railX + railWidth + 32;
  const screenY = 72;
  const groups = componentGroups(spec);
  const specimens = observedStateSamples(spec);
  const categoryCards = groups.slice(0, 8);
  const categoryRows = Math.ceil(categoryCards.length / 2);
  const auditY = 184 + categoryRows * 112 + (groups.length > 8 ? 42 : 0);
  const auditHeight = 46 + Math.min(spec.componentAudit.length, 3) * 33;
  const stateY = auditY + auditHeight + 14;
  const stateHeight = 68 + Math.min(coveredStates(spec).length, 4) * 18 + Math.min(spec.openQuestions.length, 2) * 18;
  const sampleY = stateY + stateHeight + 14;
  const sampleHeight = specimens.length ? 54 + specimens.length * 26 : 0;
  const measureY = sampleY + sampleHeight + 14;
  const lowerHeight = 64 + Math.min(spec.measurements.length, 4) * 18;
  const bottom = Math.max(screenY + height + 32, measureY + lowerHeight + 24);
  const multiplier = (displayWidth / width).toFixed(3);
  const window = createSVGWindow();

  return withWindow(window, () => {
    const drawing = SVG(window.document.documentElement) as Svg;
    drawing.size(viewWidth, bottom).viewbox(0, 0, viewWidth, bottom);
    drawing.attr({ xmlns: "http://www.w3.org/2000/svg" });
    drawing.rect(viewWidth, bottom).move(0, 0).fill("#f7f8fb");

    const addText = (x: number, y: number, value: string, size: number, color: string, weight = 400, anchor?: string) => {
      const barWidth = Math.min(580, Math.max(4, value.length * size * 0.52));
      const barHeight = Math.max(2, size * (weight >= 600 ? 0.38 : 0.3));
      const left = anchor === "end" ? x - barWidth : anchor === "middle" ? x - barWidth / 2 : x;
      drawing.rect(barWidth, barHeight).move(left, y + size * 0.48).radius(barHeight / 2).fill(color);
    };
    const short = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    const card = (x: number, y: number, w: number, h: number, title: string, detail?: string) => {
      drawing.rect(w, h).move(x, y).radius(9).fill("#ffffff").stroke({ color: "#e2e7f0", width: 1 });
      addText(x + 14, y + 9, title, 13, "#34478f", 700);
      if (detail) addText(x + w - 14, y + 10, detail, 10, "#778196", 400, "end");
    };

    addText(24, 10, short(spec.title, 48), 18, "#273653", 700);
    addText(24, 35, `${spec.direction.toUpperCase()} · SOURCE-GROUNDED PAGE MAP · ${spec.components.length} nodes`, 11, "#69758b");
    addText(viewWidth - 24, 16, `SOURCE ${width}×${height}px   DISPLAY ${displayWidth}×${displayHeight}px   SCALE ${multiplier}×`, 11, "#69758b", 500, "end");
    drawing.rect(width, height).move(24, screenY).radius(4).fill("#f0f1f4")
      .stroke({ color: "#cbd2df", width: 1.2 }).attr({ id: "screen.frame" });

    for (const component of drawingOrder(spec)) {
      const x = component.x + 24;
      const y = component.y + screenY;
      const shape = primitive(component);
      const fill = component.fill ?? (shape === "text-bar" ? "#55585f" : "#ffffff");
      const stroke = component.stroke ?? (shape === "text-bar" ? "none" : "#b9c2d0");
      const strokeWidth = component.strokeWidth ?? 1.2;
      const radius = component.radius ?? (shape === "text-bar" ? Math.min(3, component.height / 2) : 4);
      const checked = /checked|selected/i.test(component.state ?? "");

      if (shape === "checkbox") {
        const group = drawing.group().attr({ id: component.id });
        group.rect(component.width, component.height).move(x, y).radius(radius)
          .fill(checked ? (component.fill ?? "#36479a") : fill)
          .stroke({ color: checked ? (component.fill ?? "#36479a") : stroke, width: strokeWidth });
        if (checked) group.path(`M ${x + component.width * 0.2} ${y + component.height * 0.52} L ${x + component.width * 0.43} ${y + component.height * 0.75} L ${x + component.width * 0.82} ${y + component.height * 0.25}`)
          .fill("none").stroke({ color: "#ffffff", width: Math.max(1.5, component.width * 0.11), linecap: "round", linejoin: "round" });
      } else if (shape === "circle" || shape === "ellipse") {
        drawing.ellipse(component.width, component.height).move(x, y).fill(fill)
          .stroke({ color: stroke, width: strokeWidth }).attr({ id: component.id });
      } else if (shape === "line") {
        drawing.line(x, y, x + component.width, y + component.height).stroke({ color: stroke, width: strokeWidth })
          .attr({ id: component.id });
      } else if (shape === "chevron") {
        drawing.path(`M ${x} ${y} L ${x + component.width / 2} ${y + component.height} L ${x + component.width} ${y}`)
          .fill("none").stroke({ color: stroke, width: strokeWidth, linecap: "round", linejoin: "round" })
          .attr({ id: component.id });
      } else if (shape === "text-bar") {
        const inkHeight = Math.min(component.height, Math.max(2, component.height * 0.2));
        drawing.rect(component.width, inkHeight).move(x, y + (component.height - inkHeight) / 2)
          .radius(Math.min(radius, inkHeight / 2)).fill(fill)
          .stroke({ color: stroke, width: strokeWidth }).attr({ id: component.id });
      } else {
        drawing.rect(component.width, component.height).move(x, y).radius(radius).fill(fill)
          .stroke({ color: stroke, width: strokeWidth }).attr({ id: component.id });
      }
    }

    drawing.line(width + 44, screenY, width + 44, screenY + height).stroke({ color: "#d8deea", width: 1 });
    card(railX, 72, railWidth, 96, "PAGE SNAPSHOT", `${groups.length} categories`);
    const statY = 104;
    const stats = [
      [`${spec.components.length}`, "components"],
      [`${displayWidth}×${displayHeight}`, "display pixels"],
      [spec.direction.toUpperCase(), "reading direction"],
    ];
    stats.forEach(([value, label], index) => {
      const x = railX + 14 + index * 198;
      drawing.rect(186, 48).move(x, statY).radius(6).fill("#f6f8fc");
      addText(x + 10, statY + 5, value ?? "", 16, "#303f62", 700);
      addText(x + 10, statY + 27, label ?? "", 10, "#778196");
    });

    categoryCards.forEach(([name, components], index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = railX + col * 310;
      const y = 184 + row * 112;
      const w = 300;
      const h = 100;
      card(x, y, w, h, short(name, 28), `${components.length} nodes`);
      components.slice(0, 3).forEach((component, item) => {
        addText(x + 13, y + 31 + item * 16,
          short(`${component.id} · ${component.kind} · ${component.width}×${component.height}`, 42),
          10, "#4c5870");
      });
      if (components.length > 3) addText(x + 13, y + 81, `+ ${components.length - 3} more in PAGE.md`, 9, "#818ba0");
    });
    if (groups.length > 8) addText(railX + 2, 182 + categoryRows * 112,
      `${groups.length - 8} additional categories are fully listed in PAGE.md.`, 10, "#778196");

    card(railX, auditY, railWidth, auditHeight, "PROJECT REUSE AUDIT", `${spec.componentAudit.length} searches`);
    spec.componentAudit.slice(0, 3).forEach((entry, index) => {
      const y = auditY + 31 + index * 33;
      const warning = auditWarnings.find((item) => item.component === entry.component);
      const verifiedPaths = entry.sourcePaths.filter((path) => !warning?.missingPaths.includes(path));
      const unverified = Boolean(warning && verifiedPaths.length === 0);
      const status = unverified ? "UNVERIFIED" : entry.status === "matched" ? "MATCH" : "NO MATCH";
      addText(railX + 14, y, `${status} · ${short(entry.component, 34)}`, 10,
        unverified ? "#8a6b32" : entry.status === "matched" ? "#247653" : "#68748a", 700);
      addText(railX + 14, y + 13, short(`${verifiedPaths.join(", ") || "no verified paths"} · ${warning ? `${warning.missingPaths.length} missing path(s)` : entry.notes}`, 92), 9, "#778196");
    });
    if (spec.componentAudit.length > 3) addText(railX + 14, auditY + auditHeight - 14, `+ ${spec.componentAudit.length - 3} more searches documented in PAGE.md`, 9, "#778196");

    const states = coveredStates(spec);
    card(railX, stateY, railWidth, stateHeight, "STATE COVERAGE", `${states.filter((entry) => entry.status === "unknown").length} unknown`);
    states.slice(0, 4).forEach((entry, index) => {
      const y = stateY + 31 + index * 18;
      addText(railX + 14, y, `${entry.viewport} / ${entry.state}`, 10, "#46536c", 600);
      addText(railX + 598, y, entry.status.toUpperCase(), 9, entry.status === "observed" ? "#247653" : "#8a6b32", 700, "end");
    });
    spec.openQuestions.slice(0, 2).forEach((question, index) => {
      addText(railX + 14, stateY + 40 + Math.min(states.length, 4) * 18 + index * 18,
        `? ${short(question, 92)}`, 9, "#8a6b32");
    });

    if (specimens.length) {
      card(railX, sampleY, railWidth, sampleHeight, "OBSERVED STATE SAMPLES", `${specimens.length} distinct styles`);
      specimens.forEach((component, index) => {
        const y = sampleY + 35 + index * 26;
        const group = drawing.group().attr({ id: variantId(component) });
        group.rect(18, 14).move(railX + 14, y).radius(3).fill(component.fill ?? "#e8edf5")
          .stroke({ color: component.stroke ?? "#bdc6d5", width: component.strokeWidth ?? 1 });
        addText(railX + 42, y - 1, short(`${component.id} · ${component.state}`, 78), 10, "#4c5870");
      });
    }

    card(railX, measureY, railWidth, lowerHeight, "MEASUREMENTS & GAPS", `${spec.measurements.length} measurements`);
    spec.measurements.slice(0, 4).forEach((measurement, index) => {
      addText(railX + 14, measureY + 32 + index * 18,
        short(`${measurement.label} · ${measurement.value}px · ${measurement.status}`, 88), 10, "#4c5870");
    });
    addText(24, bottom - 16, "Exact node geometry and evidence are in PAGE.md. Unknown states and unverified styles are never treated as implementation facts.", 10, "#778196");
    return drawing.node.outerHTML;
  });
}

function renderPage(spec: WireframeSpec, auditWarnings: WireframeAuditWarning[]): string {
  const warningByComponent = new Map(auditWarnings.map((warning) => [warning.component, warning]));
  const { width, height, displayWidth, displayHeight } = spec.source;
  const variants = observedStateSamples(spec);
  const groups = componentGroups(spec);
  const components = [
    `- \`screen.frame\` — category: \`page frame\`; role: screenshot boundary; parent: none; kind: source-frame; bounds: 24,72,${width},${height}px.`,
    ...groups.flatMap(([category, entries]) => [
      `### ${md(category)} (${entries.length})`,
      ...entries.map((component) => {
        const details = [
          `category: \`${md(category)}\``,
          `role: ${md(component.role)}`,
          `parent: ${component.parent ? `\`${component.parent}\`` : "`screen.frame`"}`,
          `kind: \`${md(component.kind)}\``,
          `primitive: \`${primitive(component)}\``,
          `bounds: ${component.x},${component.y},${component.width},${component.height}px`,
          `radius: ${component.radius === undefined ? "unspecified" : `${component.radius}px`}`,
          `fill: ${component.fill ?? "unspecified"}`,
          `stroke: ${component.stroke ?? "unspecified"}`,
          `strokeWidth: ${component.strokeWidth === undefined ? "unspecified" : `${component.strokeWidth}px`}`,
          `state: ${component.state ? md(component.state) : "not observed"}`,
          ...(component.styles ?? []).map((style) => `${md(style.property)}: ${md(style.value)} [${style.status}]`),
        ];
        return `- \`${component.id}\` — ${details.join("; ")}.`;
      }),
    ]),
    ...variants.map((component) => `- \`${variantId(component)}\` — observed state specimen for \`${component.id}\`: ${md(component.state ?? "")}; kind \`${md(component.kind)}\`; style carried from the source node.`),
  ].join("\n");
  const styleRows = spec.components.flatMap((component) => (component.styles ?? []).map((style) =>
    `- \`${component.id}\` · ${md(style.property)} = \`${md(style.value)}\` · ${style.status}.`));
  const tokenMap = new Map<string, { property: string; value: string; confidence: Set<string>; ids: string[] }>();
  for (const component of spec.components) {
    const values: [string, string | undefined][] = [
      ["fill", component.fill],
      ["stroke", component.stroke],
      ["radius", component.radius === undefined ? undefined : `${component.radius}px`],
      ["strokeWidth", component.strokeWidth === undefined ? undefined : `${component.strokeWidth}px`],
    ];
    for (const [property, value] of values) {
      if (value === undefined) continue;
      const key = `${property}\u0000${value}`;
      const token = tokenMap.get(key) ?? { property, value, confidence: new Set<string>(), ids: [] };
      token.confidence.add(component.styles?.find((style) => style.property === property)?.status ?? "not tagged");
      token.ids.push(component.id);
      tokenMap.set(key, token);
    }
  }
  const tokens = [...tokenMap.values()].map((token) =>
    `| ${md(token.property)} | \`${md(token.value)}\` | ${[...token.confidence].join(", ")} | ${token.ids.map((id) => `\`${id}\``).join(", ")} |`).join("\n");
  const states = coveredStates(spec).map((entry) => `| ${md(entry.viewport)} | ${md(entry.state)} | ${entry.status} | ${md(entry.expected)} |`).join("\n");
  const measurements = spec.measurements.map((entry) =>
    `| ${md(entry.label)} | \`${md(entry.from)}\` | \`${md(entry.to)}\` | ${entry.value}px | ${entry.status} |`).join("\n");
  const questions = spec.openQuestions.length ? spec.openQuestions.map((question) => `- ${md(question)}`).join("\n") : "- None.";
  const variantsText = variants.map((component) =>
    `- \`${variantId(component)}\` derives from \`${component.id}\`; observed state \`${md(component.state ?? "")}\`; render as \`${primitive(component)}\`.`
  ).join("\n");
  const statusCounts = [...STATUSES].map((status) => `${status}: ${spec.components.flatMap((component) => component.styles ?? []).filter((style) => style.status === status).length}`).join("; ");
  return `---
schema: omp-wireframe-page/v1
slug: ${spec.slug}
title: ${JSON.stringify(spec.title)}
direction: ${spec.direction}
source:
  width: ${width}
  height: ${height}
  displayWidth: ${displayWidth}
  displayHeight: ${displayHeight}
componentCount: ${spec.components.length}
categoryCount: ${groups.length}
---

# ${md(spec.title)}

## Page contract

- Direction: ${spec.direction.toUpperCase()} (observed from the reference).
- Coordinate system: top-left origin; all node bounds and dimensions use source-image pixels.
- Display scale: ${(displayWidth / width).toFixed(3)}×; source frame: ${width} × ${height}px; displayed frame: ${displayWidth} × ${displayHeight}px.
- Components are semantic nodes grouped by open-ended categories; category names are not restricted to a fixed UI taxonomy.
- SVG text is represented by role bars. Source copy and sensitive values are not reproduced.
- Missing values are explicitly unspecified; estimated values are not source facts. No unseen responsive or interaction behavior is inferred.

## Components

${components}

## Style evidence

${styleRows.length ? styleRows.join("\n") : "- No per-property evidence supplied. Direct fill, stroke, radius, and stroke-width values remain in the component records but are not assigned confidence unless listed above."}

## Repeated style values (candidate tokens)

These values recur in the extracted nodes; they are not assumed to be named design-system tokens. Confidence appears only when recorded in style evidence.

${tokens ? `| Property | Value | Confidence | Referenced nodes |\n| --- | --- | --- | --- |\n${tokens}` : "- No repeated style values."}

## Component reuse audit

${spec.componentAudit.map((entry) => {
  const warning = warningByComponent.get(entry.component);
  const verifiedPaths = entry.sourcePaths.filter((path) => !warning?.missingPaths.includes(path));
  const status = warning && verifiedPaths.length === 0 ? "unverified" : entry.status;
  const inspected = verifiedPaths.length ? verifiedPaths.map((path) => `\`${md(path)}\``).join(", ") : "none verified";
  const missing = warning ? `; paths not found and not counted as evidence: ${warning.missingPaths.map((path) => `\`${md(path)}\``).join(", ")}` : "";
  return `- **${md(entry.component)}** — ${status}; inspected paths: ${inspected}${missing}; result: ${md(entry.notes)}`;
}).join("\n")}

## Measured geometry

${measurements ? `| Measurement | From node | To node | Source pixels | Confidence |\n| --- | --- | --- | ---: | --- |\n${measurements}` : "- No explicit measurements supplied."}

## States

| Viewport | State | Status | Expected |
| --- | --- | --- | --- |
${states}

## Observed state variants

${variantsText || "- No component-level state was observed."}

## Evidence confidence

- Explicit style evidence counts: ${statusCounts}.
- Omitted component properties: unspecified, not inferred.
- Static screenshot evidence does not establish motion triggers, timing, direction, or easing.

## Open questions

${questions}

## Acceptance checks

- [AC-01] Every visible element has a stable ID, open-ended category, semantic kind, and source-pixel bounds.
- [AC-02] Every SVG node ID maps to one categorized entry in this inventory.
- [AC-03] Reuse findings cite inspected project paths; missing matches remain explicit.
- [AC-04] Unknown states and unverified styles remain unknown or unspecified.
`;
}

export async function createWireframe(outputDirectory: string, workingDirectory: string, spec: WireframeSpec): Promise<{ svgPath: string; pagePath: string; componentCount: number; openQuestions: string[]; auditWarnings: WireframeAuditWarning[] }> {
  const auditWarnings = await validate(spec, workingDirectory);
  if (isAbsolute(outputDirectory)) throw new Error("outputDirectory must be relative to the project working directory");
  const output = resolve(workingDirectory, outputDirectory);
  const rel = relative(resolve(workingDirectory), output);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("outputDirectory must stay inside the project working directory and cannot be the project root");
  await mkdir(output, { recursive: true });
  const actualOutput = await realpath(output);
  const actualRelative = relative(resolve(workingDirectory), actualOutput);
  if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) || isAbsolute(actualRelative)) {
    throw new Error("outputDirectory resolves outside the project working directory");
  }
  const svgPath = resolve(output, "wireframe.svg");
  const pagePath = resolve(output, "PAGE.md");
  const files = [resolve(output, "wireframe.svg"), resolve(output, "PAGE.md")];
  for (const file of files) {
    const info = await lstat(file).catch(() => undefined);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`generated output must be a regular file, not a link or directory: ${file}`);
  }
  await writeFile(svgPath, renderSvg(spec, auditWarnings), "utf8");
  await writeFile(pagePath, renderPage(spec, auditWarnings), "utf8");
  return { svgPath, pagePath, componentCount: spec.components.length, openQuestions: spec.openQuestions, auditWarnings };
}
