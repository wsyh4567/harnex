// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import type { HarnessTree, TaskRunResult } from "@harnex/interfaces";
import type { EvidenceCandidate, EvidenceRollout } from "./context.ts";
import { Ledger, type ModeToken } from "./ledger.ts";
import { aggregatePrompt, composeRoundPrompt, proposePrompt } from "./prompts.ts";
import type { ImprovementResult } from "./proposer.ts";
import { diversity } from "./tree.ts";

export type Dimension = "INV" | "DOM" | "AGG" | "COMPOSE";
export interface StageInput {
  label: string;
  dim: Dimension;
  prompt: string;
  base: HarnessTree;
  reference: readonly EvidenceRollout[];
  pool: readonly EvidenceCandidate[];
}
export interface ImprovementStage extends ImprovementResult { label: string; dim: Dimension }
export interface RecursionInput {
  taskId: string;
  k: number;
  baseTree: HarnessTree;
  propose(input: StageInput): Promise<ImprovementResult>;
  rollout(label: string, tree: HarnessTree): Promise<TaskRunResult>;
  checkpoint?: () => Promise<void>;
}
export interface ModeResult {
  mode: ModeToken;
  taskId: string;
  k: number;
  stages: ImprovementStage[];
  trees: Record<string, HarnessTree>;
  rollouts: Record<string, TaskRunResult>;
  finals: string[];
  ledger: Ledger;
  similarity?: ReturnType<typeof diversity>;
}

// Drain active work before propagating a rejection so that shadow cleanup has finished.
async function phase<A, B>(items: readonly A[], run: (item: A) => Promise<B>): Promise<B[]> {
  const values: B[] = [];
  const width = 2;
  for (let i = 0; i < items.length; i += width) {
    const batch = await Promise.allSettled(items.slice(i, i + width).map(item => run(item)));
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      values.push(result.value);
    }
  }
  return values;
}

async function recurse(mode: ModeToken, input: RecursionInput): Promise<ModeResult> {
  const { k, taskId, baseTree } = input;
  const ledger = new Ledger(mode, taskId, k);
  const rounds = Array.from({ length: k }, (_, i) => i + 1);
  const result: ModeResult = { mode, taskId, k, ledger, stages: [], trees: {}, rollouts: {}, finals: [] };
  const roll = async (label: string, tree: HarnessTree) => {
    await input.checkpoint?.();
    return { label, run: await input.rollout(label, tree) };
  };
  const recordRollouts = (rollouts: EvidenceRollout[]) => {
    for (const { label, run } of rollouts) {
      result.rollouts[label] = run;
      ledger.rollout(label, run.metrics.costUsd);
    }
  };
  const reference = await phase(rounds, round => roll(`base${round}`, baseTree));
  recordRollouts(reference);

  const propose = async (specs: { label: string; dim: Dimension; prompt: string }[], base: HarnessTree, pool: readonly EvidenceCandidate[]) => {
    const stages = await phase(specs, async spec => {
      await input.checkpoint?.();
      const output = await input.propose({ ...spec, base, reference, pool });
      return { ...output, label: spec.label, dim: spec.dim };
    });
    for (const stage of stages) {
      result.stages.push(stage);
      result.trees[stage.label] = stage.tree;
      ledger.session(stage.label, stage.usd, stage.attempts);
    }
    const runs = await phase(stages, stage => roll(stage.label, stage.tree));
    recordRollouts(runs);
    return stages.map((stage, i): EvidenceCandidate => ({ ...runs[i]!, tree: stage.tree, notes: stage.notes || stage.error }));
  };
  const tracks = (round: number) => (["INV", "DOM"] as const).map(dim => ({
    label: `${dim.toLowerCase()}${round}`, dim, prompt: proposePrompt(dim, { k, index: round, round: mode === "seq" && k > 1 ? round : undefined }),
  }));

  if (mode === "agg") {
    const pool = await propose(rounds.flatMap(tracks), baseTree, []);
    const finals = await propose(rounds.map(round => ({ label: `agg${round}`, dim: "AGG", prompt: aggregatePrompt(k, round) })), baseTree, pool);
    result.finals = finals.map(final => final.label);
    result.similarity = diversity(Object.fromEntries(finals.map(final => [final.label, final.tree])));
  } else {
    let current = baseTree;
    const pool: EvidenceCandidate[] = [];
    for (const round of rounds) {
      pool.push(...await propose(tracks(round), current, pool));
      const [checkpoint] = await propose([{ label: `c${round}`, dim: "COMPOSE", prompt: k === 1 ? aggregatePrompt() : composeRoundPrompt(round, k) }], current, pool);
      current = checkpoint!.tree;
      pool.push(checkpoint!);
      result.finals.push(checkpoint!.label);
    }
  }
  ledger.assertIdentity();
  return result;
}

export const runParallel = (input: RecursionInput): Promise<ModeResult> => recurse("agg", input);
export const runSequential = (input: RecursionInput): Promise<ModeResult> => recurse("seq", input);
