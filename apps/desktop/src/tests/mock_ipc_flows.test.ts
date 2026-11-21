import { describe, expect, it } from "bun:test";
import type { HarnexIpcEvent } from "../ipc/index.ts";
import { MockIpcAdapter } from "../ipc/index.ts";
import { useCommandDeckStore } from "../stores/useCommandDeckStore.ts";

describe("MockIpcAdapter Streaming, Pause/Steer & Onboarding Flows", () => {
  it("streams runner Pause -> Steer -> Resume and marks thread for Harness² evolution", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    const events: HarnexIpcEvent[] = [];
    const unsub = adapter.subscribe((ev) => events.push(ev));

    const thread = await adapter.createThread({
      workspacePath: "~/Work",
      title: "Steer Flow Thread",
      mode: "craft",
    });

    await adapter.pauseRun({ threadId: thread.id });
    await adapter.steerRun({
      threadId: thread.id,
      instruction: "Use gb18030 decoder before parsing CSV rows",
      triggerEvolutionOnFinish: true,
    });
    await adapter.resumeRun({ threadId: thread.id });

    // Allow microtasks from zero-delay simulation to flush
    await new Promise((r) => setTimeout(r, 20));

    const threads = await adapter.listThreads();
    const updated = threads.find((t) => t.id === thread.id);
    expect(updated?.hadHumanSteer).toBe(true);
    expect(updated?.status).toBe("completed");

    const completedEv = events.find((e) => e.type === "runner.completed");
    expect(completedEv?.type).toBe("runner.completed");
    if (completedEv?.type === "runner.completed") {
      expect(completedEv.queuedForEvolution).toBe(true);
    }
    unsub();
  });

  it("triggers L0 sandbox approval when prompt requests writing outside workspace", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    const events: HarnexIpcEvent[] = [];
    const unsub = adapter.subscribe((ev) => events.push(ev));

    const thread = await adapter.createThread({
      workspacePath: "~/Work",
      title: "Outside Write Test",
      mode: "craft",
    });

    await adapter.startRun({
      threadId: thread.id,
      prompt: "Write report outside workspace to ~/Desktop/harnex_export.csv",
    });

    await new Promise((r) => setTimeout(r, 20));

    const approvalEv = events.find((e) => e.type === "security.approval_required");
    expect(approvalEv?.type).toBe("security.approval_required");
    unsub();
  });

  it("streams Evolution Theater stages and Blind Judge A/B proposal", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);

    await useCommandDeckStore.getState().triggerEvolution({
      domain: "csv_ops",
      mode: "parallel",
      k: 2,
    });

    const state = useCommandDeckStore.getState();
    expect(state.theaterLogs.length).toBeGreaterThanOrEqual(8);
    expect(state.proposals[0]?.domain).toBe("csv_ops");
    expect(state.proposals[0]?.blindJudge?.orderConsistent).toBe(true);
  });

  it("launches F0 Onboarding live challenge into a pinned thread", async () => {
    const adapter = new MockIpcAdapter({ simulationDelayMs: 0 });
    await useCommandDeckStore.getState().initialize(adapter);

    const replay = await adapter.getOnboardingReplay();
    expect(replay.steps.length).toBe(8);
    expect(replay.v1Metrics.errors).toBe(0);

    await useCommandDeckStore.getState().launchLiveChallenge({
      dataset: "dataset_a",
      solverModelId: "gpt-4.1-mini",
    });

    await new Promise((r) => setTimeout(r, 20));
    const state = useCommandDeckStore.getState();
    expect(state.threads[0]?.title).toContain("dataset_a");
    expect(state.rightTab).toBe("theater");
  });
});
