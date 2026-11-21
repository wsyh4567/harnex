import type { HarnessTree } from "@harnex/interfaces";
import { HarnessCompatibilityReportSchema, type CompatibilityIssue, type HarnessCompatibilityReport } from "@harnex/protocol";
import { normalizeTree, untriggeredSkills } from "./tree.ts";

export const CURRENT_HARNESS_SCHEMA_VERSION = 1;
export interface CompatibilityOptions {
  commitSha: string;
  appVersion?: string;
  expectedSchemaVersion?: number;
  deprecatedToolRenames?: Record<string, string>;
}

const HOOK = /^hooks\/[^/]+\.ts$/;
const SCRIPT = /^(?:scripts|skills\/[^/]+\/scripts)\/[^/]+\.ts$/;
const TOOL_TEXT = /^(?:systemprompt\.md|tool_descriptions\/[^/]+\.md|skills\/[^/]+\/SKILL\.md)$/;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function parseJsonObject(text?: string): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch { return undefined; }
}

const toolFix = (old: string, replacement: string) => `Replace built-in tool ${JSON.stringify(old)} with ${JSON.stringify(replacement)}.`;

export function toolRenamesFromIssues(issues: readonly CompatibilityIssue[]): Record<string, string> {
  return Object.fromEntries(issues.flatMap(issue => {
    if (issue.kind !== "deprecated_tool_reference") return [];
    const pair = /^Replace built-in tool ("(?:[^"\\]|\\.)*") with ("(?:[^"\\]|\\.)*")\.$/.exec(issue.suggestedFix ?? "");
    return pair ? [[JSON.parse(pair[1]!) as string, JSON.parse(pair[2]!) as string]] : [];
  }));
}

function referencesTool(text: string, tool: string): boolean {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

function argvOnlyHook(transpiled: string): boolean {
  const code = transpiled.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, " ");
  return /\b(?:Bun|process)\s*\??\.\s*argv\s*(?:\?\.)?\[\s*3\s*\]/.test(code)
    && !/\b(?:Bun|process)\s*\??\.\s*stdin\b|\bimport\s*\{[^}]*\bstdin\b[^}]*\}\s*from\b|\breadFileSync\s*\(\s*0\b/.test(code);
}

function validMcpStructure(config: Record<string, unknown> | undefined): boolean {
  const servers = config?.mcpServers ?? config?.servers;
  return Array.isArray(servers)
    ? servers.every(server => isObject(server) && typeof server.id === "string" && server.id.trim())
    : isObject(servers) && Object.values(servers).every(isObject);
}

export function inspectHarnessCompatibility(tree: HarnessTree, opts: CompatibilityOptions): HarnessCompatibilityReport {
  const snapshot = normalizeTree(tree);
  const appVersion = opts.appVersion ?? "0.1.0";
  const expectedSchemaVersion = opts.expectedSchemaVersion ?? CURRENT_HARNESS_SCHEMA_VERSION;
  const issues: CompatibilityIssue[] = [];
  const quarantinedPaths = new Set<string>();
  const add = (path: string, kind: CompatibilityIssue["kind"], message: string, suggestedFix: string, severity: CompatibilityIssue["severity"] = "breaking") => {
    issues.push({ path, kind, message, suggestedFix, severity });
    if (severity === "breaking" && (HOOK.test(path) || SCRIPT.test(path))) quarantinedPaths.add(path);
  };

  const manifest = parseJsonObject(snapshot["manifest.json"]);
  const version = manifest?.schemaVersion;
  const harnessSchemaVersion = typeof version === "number" && Number.isSafeInteger(version) && version >= 0 ? version : 0;
  if (!manifest) {
    add("manifest.json", "invalid_manifest_or_mcp", "The harness manifest is missing or is not a valid JSON object.",
      `Restore the manifest JSON object with schemaVersion ${expectedSchemaVersion}, preserving its metadata.`);
  } else if (harnessSchemaVersion !== expectedSchemaVersion) {
    add("manifest.json", "schema_version_mismatch", `Harness schema ${harnessSchemaVersion} does not match required schema ${expectedSchemaVersion}.`,
      `Set schemaVersion to ${expectedSchemaVersion}, preserving the other manifest fields.`);
  }

  const renames = Object.entries(opts.deprecatedToolRenames ?? {}).filter(([old, next]) => old && next && old !== next).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  for (const path of Object.keys(snapshot).sort()) {
    const body = snapshot[path]!;
    if (path === "mcp/servers.json" && !validMcpStructure(parseJsonObject(body))) {
      add(path, "invalid_manifest_or_mcp", "The MCP config is invalid or does not contain a supported mcpServers or servers collection.",
        "Restore a JSON object with a server map or a list of server objects with IDs, keeping existing server settings.");
    }
    if (HOOK.test(path) || SCRIPT.test(path)) {
      let transpiled: string | undefined;
      try { transpiled = transpiler.transformSync(body); }
      catch { add(path, "script_syntax_error", "TypeScript cannot parse this file.", "Repair the TypeScript syntax while retaining the file’s behavior."); }
      if (transpiled !== undefined && HOOK.test(path) && argvOnlyHook(transpiled)) {
        add(path, "deprecated_hook_contract", "The hook reads its JSON payload from argv[3], but the current hook contract sends it on stdin.",
          "Read the payload with await Bun.stdin.text() and pass the result to JSON.parse; keep the hook’s output contract.");
      }
    }
    if (TOOL_TEXT.test(path)) {
      for (const [old, replacement] of renames) if (referencesTool(body, old)) {
        add(path, "deprecated_tool_reference", `This file references the deprecated built-in tool ${JSON.stringify(old)}.`, toolFix(old, replacement));
      }
    }
  }
  for (const { path, name } of untriggeredSkills(snapshot)) {
    add(path, "untriggered_skill", `The skill ${JSON.stringify(name)} has no trigger in the always-on harness.`,
      `Add a concise trigger for ${JSON.stringify(name)} to systemprompt.md.`, "warning");
  }
  const breaking = issues.filter(issue => issue.severity === "breaking").length;
  const migrationGuideSummary = issues.length ? [`${breaking} breaking issue(s), ${issues.length - breaking} warning(s).`,
    ...new Set(issues.map(issue => issue.suggestedFix))].join(" ") : undefined;
  return HarnessCompatibilityReportSchema.parse({ checkedAt: new Date().toISOString(), appVersion, commitSha: opts.commitSha,
    expectedSchemaVersion, harnessSchemaVersion, hasBreakingIssues: breaking > 0, needsMigration: issues.length > 0,
    quarantinedPaths: [...quarantinedPaths].sort(), issues, migrationGuideSummary });
}
