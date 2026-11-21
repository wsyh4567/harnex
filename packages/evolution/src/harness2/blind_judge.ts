// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import { createHash } from "node:crypto";
import type { LlmClient, RegressionCase, TaskRunResult } from "@harnex/interfaces";
import type { BlindJudgeResult, RegressionCheckSummary } from "@harnex/protocol";
import { z } from "zod";
import { assertNoGraderVerdicts, assertNoLeakPaths, buildSelectorEvidence, formatStageUserMessage, type EvidenceInput, type EvidenceRollout } from "./context.ts";
import { selectPrompt } from "./prompts.ts";
import { completeModel, type ModelControl } from "./proposer.ts";
import { normalizePaths } from "./tree.ts";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

function anonId(index: number): string {
  let id = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) id = String.fromCharCode(65 + (n - 1) % 26) + id;
  return id;
}

export function assignIds(labels: readonly string[], seed: string): Record<string, string> {
  const sorted = [...new Set(labels)].sort();
  if (sorted.length !== labels.length) throw new Error("Duplicate blind candidate labels");
  const key = sha1(seed).slice(0, 12);
  for (let i = sorted.length - 1; i > 0; i--) {
    const j = Number.parseInt(sha1(`${key}:${i}`).slice(0, 12), 16) % (i + 1);
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  return Object.fromEntries(sorted.map((label, i) => [anonId(i), label]));
}

export function hasDeliverable(run: TaskRunResult): boolean {
  return run.succeeded && run.delivered && (Boolean(run.finalOutput.trim()) || Object.values(run.deliverables).some(body => body.trim()));
}

interface Vote { id: string; why: string; modelId: string; confidence: BlindJudgeResult["confidence"] }

export async function blindJudge(llm: LlmClient, input: EvidenceInput & ModelControl & {
  seed: string;
  base: EvidenceRollout;
  candidate: EvidenceRollout;
  judgeModelId?: string;
  reverseJudgeModelId?: string;
}): Promise<BlindJudgeResult> {
  const { base, candidate, seed } = input;
  const byLabel = new Map([[base.label, base], [candidate.label, candidate]]);
  const idMap = assignIds([base.label, candidate.label], seed);
  const ids = Object.keys(idMap);
  const optionA = ids[0]!;
  const optionB = ids[1]!;
  const idOf = (label: string) => ids.find(id => idMap[id] === label)!;
  const usableBase = hasDeliverable(base.run);
  const usableCandidate = hasDeliverable(candidate.run);
  const vote = async (order: string[], modelId?: string): Promise<Vote> => {
    const evidence = buildSelectorEvidence(input, order.map(id => ({ label: id, run: byLabel.get(idMap[id]!)!.run })));
    const systemPrompt = selectPrompt(order);
    const response = await completeModel(llm, {
      slot: "judge", modelId, systemPrompt, messages: [{ role: "user", content: formatStageUserMessage(evidence, systemPrompt) }],
    }, input);
    const choices = [...response.content.matchAll(/```choice\s+([A-Z]+)\s*```/g)];
    const chosen = choices.length === 1 && response.finishReason === "stop" ? choices[0]?.[1] ?? "" : "";
    const why = /<why>([\s\S]*?)<\/why>/i.exec(response.content)?.[1]?.trim().slice(0, 2_000) ?? "";
    const rating = /\bconfidence\s*:\s*(low|medium|high)\b/i.exec(why)?.[1]?.toLowerCase();
    assertNoGraderVerdicts({ "selection.md": why });
    return { id: order.includes(chosen) ? chosen : "", why, modelId: response.modelId, confidence: rating === "high" || rating === "medium" || rating === "low" ? rating : "medium" };
  };

  let forward: Vote;
  let reverse: Vote;
  if (usableBase && usableCandidate) {
    forward = await vote(ids, input.judgeModelId);
    reverse = await vote([...ids].reverse(), input.reverseJudgeModelId ?? input.judgeModelId);
  } else {
    const id = usableCandidate && !usableBase ? idOf(candidate.label) : idOf(base.label);
    const why = usableCandidate || usableBase ? "Only one option delivered a usable result." : "Neither option delivered a usable result.";
    forward = reverse = { id, why, modelId: "", confidence: "low" };
  }
  const orderConsistent = Boolean(forward.id && forward.id === reverse.id);
  const winnerAnonId = orderConsistent ? forward.id : idOf(base.label);
  const winnerLabel = idMap[winnerAnonId]!;
  const confidence = !orderConsistent || !forward.why || !reverse.why || forward.confidence === "low" || reverse.confidence === "low" ? "low"
    : forward.confidence === "high" && reverse.confidence === "high" ? "high" : "medium";
  const reasoning = orderConsistent ? [...new Set([forward.why, reverse.why])].join("\n") : "The two orders did not agree on a valid choice; retain the incumbent.";
  return { seed, optionALabel: idMap[optionA]!, optionBLabel: idMap[optionB]!, winnerAnonId, winnerLabel,
    winnerIsCandidate: winnerLabel === candidate.label, forwardWinnerAnonId: forward.id, reverseWinnerAnonId: reverse.id,
    orderConsistent, confidence, reasoning, judgeModelId: [...new Set([forward.modelId, reverse.modelId])].filter(Boolean).join(" / ") };
}

export const REGRESSION_CASE_PATH = "meta/regression_cases.jsonl";
export const REGRESSION_LIMITS = { perCaseBytes: 64 * 1024, totalBytes: 512 * 1024, spotChecks: 3 } as const;
const Case = z.object({ id: z.string().min(1), domain: z.string().min(1), prompt: z.string().min(1),
  expectedSignal: z.string().trim().min(1), sourceFilesSnapshot: z.record(z.string()), sizeBytes: z.number().int().nonnegative(), createdAt: z.string() }).strict();

export function readRegressionCases(jsonl: string, leakPaths?: readonly string[]): RegressionCase[] {
  if (Buffer.byteLength(jsonl) > REGRESSION_LIMITS.totalBytes) throw new Error("Regression cases exceed total byte cap");
  const ids = new Set<string>();
  return jsonl.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const bytes = Buffer.byteLength(line);
    if (bytes > REGRESSION_LIMITS.perCaseBytes) throw new Error("Regression case exceeds per-case byte cap");
    const item = Case.parse(JSON.parse(line));
    if (item.sizeBytes > REGRESSION_LIMITS.perCaseBytes) throw new Error("Regression case exceeds per-case byte cap");
    if (ids.has(item.id)) throw new Error("Duplicate regression case ID");
    ids.add(item.id);
    const paths = normalizePaths(Object.keys(item.sourceFilesSnapshot));
    assertNoLeakPaths(paths, leakPaths);
    assertNoGraderVerdicts({ ...item.sourceFilesSnapshot, "request.md": item.prompt });
    return { ...item, sizeBytes: bytes };
  });
}

export async function spotCheckRegressions(jsonl: string, domain: string, probe: (input: Pick<RegressionCase, "prompt" | "sourceFilesSnapshot">) => Promise<TaskRunResult>, leakPaths?: readonly string[]): Promise<RegressionCheckSummary> {
  const cases = readRegressionCases(jsonl, leakPaths).filter(item => item.domain === domain).slice(-REGRESSION_LIMITS.spotChecks);
  if (!cases.length) return { total: 0, passed: 0, failed: 0, skippedReason: "No regression cases for this domain" };
  let passed = 0;
  for (const { prompt, sourceFilesSnapshot, expectedSignal } of cases) {
    const run = await probe({ prompt, sourceFilesSnapshot });
    if (hasDeliverable(run) && [run.finalOutput, ...Object.values(run.deliverables)].some(body => body.includes(expectedSignal))) passed++;
  }
  return { total: cases.length, passed, failed: cases.length - passed };
}
