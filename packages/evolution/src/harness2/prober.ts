import { randomUUID } from "node:crypto";
import type { RustBridge, TaskRunner, TaskRunRequest, TaskRunResult } from "@harnex/interfaces";
import { assertNoLeakPaths } from "./context.ts";
import { dryRunDisposition, type ExternalEffect } from "../sandbox/dry_run.ts";
import { withShadowWorkspace, type ShadowLimits } from "../sandbox/shadow_workspace.ts";

export class EvolutionBudgetError extends Error {
  constructor(reason = "Evolution budget exhausted") { super(reason); this.name = "EvolutionBudgetError"; }
}

export async function assertEvolutionBudget(bridge: RustBridge): Promise<void> {
  const check = await bridge.checkBudget();
  if (!check.allowed || check.status.tripped) throw new EvolutionBudgetError(check.reason);
}

export interface ProbeOptions {
  touchedFiles: readonly string[];
  snapshot?: Record<string, string>;
  limits?: ShadowLimits;
  effects?: readonly ExternalEffect[];
  leakPaths?: readonly string[];
  signal?: AbortSignal;
  checkpoint?: () => Promise<void>;
}

export type ProbeResult = { run: TaskRunResult; mockedExternalEffects: boolean; degradedReason?: never } | { run?: never; degradedReason: string };

export async function probeTask(runner: TaskRunner, bridge: RustBridge, request: TaskRunRequest, options: ProbeOptions): Promise<ProbeResult> {
  const { signal } = options;
  const checkpoint = options.checkpoint ?? (() => assertEvolutionBudget(bridge));
  signal?.throwIfAborted();
  await checkpoint();
  const disposition = dryRunDisposition(options.effects);
  if (disposition.degradedReason) return { degradedReason: disposition.degradedReason };
  assertNoLeakPaths(options.snapshot ? Object.keys(options.snapshot) : options.touchedFiles, options.leakPaths);
  return withShadowWorkspace({ ...options, workspacePath: request.workspacePath }, async workspacePath => {
    await checkpoint();
    signal?.throwIfAborted();
    const threadId = `${request.threadId}:shadow:${randomUUID()}`;
    let abort: Promise<void> | undefined;
    const cancel = () => { abort ??= runner.abort(threadId); void abort.catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const started = Date.now();
      let run: TaskRunResult;
      try { run = await runner.runTask({ ...request, threadId, workspacePath, dryRunShadow: true }); }
      catch (error) {
        if (error instanceof EvolutionBudgetError) throw error;
        run = { runId: threadId, succeeded: false, delivered: false, finalOutput: "", trajectoryMarkdown: "The rollout runner failed before returning evidence.",
          deliverables: {}, touchedFiles: [], metrics: { steps: 0, errors: 1, durationMs: Date.now() - started, tokens: 0, costUsd: 0 },
          hadHumanSteer: false, steerInstructions: [], sourceTags: ["local"], error: error instanceof Error ? error.name : "Runner error" };
      }
      await checkpoint();
      signal?.throwIfAborted();
      return { run, mockedExternalEffects: disposition.useMock };
    } finally {
      signal?.removeEventListener("abort", cancel);
      await abort;
    }
  });
}
