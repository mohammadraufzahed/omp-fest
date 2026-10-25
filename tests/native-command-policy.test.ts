import { describe, expect, it } from "vitest";
import { classifyNativeCommand, type NativeBinary } from "../src/application/native-command-policy.js";

function policy(binary: NativeBinary, ...args: string[]) { return classifyNativeCommand(binary, args); }

describe("native argv authorization", () => {
  it.each([
    ["fest", ["config", "show"]], ["fest", ["config", "theme", "show"]],
    ["fest", ["status", "history", "--json"]], ["fest", ["workflow", "status", "--phase", "001_PLAN", "--json"]],
    ["fest", ["validate", "--json"]], ["fest", ["markers", "count"]],
    ["fest", ["task", "show", "01_task.md"]], ["fest", ["system", "config", "--show"]],
    ["fest", ["task", "blocked", "--list", "--json"]], ["camp", ["jobs", "--json"]],
    ["camp", ["settings", "document", "get", "campaign.yaml", "--json"]],
    ["camp", ["settings", "get", "global.theme"]], ["camp", ["intent", "list", "--json"]],
    ["camp", ["wi", "list", "--type=festival", "--json"]],
    ["camp", ["project", "wt", "list", "--project", "app"]],
    ["camp", ["workflow", "doctor", "--json"]], ["camp", ["doctor", "--no-drain", "--json"]],
    ["camp", ["idea", "notes", "folders"]], ["camp", ["triage", "queue", "--json"]],
  ] satisfies [NativeBinary, string[]][])('allowlists complete read argv for %s %j', (binary, args) => {
    expect(classifyNativeCommand(binary, args).access).toBe("read");
  });

  it.each([
    ["fest", ["status", "unknown-subcommand"]], ["fest", ["config", "use", "other"]],
    ["fest", ["config", "theme", "set", "dark"]], ["fest", ["validate", "--fix"]],
    ["fest", ["validate", "--fix=false"]], ["fest", ["progress", "--complete"]],
    ["fest", ["progress", "--update", "50%"]], ["fest", ["parse", "--output", "out.json"]],
    ["fest", ["workflow", "advance"]], ["fest", ["task", "completed", "task.md", "--yes", "--json"]],
    ["fest", ["list", "--future-mutation"]], ["fest", ["system", "config"]],
    ["camp", ["settings"]], ["camp", ["settings", "set", "global.theme", "dark"]],
    ["camp", ["idea", "sync"]], ["camp", ["idea", "notes", "folders", "add", "research"]],
    ["camp", ["jobs", "run"]], ["camp", ["workflow", "sync"]], ["camp", ["unknown", "list"]],
  ] satisfies [NativeBinary, string[]][])('does not grant read for %s %j', (binary, args) => {
    expect(classifyNativeCommand(binary, args).access).toBe("write");
  });

  it.each([
    ["fest", ["task", "reset"]], ["fest", ["workflow", "approve"]],
    ["fest", ["workflow", "skip"]], ["fest", ["validate", "--force"]],
    ["fest", ["gates", "remove"]], ["camp", ["triage", "approve", "row"]],
    ["camp", ["triage", "apply"]], ["camp", ["triage", "apply", "--dry-run"]],
    ["camp", ["machine", "diagnose", "host", "--reset"]], ["camp", ["project", "wt", "remove", "feature"]],
    ["camp", ["org", "delete", "example"]], ["camp", ["registry", "prune"]],
    ["camp", ["doctor", "-f"]], ["camp", ["unreg", "example"]],
  ] satisfies [NativeBinary, string[]][])('requires a human for %s %j', (binary, args) => {
    expect(classifyNativeCommand(binary, args).access).toBe("human");
  });

  it.each([
    ["fest", ["scaffold", "from-plan", "--plan", "STRUCTURE.md"]],
    ["fest", ["create", "festival"]], ["fest", ["workflow", "create"]],
    ["fest", ["status", "set", "active"]], ["fest", ["workflow", "approve", "--auto"]],
    ["fest", ["workflow", "judge"]], ["fest", ["next", "--json"]],
    ["camp", ["run", "fest scaffold from-plan"]], ["camp", ["r", "fest", "workflow", "approve"]],
    ["camp", ["project", "run", "--", "fest", "promote"]],
    ["camp", ["run", "sh", "-c", "echo unsafe", "--help"]],
    ["camp", ["project", "run", "--", "sh", "-c", "echo unsafe", "--help"]],
    ["camp", ["go", "f", "-c", "fest scaffold from-plan"]],
    ["camp", ["g", "f", "--command", "sh", "--help"]],
    ["fest", ["ritual", "convert", "festival-id"]],
    ["camp", ["intent", "promote", "id", "--target", "festival"]],
    ["camp", ["wi", "retype", "id", "festival"]], ["camp", ["triage", "apply"]],
    ["camp", ["fresh"]], ["fest", ["task", "edit"]], ["camp", ["idea", "edit", "id"]],
  ] satisfies [NativeBinary, string[]][])('blocks raw review/exec bypass for %s %j', (binary, args) => {
    expect(classifyNativeCommand(binary, args).blocked).toBeTruthy();
  });

  it("permits help without executing the operation", () => {
    expect(policy("fest", "workflow", "approve", "--help").access).toBe("read");
    expect(policy("camp", "triage", "apply", "--help").access).toBe("read");
    expect(policy("camp", "help", "run").access).toBe("read");
    expect(policy("fest", "--version").access).toBe("read");
    expect(policy("camp", "-v").access).toBe("read");
    expect(policy("camp", "triage", "apply", "--help=false").access).toBe("human");
  });

  it("does not confuse option values, operands, or shell text with command tokens", () => {
    expect(policy("fest", "show", "--path", "--force").blocked).toBeTruthy();
    expect(policy("fest", "show", "--path=--force").access).toBe("read");
    expect(policy("camp", "idea", "show", "literal; touch /tmp/not-run").access).toBe("read");
    expect(policy("fest", "show", "--", "--help").access).toBe("read");
    expect(policy("camp", "settings", "--", "get", "--help").access).toBe("read");
    expect(policy("camp", "settings", "--", "set", "--help").access).toBe("write");
    expect(policy("fest", "status", "--phase").blocked).toBeTruthy();
    expect(policy("fest", "status", "\0").blocked).toBeTruthy();
  });
});
