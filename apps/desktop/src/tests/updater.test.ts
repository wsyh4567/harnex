import { beforeEach, describe, expect, it } from "bun:test";
import type { HarnexIpcEvent } from "../ipc/index.ts";
import { MockIpcAdapter, TauriIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("Magpie-Style Auto-Updater IPC & Store Lifecycle", () => {
  let adapter: MockIpcAdapter;

  beforeEach(async () => {
    adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);
  });

  it("quietly checks updates on initialize and transitions available -> downloading -> ready -> installing", async () => {
    // Allow quiet startup checkForUpdates() microtask to complete
    await new Promise((r) => setTimeout(r, 15));

    const initial = useCommandDeckStore.getState().updateStatus;
    expect(initial?.phase).toBe("available");
    expect(initial?.info.currentVersion).toBe("0.1.0");
    expect(initial?.info.latestVersion).toBe("0.2.0");
    expect(initial?.info.compatLevel).toBe("safe");

    const observedPhases: string[] = [];
    const unsub = adapter.subscribe((ev: HarnexIpcEvent) => {
      if (ev.type === "update.status_changed") {
        observedPhases.push(ev.status.phase);
      }
    });

    const readyStatus = await useCommandDeckStore.getState().downloadUpdate();
    expect(readyStatus?.phase).toBe("ready");
    expect(readyStatus?.verifiedSha256).toBe(true);
    expect(readyStatus?.downloadedBytes).toBe(readyStatus?.totalBytes);
    expect(observedPhases).toContain("downloading");
    expect(observedPhases).toContain("ready");

    const installingStatus = await useCommandDeckStore.getState().installUpdate();
    expect(installingStatus?.phase).toBe("installing");
    expect(installingStatus?.backupTag).toBe("pre-update-v0.1.0-to-v0.2.0");
    expect(useCommandDeckStore.getState().updateStatus?.phase).toBe("installing");

    unsub();
  });

  it("TauriIpcAdapter invokes updater_* commands 1:1 and processes update.status_changed events", async () => {
    const calls: string[] = [];
    const listenerRef: { fn: ((ev: { payload: unknown }) => void) | null } = { fn: null };

    const sampleStatus = (phase: string, extra: Record<string, unknown> = {}) => ({
      phase,
      info: {
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        compatLevel: "auto_migrate",
        migrationNotes: "Migrates manifest schema v1 -> v2",
        sizeBytes: 1024,
      },
      downloadedBytes: phase === "ready" ? 1024 : 512,
      totalBytes: 1024,
      verifiedSha256: phase === "ready",
      ...extra,
    });

    const tauri = new TauriIpcAdapter({
      invoke: async <T>(cmd: string) => {
        calls.push(cmd);
        if (cmd === "updater_get_status") return sampleStatus("idle") as T;
        if (cmd === "updater_check") return sampleStatus("available") as T;
        if (cmd === "updater_download") return sampleStatus("ready") as T;
        if (cmd === "updater_install") {
          return sampleStatus("installing", {
            backupTag: "pre-update-v0.1.0-to-v0.2.0",
          }) as T;
        }
        return {} as T;
      },
      listen: async (_event, handler) => {
        listenerRef.fn = handler as (ev: { payload: unknown }) => void;
        return () => {
          listenerRef.fn = null;
        };
      },
    });

    const received: HarnexIpcEvent[] = [];
    const unsub = tauri.subscribe((ev) => received.push(ev));
    await Promise.resolve();

    expect((await tauri.getUpdateStatus()).phase).toBe("idle");
    expect((await tauri.checkForUpdates()).phase).toBe("available");
    expect((await tauri.downloadUpdate()).verifiedSha256).toBe(true);
    expect((await tauri.installUpdate()).backupTag).toBe("pre-update-v0.1.0-to-v0.2.0");

    expect(calls).toEqual([
      "updater_get_status",
      "updater_check",
      "updater_download",
      "updater_install",
    ]);

    listenerRef.fn?.({
      payload: {
        type: "update.status_changed",
        status: sampleStatus("downloading"),
      },
    });
    expect(received.length).toBe(1);
    expect(received[0]?.type).toBe("update.status_changed");
    if (received[0]?.type === "update.status_changed") {
      expect(received[0].status.phase).toBe("downloading");
      expect(received[0].status.info.compatLevel).toBe("auto_migrate");
    }

    unsub();
  });
});
