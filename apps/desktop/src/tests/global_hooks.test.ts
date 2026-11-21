import { beforeEach, describe, expect, it } from "bun:test";
import {
  filterThreadChatApprovals,
  selectGlobalHookAlerts,
} from "../hooks/globalHookSelectors.ts";
import { enUSMessages } from "../i18n/locales/en-US.ts";
import { zhCNMessages } from "../i18n/locales/zh-CN.ts";
import { MockIpcAdapter } from "../ipc/mockAdapter.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("Codex-style Global Hooks UX, GlobalHookTrustBar & Manager CRUD", () => {
  beforeEach(async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("excludes hook_trust approvals from chat thread feed while surfacing them globally across all threads", () => {
    const state = useCommandDeckStore.getState();

    // Thread 1 (thr-billing-csv) has both apr-l0-export (sandbox_escape) and apr-hook-sha (hook_trust).
    const chatApprovals = filterThreadChatApprovals(state.pendingApprovals, "thr-billing-csv");
    expect(chatApprovals.map((a) => a.requestId)).toEqual(["apr-l0-export"]);
    expect(chatApprovals.some((a) => a.kind === "hook_trust")).toBe(false);

    // Switching to another thread still surfaces the global hook alert in GlobalHookTrustBar!
    const globalAlerts = selectGlobalHookAlerts(
      state.globalHooks,
      state.pendingApprovals,
      state.dismissedHookShaByPath,
    );
    expect(globalAlerts.map((a) => a.path)).toEqual(["hooks/csv_utf8_guard.ts"]);
    expect(globalAlerts[0]?.previousSha256).toBeTruthy();

    // Mock adapter pre-populates both initial global hooks.
    expect(state.globalHooks.map((h) => h.path)).toEqual([
      "hooks/csv_utf8_guard.ts",
      "hooks/example_trim_output.ts",
    ]);
  });

  it("trusts global hook from GlobalHookTrustBar, resolves pending hook_trust globally, and supports dismiss", async () => {
    const store = useCommandDeckStore.getState();

    // Dismissing hides current SHA alert until hash changes.
    store.dismissGlobalHookNotice(
      "hooks/csv_utf8_guard.ts",
      "9d4f28b0c71e6a234f8e1092a3b4c5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a",
    );
    expect(
      selectGlobalHookAlerts(
        useCommandDeckStore.getState().globalHooks,
        useCommandDeckStore.getState().pendingApprovals,
        useCommandDeckStore.getState().dismissedHookShaByPath,
      ),
    ).toHaveLength(0);

    // Editing content changes SHA-256 and clears dismissal so untrusted alert re-surfaces.
    await store.saveHook({
      path: "hooks/csv_utf8_guard.ts",
      event: "PostToolUse",
      content: "// modified\nexport default function guard() { return { ok: true }; }",
      trustImmediately: false,
    });
    const afterEdit = useCommandDeckStore.getState();
    expect(
      selectGlobalHookAlerts(
        afterEdit.globalHooks,
        afterEdit.pendingApprovals,
        afterEdit.dismissedHookShaByPath,
      ).map((a) => a.path),
    ).toEqual(["hooks/csv_utf8_guard.ts"]);

    // Trusting globally promotes hook -> trusted, updates TrustRecord, and resolves apr-hook-sha.
    await store.trustGlobalHook("hooks/csv_utf8_guard.ts");
    const afterTrust = useCommandDeckStore.getState();
    const trustedHook = afterTrust.globalHooks.find((h) => h.path === "hooks/csv_utf8_guard.ts");
    expect(trustedHook?.status).toBe("trusted");
    expect(afterTrust.pendingApprovals.some((a) => a.kind === "hook_trust")).toBe(false);
    expect(
      afterTrust.trustRecords.find((r) => r.identifier === "hooks/csv_utf8_guard.ts")?.status,
    ).toBe("trusted");
  });

  it("supports full Global Hooks CRUD (create, edit, enable/disable toggle, delete) in Zustand store", async () => {
    const store = useCommandDeckStore.getState();

    // Create new hook
    const created = await store.saveHook({
      path: "hooks/pre_shell_audit.ts",
      event: "PreToolUse",
      content: "export default function audit() { return { ok: true }; }",
      trustImmediately: true,
    });
    expect(created.name).toBe("pre_shell_audit");
    expect(created.event).toBe("PreToolUse");
    expect(created.status).toBe("trusted");
    expect(
      useCommandDeckStore.getState().globalHooks.some((h) => h.path === "hooks/pre_shell_audit.ts"),
    ).toBe(true);

    // Toggle Trusted -> Disabled -> Trusted
    await store.toggleGlobalHookStatus(created);
    let current = useCommandDeckStore
      .getState()
      .globalHooks.find((h) => h.path === "hooks/pre_shell_audit.ts");
    expect(current?.status).toBe("disabled");

    await store.toggleGlobalHookStatus(current!);
    current = useCommandDeckStore
      .getState()
      .globalHooks.find((h) => h.path === "hooks/pre_shell_audit.ts");
    expect(current?.status).toBe("trusted");

    // Delete hook
    await store.deleteHook("hooks/pre_shell_audit.ts");
    expect(
      useCommandDeckStore.getState().globalHooks.some((h) => h.path === "hooks/pre_shell_audit.ts"),
    ).toBe(false);
  });

  it("maintains 100% i18n key parity between en-US and zh-CN after adding Global Hooks keys", () => {
    const enKeys = Object.keys(enUSMessages).sort();
    const zhKeys = Object.keys(zhCNMessages).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
