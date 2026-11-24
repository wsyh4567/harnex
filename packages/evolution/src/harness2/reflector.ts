// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import type { LlmClient } from "@harnex/interfaces";
import { ExperienceEntrySchema, type ExperienceEntry } from "@harnex/protocol";
import { assertNoGraderVerdicts, formatStageUserMessage, type EvidenceBundle } from "./context.ts";
import { experiencePrompt } from "./prompts.ts";
import { completeModel, type ModelControl } from "./proposer.ts";

export function hasExperience(entry: ExperienceEntry | undefined | null): entry is ExperienceEntry {
  return Boolean(entry && [entry.cue, entry.lesson, entry.evidence].every(field => typeof field === "string" && field.trim() && field.trim() !== "NO_ENTRY"));
}

export function distilExperience(domain: string, reply: string): ExperienceEntry | undefined {
  if (/^\s*NO_ENTRY\s*$/mi.test(reply)) return undefined;
  const block = /<experience>([\s\S]*?)<\/experience>/i.exec(reply)?.[1];
  if (!block) return undefined;
  const fields: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^\s*(cue|lesson|evidence|confidence)\s*:\s*(.*?)\s*$/i.exec(line);
    if (match) {
      const key = match[1]!.toLowerCase();
      if (Object.hasOwn(fields, key)) return undefined;
      fields[key] = match[2]!;
    }
  }
  const result = ExperienceEntrySchema.safeParse({ ...fields, domain, confidence: fields.confidence || "low", editsSummary: /<edits>([\s\S]*?)<\/edits>/i.exec(reply)?.[1]?.trim() });
  if (!result.success || !hasExperience(result.data)) return undefined;
  assertNoGraderVerdicts({ "EXPERIENCE.md": JSON.stringify(result.data) });
  return result.data;
}

export async function reflectAdoption(llm: LlmClient, domain: string, evidence: EvidenceBundle, control: ModelControl = {}, lowConfidence = false): Promise<ExperienceEntry | undefined> {
  const systemPrompt = experiencePrompt();
  const response = await completeModel(llm, {
    slot: "improver", modelId: control.modelId, providerIdOverride: control.providerIdOverride,
    systemPrompt, messages: [{ role: "user", content: formatStageUserMessage(evidence, systemPrompt) }],
  }, control);
  if (response.finishReason !== "stop") return undefined;
  const entry = distilExperience(domain, response.content);
  return entry && lowConfidence ? { ...entry, confidence: "low" } : entry;
}
