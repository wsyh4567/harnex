// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import type { HarnessTree, LlmClient, LlmRequest, LlmResponse } from "@harnex/interfaces";
import { HarnessPatchOpSchema, type HarnessPatchOp, type InlineDiffComment, type UntrustedSourceTag } from "@harnex/protocol";
import { z } from "zod";
import { assertNoGraderVerdicts, assertNoLeakPaths, formatStageUserMessage, type EvidenceBundle } from "./context.ts";
import { proposerStageInstructions } from "./prompts.ts";
import { applyPatchOps, autotrigger, computeFileDiffs, fileLines, lineChanges, normalizeHarnessPath, validateTree } from "./tree.ts";

const Operations = z.object({ operations: z.array(HarnessPatchOpSchema.strict()), notes: z.string().optional() }).strict();

export interface ModelControl {
  modelId?: string;
  providerIdOverride?: string;
  signal?: AbortSignal;
  beforeCall?: () => Promise<void>;
  afterCall?: (response: LlmResponse) => Promise<void>;
}

export async function completeModel(llm: LlmClient, request: LlmRequest, control: ModelControl): Promise<LlmResponse> {
  control.signal?.throwIfAborted();
  await control.beforeCall?.();
  control.signal?.throwIfAborted();
  const response = await llm.complete({ ...request, signal: control.signal });
  await control.afterCall?.(response);
  control.signal?.throwIfAborted();
  return response;
}

export function isEvolutionManagedPath(path: string): boolean {
  const folded = path.toLowerCase();
  return folded === "meta/regression_cases.jsonl" || folded === "meta/domains" || folded.startsWith("meta/domains/");
}

export function parseProposal(text: string, migration = false): { operations: HarnessPatchOp[]; notes: string; keepBase: boolean } {
  const notesMatch = /<\/notes>\s*\}?\s*$/i.test(text)
    ? Array.from(text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|<notes>([\s\S]*?)<\/notes>\s*(\}?)\s*$/gi)).find(match => match[1] !== undefined)
    : undefined;
  const legacyNotes = notesMatch?.[1]?.trim() ?? "";
  const body = text.slice(0, notesMatch?.index ?? text.length).trim()
    .replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i, "$1").trim();
  if (body === "KEEP_BASE" && !notesMatch?.[2]) return { operations: [], notes: legacyNotes, keepBase: true };
  const parsed = Operations.parse(JSON.parse(body));
  const operations = parsed.operations.map(operation => {
    const path = normalizeHarnessPath(operation.path, migration);
    if (isEvolutionManagedPath(path)) throw new Error("Regression data and experience entries are maintained by the evolution engine");
    assertNoLeakPaths([path]);
    return { ...operation, path };
  });
  const notes = [...new Set([parsed.notes?.trim(), legacyNotes].filter(Boolean))].join("\n\n");
  return { operations, notes, keepBase: operations.length === 0 };
}

function checkRevision(before: HarnessTree, after: HarnessTree, comments: readonly InlineDiffComment[]): void {
  const pending = new Set(comments);
  for (const diff of computeFileDiffs(before, after)) {
    const targets = comments.filter(comment => comment.filePath === diff.path);
    if (!targets.length) throw new Error(`Revision edited an unannotated file: ${diff.path}`);
    const lineCount = fileLines(diff.before).length;
    for (const change of lineChanges(diff.before, diff.after)) {
      const anchors = targets.map(comment => Math.min(lineCount, comment.lineNumber) - 1);
      const anchored = (line: number) => anchors.includes(line);
      if (change.oldStart === change.oldEnd) {
        if (lineCount && !anchored(change.oldStart) && !anchored(change.oldStart - 1)) {
          throw new Error(`Revision inserted outside the annotated lines in ${diff.path}`);
        }
      } else {
        for (let line = change.oldStart; line < change.oldEnd; line++) {
          if (!anchored(line)) throw new Error(`Revision changed unannotated line ${line + 1} in ${diff.path}`);
        }
      }
      targets.forEach((comment, index) => {
        const line = anchors[index]!;
        if (!lineCount || (change.oldStart === change.oldEnd ? line === change.oldStart || line === change.oldStart - 1 : line >= change.oldStart && line < change.oldEnd)) pending.delete(comment);
      });
    }
  }
  if (pending.size) throw new Error("Revision did not address every annotated line");
}

export interface ImprovementResult {
  tree: HarnessTree;
  notes: string;
  sourceTags: UntrustedSourceTag[];
  keptBase: boolean;
  fellBack: boolean;
  executionFailed: boolean;
  attempts: number;
  usd: number;
  error?: string;
}

export async function proposeHarness(llm: LlmClient, input: {
  prompt: string;
  evidence: EvidenceBundle;
  base: HarnessTree;
  label: string;
  comments?: readonly InlineDiffComment[];
  leakPaths?: readonly string[];
  migration?: { allowedPaths: ReadonlySet<string>; validate: (tree: HarnessTree) => void };
} & ModelControl): Promise<ImprovementResult> {
  const { base, evidence, comments, migration } = input;
  let attempts = 0;
  let usd = 0;
  let error = "";
  let executionFailed = false;
  while (attempts < 2) {
    attempts++;
    const stageEvidence = error ? { ...evidence, files: { ...evidence.files, "previous_validation.txt": error } } : evidence;
    let response: LlmResponse;
    try {
      const stageInstructions = proposerStageInstructions(input.prompt, migration?.allowedPaths, comments, attempts === 2 ? error : undefined,
        Object.hasOwn(evidence.files, "evolution_goal.md"));
      response = await completeModel(llm, {
        slot: "improver",
        modelId: input.modelId,
        providerIdOverride: input.providerIdOverride,
        systemPrompt: input.prompt,
        messages: [{ role: "user", content: formatStageUserMessage(stageEvidence, stageInstructions) }],
      }, input);
    } catch (cause) {
      input.signal?.throwIfAborted();
      error = cause instanceof Error ? cause.message : String(cause);
      executionFailed = true;
      break;
    }
    usd += response.usage.costUsd;
    if (response.finishReason === "error" || response.finishReason === "aborted") {
      error = `Improver did not complete (${response.finishReason})`;
      executionFailed = true;
      break;
    }
    try {
      if (response.finishReason !== "stop") throw new Error("Improver returned an incomplete structured edit");
      const { operations, notes, keepBase } = parseProposal(response.content, !!migration);
      if (migration && operations.some(op => op.op !== "upsert" || !migration.allowedPaths.has(op.path) || !op.content?.trim())) {
        throw new Error("Migration may only repair the reported files with non-empty upserts");
      }
      const changed = applyPatchOps(base, operations, !!migration);
      if (Object.keys(base).length && !Object.keys(changed).length) throw new Error("An edit cannot remove the entire harness");
      if (!keepBase && !comments && !migration) autotrigger(changed);
      if (comments) checkRevision(base, changed, comments);
      const tree = migration ? changed : validateTree(changed);
      const diffs = computeFileDiffs(base, tree, !!migration);
      assertNoLeakPaths(diffs.map(diff => diff.path), input.leakPaths);
      assertNoGraderVerdicts({ ...Object.fromEntries(diffs.map(diff => [diff.path, diff.after])), "notes.md": notes });
      migration?.validate(tree);
      return { tree, notes, sourceTags: evidence.sourceTags, keptBase: !diffs.length, fellBack: false, executionFailed, attempts, usd };
    } catch (cause) {
      // JSON/schema errors may echo bytes from invalid output. Keep them out of the next request.
      error = cause instanceof SyntaxError || cause instanceof z.ZodError ? "Invalid structured JSON" : (cause instanceof Error ? cause.message : String(cause)).slice(0, 240);
    }
  }
  return { tree: base, notes: "", sourceTags: evidence.sourceTags, keptBase: true, fellBack: true, executionFailed, attempts, usd, error };
}
