/** Fail-closed authorization metadata for argv passed directly to native CLIs.
 * This is not a shell parser: callers must execute binary + argv without a shell.
 * `blocked` routes operations that bypass extension review to a dedicated tool.
 */
export type NativeBinary = "fest" | "camp";
export type NativeCommandAccess = "read" | "write" | "human";
export interface NativeCommandPolicy {
  access: NativeCommandAccess;
  reason: string;
  blocked?: string;
}

interface ReadRule { command: string; operands?: boolean }
const FEST_READ: readonly ReadRule[] = [
  { command: "version" }, { command: "intro" }, { command: "understand", operands: true },
  { command: "context", operands: true }, { command: "deps", operands: true },
  { command: "id" }, { command: "list" }, { command: "rules" },
  { command: "search", operands: true }, { command: "show", operands: true },
  { command: "tokens", operands: true }, { command: "types", operands: true },
  { command: "parse", operands: true }, { command: "links" }, { command: "plugins" },
  { command: "status" }, { command: "status history", operands: true }, { command: "status list" },
  { command: "task show", operands: true }, { command: "workflow status" },
  { command: "workflow show" }, { command: "workflow runs" }, { command: "workflow validate", operands: true },
  { command: "gates show" }, { command: "hooks list" },
  { command: "markers count" }, { command: "markers list" }, { command: "markers next" },
  { command: "markers validate", operands: true }, { command: "progress" },
  { command: "validate" }, ...["completeness", "ordering", "quality-gates", "structure", "tasks"].map((name) => ({ command: `validate ${name}` })),
  { command: "chain check", operands: true }, { command: "chain list" },
  { command: "chain graph", operands: true }, { command: "chain status", operands: true },
  { command: "chain validate", operands: true }, { command: "templates list" },
  { command: "feedback view" }, { command: "config list" }, { command: "config show" },
  { command: "config theme show" }, { command: "config theme test" },
  { command: "index show" }, { command: "index diff", operands: true }, { command: "index validate" },
];
const CAMP_READ: readonly ReadRule[] = [
  ...["version", "root", "id", "list", "status", "shortcuts", "pins", "concepts", "festivals", "plugins"].map((command) => ({ command })),
  { command: "doctor" }, { command: "cache info" },
  { command: "settings get", operands: true }, { command: "settings catalog" },
  { command: "settings document get", operands: true }, { command: "settings document validate", operands: true },
  ...["count", "find", "list", "show"].map((name) => ({ command: `idea ${name}`, operands: true })),
  { command: "idea notes list" }, { command: "idea notes folders" },
  { command: "project list" }, { command: "project worktree list" },
  { command: "project remote list", operands: true },
  { command: "workflow list" }, { command: "workflow show", operands: true }, { command: "workflow doctor" },
  { command: "dungeon list" }, { command: "machine list" }, { command: "machine diagnose", operands: true },
  { command: "registry check" }, { command: "lifecycle list" },
  { command: "org list" }, { command: "org show", operands: true }, { command: "org which" }, { command: "tag list" },
  ...["checklist", "links", "list", "show", "status"].map((name) => ({ command: `quest ${name}`, operands: name !== "status" })),
  { command: "artifacts list" }, { command: "artifacts manifest", operands: true }, { command: "skills status" },
  { command: "notify list" }, { command: "jobs" },
  ...["commits", "doctor", "id", "links", "list", "resolve", "validate"].map((name) => ({ command: `workitem ${name}`, operands: true })),
  ...["priorities", "profile", "queue", "status"].map((name) => ({ command: `triage ${name}` })),
];

// Known non-mutating options only. Unknown options, including future options,
// cannot inherit read access from their command. Value options consume one argv.
const READ_BOOLEAN_FLAGS: Readonly<Record<string, true>> = {
  "--json": true, "--no-color": true, "--debug": true, "--verbose": true, "--plain": true,
  "--short": true, "-s": true, "--all": true, "-a": true, "--no-context": true,
  "--no-tokens": true, "--print": true, "--list": true, "--show-parked": true,
  "--submodules-only": true, "--no-drain": true, "--show": true,
};
const READ_VALUE_FLAGS: Readonly<Record<string, true>> = {
  "--config": true, "--phase": true, "--sequence": true, "--festival": true, "--task": true,
  "--path": true, "--type": true, "--status": true, "--stage": true, "--attention-stage": true,
  "--category": true, "--group": true, "--group-by": true, "--limit": true, "--query": true,
  "--token-model": true, "--project": true, "--run": true, "--lane": true, "--batch": true,
  "--folder": true, "--check": true, "-c": true, "--format": true, "--depth": true, "--model": true,
};
const HUMAN_FLAGS: Readonly<Record<string, true>> = {
  "--force": true, "-f": true, "--delete": true, "--reset": true, "--hard": true,
  "--purge": true, "--prune": true, "--approve": true, "--auto-approve": true,
  "--override-judge": true, "--skip-checks": true, "--skip-hooks": true,
  "--no-verify": true, "--discard": true, "--discard-changes": true,
};
const EXEC_FLAGS: Readonly<Record<string, true>> = {
  "--judge-command": true, "--editor": true, "--exec": true, "--command": true, "--shell": true,
};
const HUMAN_VERBS: Readonly<Record<string, true>> = {
  approve: true, reject: true, delete: true, remove: true, rm: true, reset: true, destroy: true,
  purge: true, prune: true, drop: true, skip: true, unlink: true, unregister: true, detach: true, abandon: true,
};
const ALIASES: Partial<Record<NativeBinary, Readonly<Record<string, string>>>> = {
  camp: { intent: "idea", ideas: "idea", wi: "workitem", workitems: "workitem", reg: "registry", r: "run", unreg: "unregister" },
};

interface ParsedArgs {
  words: string[];
  flags: Set<string>;
  unknownFlag: boolean;
  help: boolean;
  invalid: boolean;
}
function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { words: [], flags: new Set(), unknownFlag: false, help: false, invalid: false };
  let operandsOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.includes("\0")) parsed.invalid = true;
    if (arg === "--") { operandsOnly = true; continue; }
    if (operandsOnly || !arg.startsWith("-") || arg === "-") { parsed.words.push(arg); continue; }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    parsed.flags.add(flag);
    if (flag === "--help" || flag === "-h") {
      parsed.help = equals < 0 || arg.slice(equals + 1) === "true";
      if (!parsed.help) parsed.unknownFlag = true;
    } else if (Object.hasOwn(READ_VALUE_FLAGS, flag)) {
      if (equals < 0) {
        const value = args[++i];
        if (value === undefined || value.startsWith("-")) parsed.invalid = true;
      }
    } else if (!Object.hasOwn(READ_BOOLEAN_FLAGS, flag)) parsed.unknownFlag = true;
  }
  return parsed;
}
function starts(words: readonly string[], prefix: string): boolean {
  const parts = prefix.split(" ");
  return parts.every((part, i) => words[i] === part);
}
function rawBypass(binary: NativeBinary, words: readonly string[], flags: ReadonlySet<string>): string | undefined {
  if ([...flags].some((flag) => Object.hasOwn(EXEC_FLAGS, flag)) ||
      (binary === "camp" && (words[0] === "go" || words[0] === "g") && flags.has("-c"))) {
    return "Executable overrides require a dedicated trusted integration; raw execution is disabled.";
  }
  if (binary === "camp") {
    if (["run", "project run", "idea edit", "idea crawl", "idea explore", "dungeon crawl", "dungeon explore", "quest edit"].some((p) => starts(words, p))) {
      return "Raw command/editor execution is disabled; use the dedicated camp integration.";
    }
    if (["promote", "idea promote", "workitem promote", "workitem convert", "workitem retype", "workitem sweep", "triage approve", "triage apply", "fresh", "unbundle"].some((p) => starts(words, p))) {
      return "Use the dedicated reviewed promotion, triage, or lifecycle tool; raw commands cannot bypass planning or human decisions.";
    }
  } else {
    if (["task edit", "wizard", "workflow judge"].some((p) => starts(words, p))) return "Raw editor/judge execution is disabled; use the dedicated integration.";
    if (["scaffold", "create", "apply", "insert", "templates apply", "ritual", "unbundle", "promote", "status set", "workflow approve", "workflow reject", "workflow skip", "workflow create", "gates apply", "next"].some((p) => starts(words, p))) {
      return "Use the dedicated planning, next, lifecycle, or gate tool; raw commands cannot bypass review or approval.";
    }
  }
  return undefined;
}

/** Inspect the complete argv before execution. Unknown commands/options mutate.
 * Human classification is not approval: the caller must obtain native human
 * confirmation and enforce supervisor authority. Never execute `blocked` raw.
 */
export function classifyNativeCommand(binary: NativeBinary, args: readonly string[]): NativeCommandPolicy {
  const parsed = parseArgs(args);
  if (parsed.invalid || args.some((arg) => arg.includes("\0"))) return { access: "write", reason: "Invalid or incomplete native argv.", blocked: "Pass complete argv values without NUL bytes." };
  // Execution passthrough commands may pass --help to their child rather than
  // handle it themselves. Never treat their nested flags as safe inspection.
  const executionWords = [...parsed.words];
  if (executionWords[0]) executionWords[0] = ALIASES[binary]?.[executionWords[0]] ?? executionWords[0];
  const executionEscape = binary === "camp" && (starts(executionWords, "run") || starts(executionWords, "project run") ||
    ((executionWords[0] === "go" || executionWords[0] === "g") && (parsed.flags.has("-c") || parsed.flags.has("--command"))));
  if (!executionEscape && (parsed.help || parsed.words[0] === "help" || (parsed.words.length === 0 && (parsed.flags.has("--version") || parsed.flags.has("-v"))))) {
    return { access: "read", reason: "Native help/version inspection does not execute the requested operation." };
  }
  const words = [...parsed.words];
  if (words[0]) words[0] = ALIASES[binary]?.[words[0]] ?? words[0];
  if (binary === "camp" && words[0] === "project" && words[1] === "wt") words[1] = "worktree";
  const blocked = rawBypass(binary, words, parsed.flags);
  const human = [...parsed.flags].some((flag) => Object.hasOwn(HUMAN_FLAGS, flag)) ||
    words.slice(0, 4).some((word) => Object.hasOwn(HUMAN_VERBS, word)) ||
    (binary === "camp" && (starts(words, "triage apply") || starts(words, "fresh")));
  if (human) return { access: "human", reason: "Approval, destructive removal/reset, force, or operator override requires a human decision.", ...(blocked ? { blocked } : {}) };
  if (blocked) return { access: "write", reason: "This native operation requires the dedicated integration.", blocked };
  if (parsed.unknownFlag) return { access: "write", reason: "An unrecognized or mutation-capable flag prevents read-only authorization." };
  if (binary === "fest" && starts(words, "system config") && words.length === 2 && parsed.flags.has("--show")) {
    return { access: "read", reason: "Explicit native configuration display." };
  }
  if (binary === "fest" && starts(words, "task blocked") && words.length === 2 && parsed.flags.has("--list")) {
    return { access: "read", reason: "Explicit native blocker listing does not change task state." };
  }
  const rules = binary === "fest" ? FEST_READ : CAMP_READ;
  const read = rules.some((rule) => starts(words, rule.command) && (rule.operands === true || words.length === rule.command.split(" ").length));
  if (read) return { access: "read", reason: "Explicitly allowlisted native query with read-only flags." };
  return { access: "write", reason: "Mutation or unknown command: supervisor authorization is required." };
}
