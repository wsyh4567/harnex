import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  HIGH_PRIVILEGE_HARNESS_PREFIXES,
  HarnessComponentKindSchema,
  OnboardingReplayTraceSchema,
} from "../../packages/protocol/src/index.ts";
import { trimToolOutput } from "../../harness-seed/hooks/example_trim_output.ts";
import { checkEvalSuite, gradeTaskOutput } from "../../benchmarks/internal-eval/evaluate.ts";
import { verifyDatasetA } from "./dataset_a/verify.ts";
import { verifyDatasetB } from "./dataset_b/verify.ts";

const repoRoot = resolve(dirname(import.meta.path), "../..");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`Validation failed: ${msg}`);
  }
}

function validateHarnessSeed(): void {
  const seedDir = join(repoRoot, "harness-seed");
  const requiredPaths = [
    "manifest.json",
    "systemprompt.md",
    "guardrails.md",
    "memory/LongTermMEMORY.md",
    "tool_descriptions/fs_and_shell.md",
    "skills/.gitkeep",
    "skills/README.md",
    "skills/workspace-triage/SKILL.md",
    "skills/safe-data-ops/SKILL.md",
    "skills/verify-before-done/SKILL.md",
    "scripts/.gitkeep",
    "scripts/README.md",
    "hooks/example_trim_output.ts",
    "sub_agents/example_helper.md",
    "mcp/servers.json",
    "sandbox_policies/README.md",
    "views/.gitkeep",
    "meta/regression_cases.jsonl",
    "meta/domains/.gitkeep",
  ];

  for (const rel of requiredPaths) {
    assert(existsSync(join(seedDir, rel)), `Missing harness-seed file: ${rel}`);
  }

  const manifest = JSON.parse(readFileSync(join(seedDir, "manifest.json"), "utf8")) as {
    schemaVersion: number;
    name: string;
    version: string;
    components: Record<string, string>;
    highPrivilegePrefixes: string[];
  };
  assert(manifest.schemaVersion === 1, "manifest.schemaVersion must be 1");
  assert(manifest.name === "harnex-seed", "manifest.name must be harnex-seed");
  for (const kind of HarnessComponentKindSchema.options) {
    assert(kind in manifest.components, `manifest.components missing ${kind}`);
  }
  for (const prefix of HIGH_PRIVILEGE_HARNESS_PREFIXES) {
    assert(
      manifest.highPrivilegePrefixes.includes(prefix),
      `manifest.highPrivilegePrefixes missing ${prefix}`,
    );
  }

  const mcpConfig = JSON.parse(readFileSync(join(seedDir, "mcp/servers.json"), "utf8")) as {
    schemaVersion: number;
    servers: Array<{ id: string; enabled: boolean }>;
  };
  assert(mcpConfig.schemaVersion === 1, "mcp/servers.json schemaVersion must be 1");
  assert(mcpConfig.servers.length >= 1, "mcp/servers.json must include Playwright example");
  assert(mcpConfig.servers[0]?.enabled === false, "Seed Playwright MCP must be disabled by default");

  // Validate example_trim_output.ts runtime behavior
  const shortRes = trimToolOutput({ event: "PostToolUse", toolName: "execShell", stdout: "ok" });
  assert(shortRes.action === "pass", "Short output hook must pass");
  const longRes = trimToolOutput({
    event: "PostToolUse",
    toolName: "execShell",
    stdout: "a".repeat(200),
    maxChars: 80,
  });
  assert(longRes.action === "modify" && longRes.truncated === true, "Long output hook must truncate");
}

function validateRecordedReplay(): void {
  const replayPath = join(repoRoot, "examples/first-run-challenge/recorded_replay.json");
  const raw = JSON.parse(readFileSync(replayPath, "utf8"));
  const parsed = OnboardingReplayTraceSchema.parse(raw);
  assert(parsed.steps.length === 8, `Expected 8 replay steps, got ${parsed.steps.length}`);
}

function validateDatasetGraders(): void {
  const scratch = join(tmpdir(), `harnex-validate-${Date.now()}`);
  const outA = join(scratch, "out_a");
  const outB = join(scratch, "out_b");
  mkdirSync(outA, { recursive: true });
  mkdirSync(outB, { recursive: true });

  try {
    // Golden output for dataset_a
    writeFileSync(
      join(outA, "billing_summary.json"),
      JSON.stringify({
        currency: "CNY",
        usdToCnyRate: 7.2,
        recordCount: 9,
        voidedCount: 2,
        grossPaidCny: 6656.75,
        refundTotalCny: -500.75,
        netTotalCny: 6156.0,
        byCategory: {
          Cloud: 2850.5,
          Meals: 345.5,
          Network: 500.0,
          Office: 300.0,
          Software: 2160.0,
        },
      }),
    );
    writeFileSync(
      join(outA, "billing_cleaned.csv"),
      [
        "id,date,vendor,category,amount_cny,status,source_file",
        "EAST-101,2026-10-05,华东云算力有限公司,Cloud,1800.00,PAID,2026-10-branch-east-gbk.csv",
        "EAST-102,2026-10-11,星河办公采购,Office,420.75,PAID,2026-10-branch-east-gbk.csv",
        "EAST-103,2026-10-19,星河办公采购,Office,-120.75,REFUND,2026-10-branch-east-gbk.csv",
        "HQ-001,2026-10-03,Alibaba Cloud,Cloud,1250.50,PAID,2026-10-hq-utf8-bom.csv",
        "HQ-002,2026-10-07,Figma Inc,Software,2160.00,PAID,2026-10-hq-utf8-bom.csv",
        "HQ-003,2026-10-12,Alibaba Cloud,Cloud,-200.00,REFUND,2026-10-hq-utf8-bom.csv",
        "SOUTH-201,2026-10-09,Shenzhen Fiber Tech,Network,680.00,PAID,2026-10-branch-south-dirty.csv",
        "SOUTH-202,2026-10-22,South Bay Catering,Meals,345.50,PAID,2026-10-branch-south-dirty.csv",
        "SOUTH-203,2026-10-25,Shenzhen Fiber Tech,Network,-180.00,REFUND,2026-10-branch-south-dirty.csv",
      ].join("\n"),
    );
    const resA = verifyDatasetA(outA);
    assert(resA.passed, `dataset_a grader failed on golden sample: ${resA.errors.join("; ")}`);

    // Golden output for dataset_b
    writeFileSync(
      join(outB, "reconciled_expenses.json"),
      JSON.stringify({
        currency: "CNY",
        usdToCnyRate: 7.2,
        approvedCount: 4,
        excludedIds: ["INV-2026-104"],
        totalApprovedCny: 4330.5,
        byProject: { "Infra-Core": 1200.0, "Q4-Launch": 3130.5 },
        items: [
          { id: "INV-2026-101", vendor: "Skyline Air", category: "Travel", project: "Q4-Launch", amountCny: 2450, source: "receipt+notes" },
          { id: "INV-2026-102", vendor: "Bean & Co Catering", category: "Meals", project: "Q4-Launch", amountCny: 680.5, source: "receipt+notes" },
          { id: "INV-2026-103", vendor: "GPU Cloud Labs", category: "Compute", project: "Infra-Core", amountCny: 1080, source: "receipt+notes" },
          { id: "PETTY-2026-01", vendor: "DNS Registrar", category: "Operations", project: "Infra-Core", amountCny: 120, source: "notes" },
        ],
      }),
    );
    writeFileSync(
      join(outB, "reconciled_expenses.csv"),
      [
        "id,vendor,category,project,amount_cny,source",
        "INV-2026-101,Skyline Air,Travel,Q4-Launch,2450.00,receipt+notes",
        "INV-2026-102,Bean & Co Catering,Meals,Q4-Launch,680.50,receipt+notes",
        "INV-2026-103,GPU Cloud Labs,Compute,Infra-Core,1080.00,receipt+notes",
        "PETTY-2026-01,DNS Registrar,Operations,Infra-Core,120.00,notes",
      ].join("\n"),
    );
    const resB = verifyDatasetB(outB);
    assert(resB.passed, `dataset_b grader failed on golden sample: ${resB.errors.join("; ")}`);

    // Also sanity-check internal-eval suite & negative grading case
    const suite = checkEvalSuite(join(repoRoot, "benchmarks/internal-eval"));
    assert(suite.valid && suite.taskCount === 12, `internal-eval invalid: ${suite.errors.join("; ")}`);
    const negGrade = gradeTaskOutput("task-01-file-ops-dedup", outA, join(repoRoot, "benchmarks/internal-eval"));
    assert(!negGrade.passed, "Empty workspace should fail task-01 grading");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

validateHarnessSeed();
validateRecordedReplay();
validateDatasetGraders();

console.log(
  JSON.stringify(
    {
      ok: true,
      validated: [
        "harness-seed/ structure, manifest.json, mcp/servers.json, hooks/example_trim_output.ts",
        "examples/first-run-challenge/recorded_replay.json (OnboardingReplayTraceSchema)",
        "examples/first-run-challenge/dataset_a/verify.ts & dataset_b/verify.ts",
        "benchmarks/internal-eval/ (12 tasks + evaluate.ts)",
      ],
    },
    null,
    2,
  ),
);
