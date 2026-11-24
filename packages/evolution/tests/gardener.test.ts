import { expect, test } from "bun:test";
import type { HarnessTree } from "@harnex/interfaces";
import { HarnessGardenerReportSchema } from "@harnex/protocol";
import { inspectHarnessHygiene } from "../src/index.ts";

test("factory seed with diverse slots reports clean hygiene and full health", async () => {
  const seed = new URL("../../../harness-seed/", import.meta.url);
  const paths = [
    "manifest.json",
    "mcp/servers.json",
    "hooks/example_trim_output.ts",
    "systemprompt.md",
    "guardrails.md",
    "memory/LongTermMEMORY.md",
    "tool_descriptions/fs_and_shell.md",
    "skills/workspace-triage/SKILL.md",
    "skills/safe-data-ops/SKILL.md",
    "skills/verify-before-done/SKILL.md",
  ];
  const tree: HarnessTree = Object.fromEntries(
    await Promise.all(paths.map(async (path) => [path, await Bun.file(new URL(path, seed)).text()])),
  );

  const report = HarnessGardenerReportSchema.parse(
    inspectHarnessHygiene(tree, {
      commitSha: "seed-sha",
      improverSlot: { providerId: "anthropic", modelId: "claude-sonnet-4" },
      judgeSlot: { providerId: "openai", modelId: "gpt-5" },
    }),
  );

  const expectedAlwaysOnBytes =
    Buffer.byteLength(tree["systemprompt.md"]!, "utf8") +
    Buffer.byteLength(tree["guardrails.md"]!, "utf8") +
    Buffer.byteLength(tree["memory/LongTermMEMORY.md"]!, "utf8") +
    Buffer.byteLength(tree["tool_descriptions/fs_and_shell.md"]!, "utf8");

  expect(report).toMatchObject({
    commitSha: "seed-sha",
    healthScore: 100,
    alwaysOnBytes: expectedAlwaysOnBytes,
    alwaysOnEstimatedTokens: Math.ceil(expectedAlwaysOnBytes / 4),
    totalOrgans: paths.length,
    modelDiversityOk: true,
    findings: [],
  });
  expect(report.suggestedPruningGoal).toBeUndefined();
});

test("detects prompt bloat, untriggered skills, orphan scripts, duplicate cues, empty organs, and same-model collusion", () => {
  const bloatedSystem = "A".repeat(4001);
  const bloatedGuardrails = "B".repeat(2501);
  const tree: HarnessTree = {
    "systemprompt.md": `${bloatedSystem}\nUse \`active_skill\` and \`scripts/used.ts\`.`,
    "guardrails.md": bloatedGuardrails,
    "memory/LongTermMEMORY.md": "Keep CSV totals reconciled.",
    "tool_descriptions/fs.md": "Use read_file before editing.",
    "skills/active_skill/SKILL.md": "---\nname: active_skill\ndescription: Active skill\n---\nActive.",
    "skills/dormant_skill/SKILL.md": "---\nname: dormant_skill\ndescription: Dormant skill\n---\nDormant.",
    "scripts/used.ts": "export const used = true;\n",
    "scripts/orphan_helper.ts": "export const orphan = true;\n",
    "scripts/empty_script.ts": "   \n\t",
    "hooks/empty_hook.ts": "",
    "sub_agents/blank.md": "   ",
    "meta/domains/office/harnesses/a/EXPERIENCE.md": "- **cue**: Reconcile multi-file CSV totals!\n- **lesson**: Verify sums.",
    "meta/domains/office/harnesses/b/EXPERIENCE.md": "cue:   reconcile multi-file csv totals \nlesson: Check sums.",
  };

  const report = HarnessGardenerReportSchema.parse(
    inspectHarnessHygiene(tree, {
      commitSha: "dirty-sha",
      improverSlot: { providerId: "openai", modelId: "gpt-5" },
      judgeSlot: { providerId: "openai", modelId: "gpt-5" },
    }),
  );

  expect(report.modelDiversityOk).toBe(false);
  expect(report.findings.map((f) => [f.kind, f.path, f.severity, f.suggestedAction])).toEqual([
    ["prompt_bloat", "guardrails.md", "warning", "prune"],
    ["empty_organ", "hooks/empty_hook.ts", "advisory", "prune"],
    ["duplicate_experience", "meta/domains/office/harnesses/b/EXPERIENCE.md", "advisory", "consolidate"],
    ["empty_organ", "scripts/empty_script.ts", "advisory", "prune"],
    ["orphan_script", "scripts/empty_script.ts", "advisory", "prune"],
    ["orphan_script", "scripts/orphan_helper.ts", "advisory", "prune"],
    ["untriggered_skill", "skills/dormant_skill/SKILL.md", "warning", "trigger"],
    ["same_model_collusion", "slots/improver+judge", "advisory", "diversify_models"],
    ["empty_organ", "sub_agents/blank.md", "advisory", "prune"],
    ["prompt_bloat", "systemprompt.md", "warning", "prune"],
  ]);

  // 3 warnings (36) + 7 advisories (35) = 71 deducted -> healthScore 29
  expect(report.healthScore).toBe(29);
  expect(report.suggestedPruningGoal).toBeDefined();
  expect(report.suggestedPruningGoal!.length).toBeLessThanOrEqual(320);
  expect(report.suggestedPruningGoal).toContain("guardrails.md");
  expect(report.suggestedPruningGoal).toContain("regression pass rate");
  expect(report.suggestedPruningGoal).not.toContain("slots/improver+judge");

  // Reversing key order yields identical sorted findings
  const reversedTree = Object.fromEntries(Object.entries(tree).reverse());
  const reversed = inspectHarnessHygiene(reversedTree, {
    commitSha: "dirty-sha",
    improverSlot: { providerId: "openai", modelId: "gpt-5" },
    judgeSlot: { providerId: "openai", modelId: "gpt-5" },
  });
  expect(reversed.findings).toEqual(report.findings);
});
