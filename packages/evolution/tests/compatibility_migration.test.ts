import { expect, test } from "bun:test";
import { InMemoryHarnessStore, InMemoryTraceStore, MockLlmClient, MockRustBridge, MockTaskRunner, type HarnessTree } from "@harnex/interfaces";
import type { HarnessPatchOp } from "@harnex/protocol";
import { CURRENT_HARNESS_SCHEMA_VERSION, EvolutionScheduler, inspectHarnessCompatibility, parseProposal } from "../src/index.ts";

const HOOK = "hooks/check.ts";
const SCRIPT = "scripts/check.ts";
const TOOL_DOC = "tool_descriptions/fs.md";
const oldManifest = { schemaVersion: 0, name: "Personal harness", health: { status: "healthy" } };
const currentHook = 'const payload = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ action: "pass", note: payload.note }));';
const broken: HarnessTree = {
  "manifest.json": JSON.stringify(oldManifest),
  "mcp/servers.json": '{"servers":[]}',
  "systemprompt.md": "Reconcile all totals before returning.",
  "memory/LongTermMEMORY.md": "Preserve the source account order.",
  [HOOK]: 'const payload = JSON.parse(process.argv[3]!); console.log(JSON.stringify({ action: "pass", note: payload.note }));',
  [SCRIPT]: 'export const reason = ;',
  [TOOL_DOC]: "Use `read_file_v0` to read one input at a time.",
};
const overrides = { appVersion: "2.0.0-test", expectedSchemaVersion: 2, deprecatedToolRenames: { read_file_v0: "read_file" } };
const upsert = (path: string, content: string): HarnessPatchOp => ({ path, op: "upsert", content });
const edits = [upsert("manifest.json", JSON.stringify({ ...oldManifest, schemaVersion: overrides.expectedSchemaVersion })),
  upsert(HOOK, currentHook), upsert(SCRIPT, 'export const reason = "Check totals";'), upsert(TOOL_DOC, "Use `read_file` to read one input at a time.")];

function fixture(reply: (call: number) => HarnessPatchOp[], tree = broken) {
  const bridge = new MockRustBridge(tree);
  const harnessStore = new InMemoryHarnessStore(bridge);
  const traceStore = new InMemoryTraceStore();
  const runner = new MockTaskRunner();
  const llm = new MockLlmClient((req, call) => ({
    content: JSON.stringify({ operations: reply(call) }), modelId: `test-${req.slot}`, toolCalls: [], finishReason: "stop",
    usage: { inputTokens: 30, outputTokens: 20, reasoningTokens: 0, cachedInputTokens: 0, costUsd: 0.001 },
  }));
  return { bridge, harnessStore, traceStore, runner, llm, scheduler: new EvolutionScheduler({ bridge, harnessStore, traceStore, runner, llm }) };
}

test("factory seed passes the compatibility doctor", async () => {
  const seed = new URL("../../../harness-seed/", import.meta.url);
  const paths = ["manifest.json", "mcp/servers.json", "hooks/example_trim_output.ts", "systemprompt.md", "guardrails.md", "memory/LongTermMEMORY.md", "tool_descriptions/fs_and_shell.md"];
  const tree = Object.fromEntries(await Promise.all(paths.map(async path => [path, await Bun.file(new URL(path, seed)).text()])));
  expect(inspectHarnessCompatibility(tree, { commitSha: "factory" })).toMatchObject({
    hasBreakingIssues: false, needsMigration: false, issues: [], quarantinedPaths: [],
    expectedSchemaVersion: CURRENT_HARNESS_SCHEMA_VERSION, harnessSchemaVersion: CURRENT_HARNESS_SCHEMA_VERSION,
  });
});

test("detects breaking manifest, hook, script and tool changes in portable path order", () => {
  const opts = { commitSha: "legacy", ...overrides };
  const { [HOOK]: hook, ...rest } = broken;
  const report = inspectHarnessCompatibility({ ...rest, "hooks\\check.ts": hook! }, opts);
  expect(report).toMatchObject({ hasBreakingIssues: true, needsMigration: true, harnessSchemaVersion: 0,
    expectedSchemaVersion: 2, appVersion: "2.0.0-test", quarantinedPaths: [HOOK, SCRIPT] });
  expect(report.issues.map(({ path, kind, severity }) => [path, kind, severity])).toEqual([
    ["manifest.json", "schema_version_mismatch", "breaking"],
    [HOOK, "deprecated_hook_contract", "breaking"],
    [SCRIPT, "script_syntax_error", "breaking"],
    [TOOL_DOC, "deprecated_tool_reference", "breaking"],
  ]);
  expect(report.migrationGuideSummary).toContain("Bun.stdin.text()");
  expect(report.migrationGuideSummary).toContain('Replace built-in tool "read_file_v0" with "read_file"');
  expect(report.issues).toEqual(inspectHarnessCompatibility(Object.fromEntries(Object.entries(broken).reverse()), opts).issues);
});

test("reports malformed configuration, broken skill scripts and untriggered skills", () => {
  const opts = { commitSha: "legacy", ...overrides };
  const skill = "skills/check_totals/SKILL.md";
  const helper = "skills/check_totals/scripts/check.ts";
  const tree = {
    "manifest.json": '{"schemaVersion":', "mcp/servers.json": '{"settings":{}}', [helper]: "const =;",
    "hooks/old.ts": 'const docs = "Bun.stdin.text()"; JSON.parse(Bun.argv[3]!);',
    "systemprompt.md": "The name pre_read_file_v0 is unrelated.",
    [skill]: "---\nname: check_totals\ndescription: Reconcile totals\n---\nCompare the totals.",
  };
  const report = inspectHarnessCompatibility(tree, opts);
  expect(report.issues.map(issue => [issue.path, issue.kind, issue.severity])).toEqual([
    ["manifest.json", "invalid_manifest_or_mcp", "breaking"],
    ["hooks/old.ts", "deprecated_hook_contract", "breaking"],
    ["mcp/servers.json", "invalid_manifest_or_mcp", "breaking"],
    [helper, "script_syntax_error", "breaking"],
    [skill, "untriggered_skill", "warning"],
  ]);
  expect(report.quarantinedPaths).toEqual(["hooks/old.ts", helper]);
  const warned = inspectHarnessCompatibility({ [skill]: tree[skill], "manifest.json": '{"schemaVersion":2}' }, opts);
  expect(warned).toMatchObject({ hasBreakingIssues: false, needsMigration: true, quarantinedPaths: [] });
});

test("publishes a verified migration and keeps high-privilege changes pending human trust", async () => {
  const f = fixture(call => call === 0 ? edits.slice(0, 2) : edits);
  const report = inspectHarnessCompatibility(broken, { commitSha: f.bridge.headSha, ...overrides });
  const proposal = await f.scheduler.triggerMigration({ report: JSON.parse(JSON.stringify(report)) });
  expect(proposal).toMatchObject({ status: "ready", triggerSource: "upgrade_migration", domain: "upgrade_migration",
    baseCommitSha: report.commitSha, requiresHumanTrust: true });
  expect(proposal.diffs.map(diff => diff.path)).toEqual([HOOK, "manifest.json", SCRIPT, TOOL_DOC]);
  expect(proposal.diffs.filter(diff => diff.isHighPrivilege).map(diff => diff.path)).toEqual([HOOK, SCRIPT]);
  expect(f.llm.calls.map(call => call.slot)).toEqual(["improver", "improver"]);
  expect(f.llm.calls[0]?.messages[0]?.content).toContain("migrationGuideSummary");
  expect(f.llm.calls[1]?.messages.at(-1)?.content).toContain(`${SCRIPT}: script_syntax_error`);
  for (const call of f.llm.calls) {
    const trusted = /\n<TRUSTED_STAGE_INSTRUCTIONS>\n([\s\S]+)\n<\/TRUSTED_STAGE_INSTRUCTIONS>$/.exec(call.messages.at(-1)!.content)?.[1];
    expect(trusted).toContain("# HARNESS COMPATIBILITY MIGRATION");
    expect(trusted).toContain("with only non-empty upserts on these allowed paths:");
    expect(trusted).toContain(JSON.stringify([HOOK, "manifest.json", SCRIPT, TOOL_DOC].sort()));
    expect(trusted).not.toContain('"op":"delete"');
  }
  expect(f.runner.runs).toHaveLength(0);
  expect(await f.traceStore.getProposal(proposal.id)).toEqual(proposal);
  expect(f.bridge.emittedEvents.filter(event => event.type === "evolution.proposal_ready")).toEqual([{ type: "evolution.proposal_ready", proposal }]);
  expect(await f.harnessStore.readTreeAt(report.commitSha)).toEqual(broken);
  expect(await f.harnessStore.getHeadSha()).toBe(report.commitSha);
  await expect(f.scheduler.acceptProposal(proposal.id)).rejects.toThrow("explicit human trust");
  expect(f.bridge.recordedCalls.filter(call => call.method === "gitCommitPatch")).toHaveLength(0);
  expect(await f.scheduler.acceptProposal(proposal.id, true)).toMatchObject({ ok: true });
  const head = await f.harnessStore.getHeadSha();
  const migrated = await f.harnessStore.readTreeAt(head);
  expect(migrated["memory/LongTermMEMORY.md"]).toBe(broken["memory/LongTermMEMORY.md"]);
  expect(JSON.parse(migrated["manifest.json"]!)).toEqual({ ...oldManifest, schemaVersion: overrides.expectedSchemaVersion });
  expect(inspectHarnessCompatibility(migrated, { commitSha: head, ...overrides })).toMatchObject({
    issues: [], hasBreakingIssues: false, needsMigration: false, quarantinedPaths: [],
  });
});

const unsafePatches: [HarnessPatchOp][] = [
  [{ path: "meta/./packages\\protocol/secret", op: "upsert", content: "unsafe" }],
  [{ path: SCRIPT, op: "delete" }],
  [{ path: "memory/LongTermMEMORY.md", op: "upsert", content: "unrelated" }],
  [{ path: "manifest.json", op: "upsert", content: '{"schemaVersion":2}' }],
];
test.each(unsafePatches)("does not publish an out-of-scope migration edit: %o", async unsafe => {
  const f = fixture(() => [...edits.filter(op => op.path !== unsafe.path), unsafe]);
  const report = inspectHarnessCompatibility(broken, { commitSha: f.bridge.headSha, ...overrides });
  const proposal = await f.scheduler.triggerMigration({ report });
  expect(proposal).toMatchObject({ status: "rejected", diffs: [] });
  expect(f.llm.calls).toHaveLength(2);
  expect(f.bridge.emittedEvents.some(event => event.type === "evolution.proposal_ready")).toBe(false);
  expect(await f.harnessStore.getHeadSha()).toBe(report.commitSha);
});

test("rejects stale reports and leaves manifest edits outside ordinary evolution", async () => {
  const f = fixture(() => edits);
  const report = inspectHarnessCompatibility(broken, { commitSha: "older", ...overrides });
  await expect(f.scheduler.triggerMigration({ report })).rejects.toThrow("older harness snapshot");
  expect(f.llm.calls).toHaveLength(0);
  expect(() => parseProposal(JSON.stringify({ operations: [edits[0]] }))).toThrow("editable harness surface");
});
