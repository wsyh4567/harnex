import { beforeEach, describe, expect, it } from "bun:test";
import { MockIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("Command Deck Store & F0-F4 Flows", () => {
  let adapter: MockIpcAdapter;

  beforeEach(async () => {
    adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("initializes all F0-F4 slices from MockIpcAdapter", () => {
    const s = useCommandDeckStore.getState();
    expect(s.initialized).toBe(true);
    expect(s.threads.length).toBeGreaterThanOrEqual(3);
    expect(s.activeThreadId).toBe("thr-billing-csv");
    expect(s.pendingApprovals.length).toBe(2);
    expect(s.proposals.length).toBeGreaterThanOrEqual(2);
    expect(s.commits.length).toBeGreaterThanOrEqual(4);
    expect(s.providers.length).toBeGreaterThanOrEqual(3);
    expect(s.onboardingReplay?.isRecordedReplay).toBe(true);
    expect(s.silentArchiveCount).toBe(3);
  });

  it("supports F1 thread creation, mode switching, and isolated /btw side chat", async () => {
    const store = useCommandDeckStore.getState();
    const created = await store.createThread("Test Thread", "plan");
    expect(useCommandDeckStore.getState().activeThreadId).toBe(created.id);
    expect(created.mode).toBe("plan");

    store.setThreadMode(created.id, "craft");
    const updated = useCommandDeckStore.getState().threads.find((t) => t.id === created.id);
    expect(updated?.mode).toBe("craft");

    await store.askSideChat("What commit SHA is pinned?");
    const sideTurns = useCommandDeckStore.getState().sideChatByThread[created.id] ?? [];
    expect(sideTurns.length).toBe(1);
    expect(sideTurns[0]?.answer).toContain("zero-pollution");
    // Main thread messages remain untouched by /btw side chat
    expect(useCommandDeckStore.getState().messagesByThread[created.id]?.length ?? 0).toBe(0);
  });

  it("handles F2 L0 approval & Hook SHA-256 resolution and ExecPolicy rules", async () => {
    const store = useCommandDeckStore.getState();
    expect(store.pendingApprovals.length).toBe(2);

    await store.resolveApproval("apr-hook-sha", "allow_session");
    const afterHook = useCommandDeckStore.getState();
    expect(afterHook.pendingApprovals.length).toBe(1);
    const trustedHook = afterHook.trustRecords.find(
      (r) => r.identifier === "hooks/csv_utf8_guard.ts",
    );
    expect(trustedHook?.status).toBe("trusted");

    await store.upsertExecPolicyRule({
      id: "pol-custom",
      prefix: "bun test",
      action: "allow",
      description: "Allow running unit tests",
    });
    expect(
      useCommandDeckStore.getState().execPolicyRules.some((r) => r.prefix === "bun test"),
    ).toBe(true);

    await store.deleteExecPolicyRule("pol-custom");
    expect(
      useCommandDeckStore.getState().execPolicyRules.some((r) => r.prefix === "bun test"),
    ).toBe(false);
  });

  it("handles F3 inline diff comments, re-evolution, and adopt & trust", async () => {
    const store = useCommandDeckStore.getState();
    const proposal = store.proposals.find((p) => p.id === "prop-8");
    expect(proposal).toBeDefined();

    store.addInlineCommentDraft(
      "prop-8",
      "scripts/safe_gbk_parse.ts",
      10,
      "Also trim trailing null bytes before writeFileSync",
    );
    expect(useCommandDeckStore.getState().inlineCommentDrafts["prop-8"]?.length).toBe(1);

    await store.submitInlineRevision("prop-8");
    const revised = useCommandDeckStore.getState().proposals.find((p) => p.id === "prop-8");
    expect(revised?.triggerSource).toBe("inline_revision");
    expect(revised?.inlineComments.length).toBe(1);
    expect(revised?.diffs[0]?.after).toContain("trim trailing null bytes");
    expect(useCommandDeckStore.getState().inlineCommentDrafts["prop-8"]?.length).toBe(0);

    const prevCommitCount = useCommandDeckStore.getState().commits.length;
    await store.adoptProposal("prop-8", true);
    const afterAdopt = useCommandDeckStore.getState();
    expect(afterAdopt.commits.length).toBe(prevCommitCount + 1);
    expect(afterAdopt.proposals.find((p) => p.id === "prop-8")?.status).toBe("adopted");
    expect(
      afterAdopt.trustRecords.find((r) => r.identifier === "scripts/safe_gbk_parse.ts")?.status,
    ).toBe("trusted");
  });

  it("handles F4 Genome Deck export scan, zero-trust import, revert, and replay compare", async () => {
    const store = useCommandDeckStore.getState();

    const scan = await store.scanExport();
    expect(scan.safeToExport).toBe(false);
    expect(scan.findings.length).toBe(1);
    await store.confirmExport(true);
    expect(useCommandDeckStore.getState().exportScanResult).toBeNull();

    const preview = await store.previewImport("~/Downloads/pack.harnex.zip");
    expect(preview.untrustedExecutables.length).toBe(3);
    // Trust only 1 of 3; remaining 2 must stay disabled by zero-trust default
    await store.executeImport(preview.archivePath, ["scripts/community_pdf_extract.ts"]);
    const records = useCommandDeckStore.getState().trustRecords;
    expect(
      records.find((r) => r.identifier === "scripts/community_pdf_extract.ts")?.status,
    ).toBe("trusted");
    expect(records.find((r) => r.identifier === "hooks/post_shell_lint.ts")?.status).toBe(
      "disabled",
    );

    const oldest = store.commits[store.commits.length - 1]!;
    await store.revertToCommit(oldest.sha, "Test rollback");
    expect(useCommandDeckStore.getState().commits[0]?.isRollback).toBe(true);

    await store.runReplayCompare({
      taskPrompt: "Parse GBK invoices",
      v0Sha: oldest.sha,
      vNSha: store.commits[0]!.sha,
      modelId: "gpt-4.1-mini",
    });
    const cmp = useCommandDeckStore.getState().replayComparison;
    expect(cmp?.status).toBe("completed");
    expect(cmp?.vNMetrics.errors).toBe(0);
  });

  it("handles F4 Provider CRUD, CC Switch / Magpie imports (with fallback), slots, and budget", async () => {
    const store = useCommandDeckStore.getState();

    const ccFail = await store.importFromCcSwitch(true);
    expect(ccFail.detected).toBe(false);
    expect(ccFail.fallbackToManual).toBe(true);

    const ccOk = await store.importFromCcSwitch(false);
    expect(ccOk.detected).toBe(true);
    expect(
      useCommandDeckStore.getState().providers.some((p) => p.id === "prov-cc-switch"),
    ).toBe(true);

    const magpieFail = await store.importFromMagpie("http://127.0.0.1:3425", true);
    expect(magpieFail.detected).toBe(false);
    expect(magpieFail.fallbackToManual).toBe(true);

    const magpieOk = await store.importFromMagpie("http://127.0.0.1:3425", false);
    expect(magpieOk.detected).toBe(true);

    await store.setSlotBinding("solver", {
      providerId: "prov-magpie",
      modelId: "gemini-2.5-pro",
    });
    expect(useCommandDeckStore.getState().appConfig?.slots.solver?.modelId).toBe("gemini-2.5-pro");

    await store.setRsiMode("auto");
    expect(useCommandDeckStore.getState().appConfig?.rsiMode).toBe("auto");

    await store.updateBudgetSettings({
      dailyLimitUsd: 12.5,
      pricingTable: useCommandDeckStore.getState().budgetStatus?.pricingTable ?? [],
    });
    expect(useCommandDeckStore.getState().budgetStatus?.dailyLimitUsd).toBe(12.5);
  });
});
