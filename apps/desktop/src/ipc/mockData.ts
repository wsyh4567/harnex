import {
  OnboardingReplayTraceSchema,
  type AppConfig,
  type ApprovalRequest,
  type BudgetStatus,
  type ChatMessage,
  type EvolutionProposal,
  type ExecPolicyRule,
  type GenomeCommit,
  type GenomeFile,
  type GlobalHookItem,
  type GuardianDecision,
  type OnboardingReplayTrace,
  type ProviderConfig,
  type SystemHealth,
  type Thread,
  type TrustRecord,
} from "@harnex/protocol";
import recordedReplayJson from "../../../../examples/first-run-challenge/recorded_replay.json";

const nowMinus = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

export const INITIAL_COMMIT_SHAS = {
  v0: "0000000000000000000000000000000000000000",
  v5: "5e12b84a9d0c1130e8a472f9c120112233445505",
  v6: "6b41c77d21f8e4a0c31954d1b987654321000006",
  v7: "a7f3c91e48d2b06f1c529a8d4039281726354407",
} as const;

export function createInitialSystemHealth(): SystemHealth {
  return {
    sidecarAlive: true,
    sidecarRestartCount: 0,
    platform: "windows",
    sandboxBackend: "win-job-restricted-token",
    osSandboxLevel: "beta",
    bunEmbeddedOk: true,
    activeCommitSha: INITIAL_COMMIT_SHAS.v7,
    rsiMode: "manual",
  };
}

export function createInitialAppConfig(): AppConfig {
  return {
    schemaVersion: 1,
    rsiMode: "manual",
    defaultWorkspace: "~/Work",
    slots: {
      solver: { providerId: "prov-openai", modelId: "gpt-4.1-mini" },
      improver: { providerId: "prov-anthropic", modelId: "claude-sonnet-4-5" },
      judge: { providerId: "prov-openai", modelId: "gpt-4.1" },
    },
    dailyBudgetLimitUsd: 5.0,
  };
}

export function createInitialThreads(): Thread[] {
  return [
    {
      id: "thr-billing-csv",
      workspacePath: "~/Work",
      title: "Billing CSV Encoding Cleanup",
      mode: "craft",
      status: "awaiting_approval",
      pinnedCommitSha: INITIAL_COMMIT_SHAS.v7,
      pinnedVersionLabel: "v7",
      domain: "file_ops",
      goals: [
        { id: "g1", title: "Scan ~/Work/invoices directory", status: "completed" },
        { id: "g2", title: "Decode GB18030/GBK CSV headers safely", status: "in_progress" },
        { id: "g3", title: "Export normalized UTF-8 summary table", status: "pending" },
      ],
      contextUsedTokens: 43_520,
      contextMaxTokens: 128_000,
      sourceTags: ["local"],
      hadHumanSteer: true,
      createdAt: nowMinus(18),
      updatedAt: nowMinus(1),
    },
    {
      id: "thr-competitor-dossier",
      workspacePath: "~/Work",
      title: "Competitor Dossier Synthesis",
      mode: "plan",
      status: "idle",
      pinnedCommitSha: INITIAL_COMMIT_SHAS.v7,
      pinnedVersionLabel: "v7",
      domain: "research",
      goals: [
        { id: "g4", title: "Collect local briefing notes", status: "completed" },
        { id: "g5", title: "Draft comparison matrix", status: "pending" },
      ],
      contextUsedTokens: 14_200,
      contextMaxTokens: 128_000,
      sourceTags: ["local", "web"],
      hadHumanSteer: false,
      createdAt: nowMinus(45),
      updatedAt: nowMinus(12),
    },
    {
      id: "thr-acme-logs",
      workspacePath: "~/Projects/acme-data",
      title: "Log Anomaly Triage",
      mode: "ask",
      status: "completed",
      pinnedCommitSha: INITIAL_COMMIT_SHAS.v6,
      pinnedVersionLabel: "v6",
      domain: "diagnostics",
      goals: [
        { id: "g6", title: "Parse nginx 502 spike window", status: "completed" },
        { id: "g7", title: "Summarize upstream timeouts", status: "completed" },
      ],
      contextUsedTokens: 21_080,
      contextMaxTokens: 128_000,
      sourceTags: ["local"],
      hadHumanSteer: false,
      createdAt: nowMinus(120),
      updatedAt: nowMinus(65),
    },
  ];
}

export function createInitialMessages(): Record<string, ChatMessage[]> {
  return {
    "thr-billing-csv": [
      {
        id: "msg-1",
        threadId: "thr-billing-csv",
        role: "user",
        content: "Parse this month's garbled billing CSV files in ~/Work/invoices and generate report_utf8.csv.",
        createdAt: nowMinus(18),
      },
      {
        id: "msg-2",
        threadId: "thr-billing-csv",
        role: "assistant",
        content: "Scanned 12 CSV files in `~/Work/invoices`. Detected legacy GBK / GB18030 byte sequences causing UTF-8 decode failures on rows 4–19.",
        reasoning:
          "1. Listing directory files via fs_scan.\n2. Initial UTF-8 read threw U+FFFD replacement characters.\n3. Probing byte BOM and running iconv / TextDecoder('gb18030').",
        toolCalls: [
          {
            id: "tc-1",
            name: "fs_ops.scan_dir",
            args: { path: "~/Work/invoices", pattern: "*.csv" },
            status: "completed",
            output: "Found 12 files (total 482 KB). Sample header bytes: b9 a9 d3 a6 c9 cc...",
            truncated: false,
            startedAt: nowMinus(17),
            finishedAt: nowMinus(17),
          },
          {
            id: "tc-2",
            name: "shell.exec",
            args: { command: "file -bi ~/Work/invoices/*.csv" },
            status: "completed",
            output: "text/plain; charset=unknown-8bit (GB18030 signature detected)",
            truncated: false,
            startedAt: nowMinus(16),
            finishedAt: nowMinus(16),
          },
        ],
        createdAt: nowMinus(16),
      },
      {
        id: "msg-3",
        threadId: "thr-billing-csv",
        role: "steer",
        content: "Do not coerce bytes with UTF-8 lossy mode. Detect GB18030 first and preserve RMB decimal precision before exporting.",
        createdAt: nowMinus(14),
      },
      {
        id: "msg-4",
        threadId: "thr-billing-csv",
        role: "assistant",
        content:
          "Steer instruction applied and flagged for Harness² self-evolution. Attempting to write consolidated output outside sandbox scope.",
        createdAt: nowMinus(2),
      },
    ],
    "thr-competitor-dossier": [
      {
        id: "msg-c1",
        threadId: "thr-competitor-dossier",
        role: "user",
        content: "Compare local product specs in ~/Work/briefs and prepare a feature table.",
        createdAt: nowMinus(40),
      },
      {
        id: "msg-c2",
        threadId: "thr-competitor-dossier",
        role: "assistant",
        content: "Ready in Plan mode. Collected 4 local markdown briefs. Send a follow-up prompt or switch to Craft to write the matrix.",
        createdAt: nowMinus(38),
      },
    ],
    "thr-acme-logs": [
      {
        id: "msg-a1",
        threadId: "thr-acme-logs",
        role: "user",
        content: "Summarize the 02:15 UTC upstream timeout spike in access.log.",
        createdAt: nowMinus(115),
      },
      {
        id: "msg-a2",
        threadId: "thr-acme-logs",
        role: "assistant",
        content: "Peak 502 rate reached 14.8% between 02:14:10 and 02:16:40 UTC due to upstream worker pool saturation (128/128 busy).",
        createdAt: nowMinus(110),
      },
    ],
  };
}

export function createInitialApprovals(): ApprovalRequest[] {
  return [
    {
      requestId: "apr-l0-export",
      threadId: "thr-billing-csv",
      kind: "sandbox_escape",
      summary: "Write outside workspace boundary: ~/Desktop/quarterly_report.csv",
      detail:
        "Rust L0 OS Sandbox intercepted a write target outside ~/Work. Granting Allow Once permits only this single file write; workspace-write wall remains enforced for all other paths.",
      commandOrPath: "~/Desktop/quarterly_report.csv",
      riskLevel: "medium",
      riskReasonCode: "sandbox_escape",
      sourceTags: ["local"],
      createdAt: nowMinus(2),
    },
    {
      requestId: "apr-hook-sha",
      threadId: "thr-billing-csv",
      kind: "hook_trust",
      summary: "Hook SHA-256 First-Trust Confirmation: hooks/csv_utf8_guard.ts",
      detail:
        "Content hash changed by 1+ bytes or newly evolved hook has not yet been recorded in ~/.harnex/trust.json. Inspect diff before trusting.",
      commandOrPath: "hooks/csv_utf8_guard.ts",
      riskLevel: "high",
      riskReasonCode: "hook_untrusted",
      sha256: "9d4f28b0c71e6a234f8e1092a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a",
      previousSha256: "1a2b3c4d5e6f708090a0b0c0d0e0f0112233445566778899aabbccddeeff0011",
      sourceTags: ["local"],
      createdAt: nowMinus(1),
    },
  ];
}

export function createInitialExecPolicy(): ExecPolicyRule[] {
  return [
    {
      id: "pol-1",
      prefix: "git status",
      action: "allow",
      description: "Read-only repository inspection",
    },
    {
      id: "pol-2",
      prefix: "ls ",
      action: "allow",
      description: "Read-only directory listing",
    },
    {
      id: "pol-3",
      prefix: "curl ",
      action: "prompt",
      description: "Outbound network transfer requires confirmation",
    },
    {
      id: "pol-4",
      prefix: "rm -rf /",
      action: "forbidden",
      description: "Hard block destructive root deletion",
    },
  ];
}

export function createInitialTrustRecords(): TrustRecord[] {
  return [
    {
      id: "tr-1",
      kind: "mcp",
      identifier: "playwright-mcp",
      status: "trusted",
      origin: "user_installed",
      updatedAt: nowMinus(240),
    },
    {
      id: "tr-2",
      kind: "hook",
      identifier: "hooks/example_trim_output.ts",
      sha256: "3c8e7f901a2b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
      status: "disabled",
      origin: "user_installed",
      updatedAt: nowMinus(300),
    },
    {
      id: "tr-3",
      kind: "script",
      identifier: "scripts/safe_gbk_parse.ts",
      sha256: "7f4a21c90b8e3d5a1c7f902e4d6b8a1c3e5f7092a4b6c8d0e2f4a6b8c0d2e4f6",
      status: "untrusted",
      origin: "rsi_evolved",
      updatedAt: nowMinus(3),
    },
  ];
}

export function createInitialGlobalHooks(): GlobalHookItem[] {
  return [
    {
      path: "hooks/csv_utf8_guard.ts",
      name: "csv_utf8_guard",
      event: "PostToolUse",
      content: [
        "// @event PostToolUse",
        "// Verify GB18030 -> UTF-8 CSV exports retain valid RMB decimals",
        "export default function csvUtf8Guard(payload: { targetPath?: string; stdout?: string }) {",
        "  if (payload.stdout && payload.stdout.includes(\"\\uFFFD\")) {",
        "    return { ok: false, reason: \"Detected lossy UTF-8 replacement character\" };",
        "  }",
        "  return { ok: true, targetPath: payload.targetPath };",
        "}",
      ].join("\n"),
      sha256: "9d4f28b0c71e6a234f8e1092a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a",
      status: "untrusted",
      origin: "rsi_evolved",
      updatedAt: nowMinus(1),
    },
    {
      path: "hooks/example_trim_output.ts",
      name: "example_trim_output",
      event: "PostToolUse",
      content:
        "// Example PostToolUse hook (disabled by default until SHA-256 trusted)\nexport default function trimOutput(payload: { stdout: string }) {\n  return { stdout: payload.stdout.slice(0, 4000) };\n}",
      sha256: "3c8e7f901a2b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
      status: "disabled",
      origin: "user_installed",
      updatedAt: nowMinus(300),
    },
  ];
}

export function createInitialGuardianDecisions(): GuardianDecision[] {
  return [
    {
      requestId: "grd-101",
      threadId: "thr-billing-csv",
      decision: "allow",
      riskLevel: "low",
      reason: "Read-only file signature inspection inside bound workspace ~/Work.",
      commandOrPath: "file -bi ~/Work/invoices/*.csv",
      modelId: "gpt-4.1",
      sanitizedInputOnly: true,
      timestamp: nowMinus(16),
    },
    {
      requestId: "grd-102",
      threadId: "thr-competitor-dossier",
      decision: "escalate",
      riskLevel: "high",
      riskReasonCode: "untrusted_source",
      reason: "Thread touched external web content; outbound curl or high-privilege script requires human verification.",
      commandOrPath: "curl -X POST https://example.invalid/upload",
      modelId: "gpt-4.1",
      sanitizedInputOnly: true,
      timestamp: nowMinus(25),
    },
  ];
}

export function createInitialProposals(): EvolutionProposal[] {
  return [
    {
      id: "prop-8",
      threadId: "thr-billing-csv",
      domain: "file_ops",
      title: "Proposal #8: Auto-detect GB18030/GBK CSV & Strip BOM Safely",
      mode: "parallel",
      k: 2,
      triggerSource: "steer",
      sourceTags: ["local"],
      requiresHumanTrust: true,
      baseCommitSha: INITIAL_COMMIT_SHAS.v7,
      status: "ready",
      metricsBefore: {
        steps: 7,
        errors: 3,
        durationMs: 18_400,
        tokens: 9_840,
        costUsd: 0.09,
      },
      metricsAfter: {
        steps: 2,
        errors: 0,
        durationMs: 4_120,
        tokens: 4_110,
        costUsd: 0.038,
      },
      blindJudge: {
        seed: "sha1:8b4f21c",
        optionALabel: "Baseline Harness v7",
        optionBLabel: "Candidate Harness v8 (GBK Parser + Shell Cue)",
        winnerAnonId: "anon-B",
        winnerLabel: "Option B (Candidate)",
        winnerIsCandidate: true,
        forwardWinnerAnonId: "anon-B",
        reverseWinnerAnonId: "anon-B",
        orderConsistent: true,
        confidence: "high",
        reasoning:
          "Candidate deterministically identifies GB18030 byte ranges via `TextDecoder('gb18030', { fatal: true })` in 2 steps with zero decode errors, preserving RMB decimal precision and avoiding lossy UTF-8 coercion.",
        judgeModelId: "gpt-4.1",
      },
      diffs: [
        {
          path: "scripts/safe_gbk_parse.ts",
          changeType: "added",
          isHighPrivilege: true,
          before: "",
          after: [
            "// Auto-evolved Bun single-file helper (runs inside Rust L0 OS sandbox)",
            "import { readFileSync, writeFileSync } from \"node:fs\";",
            "",
            "export function decodeCsvSafely(inputPath: string, outputPath: string): void {",
            "  const raw = readFileSync(inputPath);",
            "  let text: string;",
            "  try {",
            "    text = new TextDecoder(\"utf-8\", { fatal: true }).decode(raw);",
            "  } catch {",
            "    text = new TextDecoder(\"gb18030\", { fatal: true }).decode(raw);",
            "  }",
            "  const normalized = text.replace(/^\\uFEFF/, \"\").replace(/\\r\\n/g, \"\\n\");",
            "  writeFileSync(outputPath, normalized, \"utf-8\");",
            "}",
          ].join("\n"),
          unifiedDiff: [
            "@@ -0,0 +1,14 @@",
            "+// Auto-evolved Bun single-file helper (runs inside Rust L0 OS sandbox)",
            "+import { readFileSync, writeFileSync } from \"node:fs\";",
            "+",
            "+export function decodeCsvSafely(inputPath: string, outputPath: string): void {",
            "+  const raw = readFileSync(inputPath);",
            "+  let text: string;",
            "+  try {",
            "+    text = new TextDecoder(\"utf-8\", { fatal: true }).decode(raw);",
            "+  } catch {",
            "+    text = new TextDecoder(\"gb18030\", { fatal: true }).decode(raw);",
            "+  }",
            "+  const normalized = text.replace(/^\\uFEFF/, \"\").replace(/\\r\\n/g, \"\\n\");",
            "+  writeFileSync(outputPath, normalized, \"utf-8\");",
            "+}",
          ].join("\n"),
        },
        {
          path: "tool_descriptions/shell.md",
          changeType: "modified",
          isHighPrivilege: false,
          before: "# Shell Tool\nUse standard UTF-8 reading for text files.",
          after:
            "# Shell Tool\nUse standard UTF-8 reading for text files.\n- For legacy Chinese CSV/TSV files, always probe `gb18030` via `scripts/safe_gbk_parse.ts` before regex parsing.",
          unifiedDiff: [
            "@@ -1,2 +1,3 @@",
            " # Shell Tool",
            " Use standard UTF-8 reading for text files.",
            "+- For legacy Chinese CSV/TSV files, always probe `gb18030` via `scripts/safe_gbk_parse.ts` before regex parsing.",
          ].join("\n"),
        },
      ],
      experienceEntry: {
        domain: "file_ops",
        cue: "CSV or tabular file contains U+FFFD replacement glyphs or legacy CJK byte sequences",
        lesson: "Try strict UTF-8 decoding with `{ fatal: true }`, then fall back to `gb18030` via `scripts/safe_gbk_parse.ts` before downstream parsing.",
        evidence: "CoW shadow probe reduced step count 7 -> 2 and errors 3 -> 0 across 12 invoice CSV fixtures.",
        confidence: "high (0.94)",
        editsSummary: "Added scripts/safe_gbk_parse.ts; updated tool_descriptions/shell.md",
      },
      inlineComments: [],
      regressionCheck: {
        total: 6,
        passed: 6,
        failed: 0,
      },
      createdAt: nowMinus(3),
      updatedAt: nowMinus(3),
    },
    {
      id: "prop-9",
      threadId: "thr-competitor-dossier",
      domain: "research",
      title: "Proposal #9: Extract Structured Pricing Matrix from External Briefs",
      mode: "sequential",
      k: 1,
      triggerSource: "manual",
      sourceTags: ["web", "external_file"],
      requiresHumanTrust: true,
      baseCommitSha: INITIAL_COMMIT_SHAS.v7,
      status: "ready",
      metricsBefore: {
        steps: 6,
        errors: 1,
        durationMs: 14_200,
        tokens: 7_400,
        costUsd: 0.065,
      },
      metricsAfter: {
        steps: 3,
        errors: 0,
        durationMs: 7_900,
        tokens: 4_850,
        costUsd: 0.041,
      },
      blindJudge: {
        seed: "sha1:3e91a04",
        optionALabel: "Candidate Harness (Web-sourced Skill)",
        optionBLabel: "Baseline Harness v7",
        winnerAnonId: "anon-A",
        winnerLabel: "Option A (Candidate)",
        winnerIsCandidate: true,
        forwardWinnerAnonId: "anon-A",
        reverseWinnerAnonId: "anon-A",
        orderConsistent: true,
        confidence: "medium",
        reasoning:
          "Candidate adds a reusable table-normalization prompt in `skills/dossier_matrix/SKILL.md`. Because trace included external web inputs, human provenance review is mandatory.",
        judgeModelId: "gpt-4.1",
      },
      diffs: [
        {
          path: "skills/dossier_matrix/SKILL.md",
          changeType: "added",
          isHighPrivilege: false,
          before: "",
          after: "# Dossier Matrix Skill\nNormalize pricing tiers to USD/month before comparing.",
          unifiedDiff: [
            "@@ -0,0 +1,2 @@",
            "+# Dossier Matrix Skill",
            "+Normalize pricing tiers to USD/month before comparing.",
          ].join("\n"),
        },
        {
          path: "systemprompt.md",
          changeType: "modified",
          isHighPrivilege: true,
          before: "Always verify workspace facts directly from files.",
          after: "Always verify workspace facts directly from files.\nWhen comparing vendor tiers, check skills/dossier_matrix/SKILL.md.",
          unifiedDiff: [
            "@@ -1 +1,2 @@",
            " Always verify workspace facts directly from files.",
            "+When comparing vendor tiers, check skills/dossier_matrix/SKILL.md.",
          ].join("\n"),
        },
      ],
      experienceEntry: {
        domain: "research",
        cue: "Synthesizing multi-vendor pricing tiers from mixed local and web briefs",
        lesson: "Normalize billing cadence to monthly USD before building comparison tables.",
        evidence: "Shadow probe eliminated 1 currency-mismatch warning and cut steps from 6 to 3.",
        confidence: "medium (0.79)",
        editsSummary: "Added skills/dossier_matrix/SKILL.md; touched systemprompt.md",
      },
      inlineComments: [],
      regressionCheck: {
        total: 6,
        passed: 6,
        failed: 0,
      },
      createdAt: nowMinus(10),
      updatedAt: nowMinus(10),
    },
  ];
}

export function createInitialCommits(): GenomeCommit[] {
  return [
    {
      sha: INITIAL_COMMIT_SHAS.v7,
      parentSha: INITIAL_COMMIT_SHAS.v6,
      versionTag: "v7",
      message: "Adopt file_ops directory batching cue & regression guard",
      timestamp: nowMinus(60),
      domain: "file_ops",
      passRate: 0.94,
      changedComponents: ["tool_descriptions", "meta"],
      isRollback: false,
    },
    {
      sha: INITIAL_COMMIT_SHAS.v6,
      parentSha: INITIAL_COMMIT_SHAS.v5,
      versionTag: "v6",
      message: "Distill upstream timeout triage cue into diagnostics/EXPERIENCE.md",
      timestamp: nowMinus(180),
      domain: "diagnostics",
      passRate: 0.88,
      changedComponents: ["memory", "meta"],
      isRollback: false,
    },
    {
      sha: INITIAL_COMMIT_SHAS.v5,
      parentSha: INITIAL_COMMIT_SHAS.v0,
      versionTag: "v5",
      message: "Add strict JSON output schema guardrail",
      timestamp: nowMinus(420),
      domain: "general",
      passRate: 0.78,
      changedComponents: ["guardrails", "skills"],
      isRollback: false,
    },
    {
      sha: INITIAL_COMMIT_SHAS.v0,
      versionTag: "v0",
      message: "Harnex factory minimal seed (clean slate)",
      timestamp: nowMinus(1440),
      domain: "seed",
      passRate: 0.42,
      changedComponents: ["systemprompt", "guardrails"],
      isRollback: false,
    },
  ];
}

export function createInitialGenomeTree(): Record<string, GenomeFile[]> {
  const v7Files: GenomeFile[] = [
    {
      path: "manifest.json",
      component: "meta",
      content: JSON.stringify(
        {
          schemaVersion: 1,
          genomeVersion: "v7",
          healthStatus: "healthy",
          createdBy: "Harnex",
        },
        null,
        2,
      ),
      sizeBytes: 112,
    },
    {
      path: "systemprompt.md",
      component: "systemprompt",
      content:
        "# Harnex Genesis Prompt\nYou are a careful, deterministic desktop agent. Always verify workspace facts directly from files and respect L0 sandbox boundaries.",
      sizeBytes: 152,
    },
    {
      path: "guardrails.md",
      component: "guardrails",
      content:
        "# Soft Guardrails\n- Never fabricate file paths or command outputs.\n- Prefer minimal, reversible edits.\n- Surface encoding or schema ambiguities early.",
      sizeBytes: 147,
    },
    {
      path: "memory/LongTermMEMORY.md",
      component: "memory",
      content:
        "# Long-Term Memory\n- User prefers UTF-8 CSV exports with ISO-8601 dates and explicit RMB currency precision.",
      sizeBytes: 109,
    },
    {
      path: "tool_descriptions/shell.md",
      component: "tool_descriptions",
      content:
        "# Shell Tool\nUse standard UTF-8 reading for text files.\n- Batch directory scans and inspect headers before loading large file sets.",
      sizeBytes: 129,
    },
    {
      path: "skills/csv_audit/SKILL.md",
      component: "skills",
      content:
        "---\nname: csv-audit\ndescription: Validate CSV column count and delimiter consistency.\n---\nCheck header row length against sample data rows before aggregation.",
      sizeBytes: 158,
    },
    {
      path: "hooks/example_trim_output.ts",
      component: "hooks",
      content:
        "// Example PostToolUse hook (disabled by default until SHA-256 trusted)\nexport default function trimOutput(payload: { stdout: string }) {\n  return { stdout: payload.stdout.slice(0, 4000) };\n}",
      sizeBytes: 193,
    },
    {
      path: "sub_agents/example_helper.md",
      component: "sub_agents",
      content: "# Helper Worker Profile\nRead-only verifier for tabular outputs.",
      sizeBytes: 68,
    },
    {
      path: "mcp/servers.json",
      component: "mcp",
      content: JSON.stringify(
        {
          servers: {
            playwright: {
              command: "npx",
              args: ["@playwright/mcp@latest"],
              enabled: false,
            },
          },
        },
        null,
        2,
      ),
      sizeBytes: 148,
    },
    {
      path: "sandbox_policies/default.json",
      component: "sandbox_policies",
      content: JSON.stringify({ mode: "workspace-write", allowNetwork: false }, null, 2),
      sizeBytes: 55,
    },
    {
      path: "meta/domains/diagnostics/EXPERIENCE.md",
      component: "meta",
      content:
        "## Entry #1\n- **Cue**: Investigating intermittent 502 / upstream gateway timeouts in service logs\n- **Lesson**: Correlate 502 timestamps with upstream latency spikes in a single bounded awk/rg pass before opening full log archives.\n- **Evidence**: Reduced diagnostics steps from 9 to 4 with 0 timeout retries in v6.\n- **Confidence**: high (verified across 2 shadow probes)",
      sizeBytes: 368,
    },
    {
      path: "meta/domains/file_ops/EXPERIENCE.md",
      component: "meta",
      content:
        "## Entry #1\n- **Cue**: Multi-file directory aggregation\n- **Lesson**: Scan filenames and byte headers first before loading entire files into context.\n- **Evidence**: Cut tool calls by 45% in v7.\n- **Confidence**: high (order-consistent blind judge win)",
      sizeBytes: 256,
    },
    {
      path: "meta/regression_cases.jsonl",
      component: "meta",
      content:
        '{"id":"reg-1","domain":"diagnostics","prompt":"Summarize 502 spike","expect":"14.8%"}\n{"id":"reg-2","domain":"file_ops","prompt":"Check CSV delimiter","expect":"comma"}',
      sizeBytes: 162,
    },
  ];

  const v6Files: GenomeFile[] = v7Files
    .filter(
      (f) =>
        f.path !== "meta/domains/file_ops/EXPERIENCE.md" &&
        f.path !== "meta/regression_cases.jsonl",
    )
    .map((f) => {
      if (f.path === "manifest.json") {
        const content = JSON.stringify(
          { schemaVersion: 1, genomeVersion: "v6", healthStatus: "healthy", createdBy: "Harnex" },
          null,
          2,
        );
        return { ...f, content, sizeBytes: content.length };
      }
      if (f.path === "tool_descriptions/shell.md") {
        const content = "# Shell Tool\nUse standard UTF-8 reading for text files.";
        return { ...f, content, sizeBytes: content.length };
      }
      return f;
    });

  const v5Files: GenomeFile[] = v6Files
    .filter(
      (f) =>
        f.path !== "memory/LongTermMEMORY.md" &&
        f.path !== "meta/domains/diagnostics/EXPERIENCE.md",
    )
    .map((f) => {
      if (f.path === "manifest.json") {
        const content = JSON.stringify(
          { schemaVersion: 1, genomeVersion: "v5", healthStatus: "healthy", createdBy: "Harnex" },
          null,
          2,
        );
        return { ...f, content, sizeBytes: content.length };
      }
      return f;
    });

  const v0Files: GenomeFile[] = v5Files
    .filter(
      (f) => f.path === "manifest.json" || f.path === "systemprompt.md" || f.path === "guardrails.md",
    )
    .map((f) => {
      if (f.path === "manifest.json") {
        const content = JSON.stringify(
          { schemaVersion: 1, genomeVersion: "v0", healthStatus: "healthy", createdBy: "Harnex" },
          null,
          2,
        );
        return { ...f, content, sizeBytes: content.length };
      }
      if (f.path === "guardrails.md") {
        const content =
          "# Soft Guardrails\n- Never fabricate file paths or command outputs.\n- Prefer minimal, reversible edits.";
        return { ...f, content, sizeBytes: content.length };
      }
      return f;
    });

  return {
    [INITIAL_COMMIT_SHAS.v7]: v7Files,
    [INITIAL_COMMIT_SHAS.v6]: v6Files,
    [INITIAL_COMMIT_SHAS.v5]: v5Files,
    [INITIAL_COMMIT_SHAS.v0]: v0Files,
  };
}

export function createInitialProviders(): ProviderConfig[] {
  return [
    {
      id: "prov-openai",
      name: "OpenAI Compatible",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4.1-mini", "gpt-4.1", "o4-mini"],
      pinnedModels: ["gpt-4.1-mini"],
      keyringRef: "harnex/provider/prov-openai",
      hasApiKey: true,
      keys: [
        {
          id: "key-oa-1",
          label: "Primary Key",
          keyringRef: "harnex/provider/prov-openai/key-1",
          enabled: true,
          priority: 0,
          maskedHint: "sk-••••9a4f",
        },
        {
          id: "key-oa-2",
          label: "Backup Key #2",
          keyringRef: "harnex/provider/prov-openai/key-2",
          enabled: true,
          priority: 1,
          maskedHint: "sk-••••3c12",
          lastError: "429 rate limit recovered",
        },
      ],
      keyStrategy: "priority_failover",
      isAggregator: false,
      source: "manual",
      enabled: true,
      lastPingMs: 142,
    },
    {
      id: "prov-anthropic",
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      models: ["claude-sonnet-4-5", "claude-3-5-haiku"],
      pinnedModels: [],
      keyringRef: "harnex/provider/prov-anthropic",
      hasApiKey: true,
      keys: [
        {
          id: "key-ant-1",
          label: "Main Anthropic Key",
          keyringRef: "harnex/provider/prov-anthropic/key-1",
          enabled: true,
          priority: 0,
          maskedHint: "sk-••••7e01",
        },
      ],
      keyStrategy: "priority_failover",
      isAggregator: false,
      source: "manual",
      enabled: true,
      lastPingMs: 168,
    },
    {
      id: "prov-magpie",
      name: "Magpie Local Gateway (127.0.0.1:3425)",
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:3425/v1",
      models: [
        "group/smart-split",
        "demo-gateway/gpt-6.2-sol",
        "demo-gateway/deepseek-v4.1-flash",
        "ai-studio/gemini-4-hydrogen",
        "ai-studio/gemini-2.5-pro",
      ],
      pinnedModels: ["group/smart-split", "ai-studio/gemini-4-hydrogen"],
      keyringRef: "harnex/provider/prov-magpie",
      hasApiKey: true,
      isAggregator: true,
      source: "magpie",
      enabled: true,
      lastPingMs: 11,
    },
    {
      id: "prov-ollama",
      name: "Ollama Local",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: ["qwen2.5-coder:14b", "llama3.3:70b"],
      keyringRef: "harnex/provider/prov-ollama",
      hasApiKey: false,
      isAggregator: false,
      source: "manual",
      enabled: true,
      lastPingMs: 12,
    },
  ];
}

export function createInitialBudgetStatus(): BudgetStatus {
  return {
    dailyLimitUsd: 5.0,
    spentTodayUsd: 0.14,
    tokensToday: 38_420,
    unpricedTokensToday: 0,
    unpricedModelsToday: [],
    costSource: "estimated",
    tripped: false,
    pricingTable: [
      {
        modelId: "gpt-4.1-mini",
        inputPer1MUsd: 0.4,
        outputPer1MUsd: 1.6,
        cachedInputPer1MUsd: 0.1,
      },
      {
        modelId: "gpt-4.1",
        inputPer1MUsd: 2.0,
        outputPer1MUsd: 8.0,
        cachedInputPer1MUsd: 0.5,
      },
      {
        modelId: "claude-sonnet-4-5",
        inputPer1MUsd: 3.0,
        outputPer1MUsd: 15.0,
        cachedInputPer1MUsd: 0.3,
      },
      {
        modelId: "qwen2.5-coder:14b",
        inputPer1MUsd: 0,
        outputPer1MUsd: 0,
      },
    ],
  };
}

export function createOnboardingReplayTrace(): OnboardingReplayTrace {
  return OnboardingReplayTraceSchema.parse(recordedReplayJson);
}
