import { beforeEach, describe, expect, it } from "bun:test";
import { MockIpcAdapter, TauriIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("Breaking-Update Self-Healing Migration Alert & Harness² Migration", () => {
  let adapter: MockIpcAdapter;

  beforeEach(async () => {
    adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("defaults to clean compatibility report, detects breaking upgrade, runs migration into Triage, and resolves on adoption", async () => {
    await new Promise((r) => setTimeout(r, 15));
    const clean = useCommandDeckStore.getState().compatibilityReport;
    expect(clean?.hasBreakingIssues).toBe(false);
    expect(clean?.needsMigration).toBe(false);

    // Simulate a breaking upgrade impact
    adapter.simulateBreakingUpgrade(true);
    const report = await useCommandDeckStore.getState().checkHarnessCompatibility();
    expect(report?.hasBreakingIssues).toBe(true);
    expect(report?.needsMigration).toBe(true);
    expect(report?.quarantinedPaths).toEqual(["hooks/custom_hook.ts"]);
    expect(report?.issues.length).toBe(2);

    // Launch Harness² self-healing migration
    const proposal = await useCommandDeckStore.getState().startHarnessMigration();
    expect(proposal).not.toBeNull();
    expect(proposal?.triggerSource).toBe("upgrade_migration");
    expect(proposal?.diffs.map((d) => d.path)).toEqual([
      "hooks/custom_hook.ts",
      "manifest.json",
    ]);

    const afterMig = useCommandDeckStore.getState();
    expect(afterMig.rightTab).toBe("triage");
    expect(afterMig.selectedProposalId).toBe(proposal!.id);
    expect(afterMig.isMigrating).toBe(false);

    // Adopting the migration proposal resolves the breaking migration alert
    await useCommandDeckStore.getState().adoptProposal(proposal!.id, true);
    const resolved = useCommandDeckStore.getState().compatibilityReport;
    expect(resolved?.hasBreakingIssues).toBe(false);
    expect(resolved?.needsMigration).toBe(false);
  });

  it("TauriIpcAdapter invokes evolution.check_compatibility and evolution.start_migration with validated payloads", async () => {
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const sampleReport = {
      checkedAt: "2026-11-20T11:00:00Z",
      appVersion: "0.2.0",
      expectedSchemaVersion: 2,
      harnessSchemaVersion: 1,
      commitSha: "a7f3c91",
      hasBreakingIssues: true,
      needsMigration: true,
      quarantinedPaths: ["hooks/custom_hook.ts"],
      issues: [
        {
          path: "hooks/custom_hook.ts",
          kind: "deprecated_hook_contract",
          severity: "breaking",
          message: "Legacy signature",
        },
      ],
    };
    const sampleProposal = {
      id: "prop-mig-1",
      threadId: "thr-1",
      domain: "migration",
      title: "Repair custom_hook.ts",
      mode: "sequential",
      k: 1,
      triggerSource: "upgrade_migration",
      sourceTags: ["local"],
      requiresHumanTrust: true,
      baseCommitSha: "a7f3c91",
      status: "ready",
      metricsBefore: { steps: 3, errors: 1, durationMs: 3000, tokens: 1200, costUsd: 0.01 },
      metricsAfter: { steps: 1, errors: 0, durationMs: 1000, tokens: 600, costUsd: 0.005 },
      diffs: [],
      inlineComments: [],
      createdAt: "2026-11-20T11:00:00Z",
      updatedAt: "2026-11-20T11:00:00Z",
    };

    const tauri = new TauriIpcAdapter({
      invoke: async <T>(_cmd: string, args?: Record<string, unknown>) => {
        const method = String(args?.method ?? "");
        const params = args?.params;
        rpcCalls.push({ method, params });
        if (method === "evolution.check_compatibility") return sampleReport as T;
        if (method === "evolution.start_migration") return sampleProposal as T;
        return {} as T;
      },
    });

    const report = await tauri.checkHarnessCompatibility();
    expect(report.hasBreakingIssues).toBe(true);
    expect(report.quarantinedPaths).toEqual(["hooks/custom_hook.ts"]);

    const proposal = await tauri.startHarnessMigration(report);
    expect(proposal.triggerSource).toBe("upgrade_migration");
    expect(rpcCalls[0]).toEqual({ method: "evolution.check_compatibility", params: {} });
    expect(rpcCalls[1]).toEqual({
      method: "evolution.start_migration",
      params: { report },
    });
  });
});
