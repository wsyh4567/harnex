import type { HarnessTree } from "@harnex/interfaces";
import { HarnessGardenerReportSchema, type GardenerFinding, type HarnessGardenerReport } from "@harnex/protocol";
import { normalizeTree, untriggeredSkills } from "./tree.ts";

export interface GardenerOptions {
  commitSha: string;
  improverSlot?: { providerId: string; modelId: string };
  judgeSlot?: { providerId: string; modelId: string };
  /** Max characters for always-on prompt organs before flagging prompt_bloat (default: 4000 for systemprompt.md, 2500 for guardrails.md / LongTermMEMORY.md). */
  maxSystemPromptChars?: number;
  maxOrganChars?: number;
}

const DEFAULT_SYSTEM_PROMPT_CHARS = 4000;
const DEFAULT_ORGAN_CHARS = 2500;
const MEMORY_PATH = "memory/LongTermMEMORY.md";
const TOOL_DESCRIPTION = /^tool_descriptions\/[^/]+\.md$/;
const SCRIPT_PATH = /^scripts\/[^/]+\.ts$/;
const HOOK_PATH = /^hooks\/[^/]+\.ts$/;
const SKILL_PATH = /^skills\/[^/]+\/SKILL\.md$/;
const EXPERIENCE_PATH = /(?:^|\/)EXPERIENCE\.md$/;
const CUE_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?cue(?::\*\*|\*\*:|:)\s*(.+?)\s*$/i;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isAlwaysOnPath = (path: string): boolean =>
  path === "systemprompt.md" || path === "guardrails.md" || path === MEMORY_PATH || TOOL_DESCRIPTION.test(path);

const isReferenceCorpusPath = (path: string): boolean =>
  path === "systemprompt.md" || path === "guardrails.md" || TOOL_DESCRIPTION.test(path) || SKILL_PATH.test(path) || HOOK_PATH.test(path);

const isAuditedEmptyOrganPath = (path: string): boolean =>
  path.endsWith(".md") || SCRIPT_PATH.test(path) || HOOK_PATH.test(path);

function normalizeCue(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
}

function referencesScript(corpus: readonly string[], scriptPath: string): boolean {
  const basename = scriptPath.slice("scripts/".length);
  const pathPattern = new RegExp(`(?<![\\w.-])${escapeRegExp(scriptPath)}(?![\\w-])`);
  const basePattern = new RegExp(`(?<![\\w.-])${escapeRegExp(basename)}(?![\\w-])`);
  return corpus.some((text) => pathPattern.test(text) || basePattern.test(text));
}

function buildSuggestedPruningGoal(findings: readonly GardenerFinding[]): string | undefined {
  const fileFindings = findings.filter((finding) => finding.kind !== "same_model_collusion");
  if (fileFindings.length === 0) return undefined;

  const verbs: Record<GardenerFinding["suggestedAction"], string> = {
    prune: "prune/tighten",
    trigger: "wire trigger for",
    consolidate: "consolidate",
    diversify_models: "diversify",
  };
  const items = fileFindings.map((finding) => `${verbs[finding.suggestedAction]} ${finding.path}`);
  const prefix = "Tidy harness hygiene: ";
  const suffix = " while preserving regression pass rate.";
  const maxBody = 320 - prefix.length - suffix.length;

  let body = "";
  let omitted = 0;
  for (let i = 0; i < items.length; i++) {
    const candidate = body ? `${body}; ${items[i]}` : items[i]!;
    if (candidate.length > maxBody) {
      omitted = items.length - i;
      break;
    }
    body = candidate;
  }
  if (omitted > 0) {
    const more = ` (+${omitted} more)`;
    if (body && body.length + more.length <= maxBody) {
      body += more;
    } else if (!body) {
      body = `${items[0]!.slice(0, Math.max(0, maxBody - 3))}...`;
    }
  }
  return `${prefix}${body}${suffix}`.slice(0, 320);
}

/**
 * Audits a harness tree for prompt bloat, untriggered skills, orphan scripts,
 * duplicate experience cues, empty organs, and Improver/Judge model collusion.
 */
export function inspectHarnessHygiene(tree: HarnessTree, opts: GardenerOptions): HarnessGardenerReport {
  const snapshot = normalizeTree(tree);
  const paths = Object.keys(snapshot).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const maxSystemPromptChars = opts.maxSystemPromptChars ?? DEFAULT_SYSTEM_PROMPT_CHARS;
  const maxOrganChars = opts.maxOrganChars ?? DEFAULT_ORGAN_CHARS;

  let alwaysOnBytes = 0;
  for (const path of paths) {
    if (isAlwaysOnPath(path)) {
      alwaysOnBytes += Buffer.byteLength(snapshot[path]!, "utf8");
    }
  }
  const alwaysOnEstimatedTokens = Math.ceil(alwaysOnBytes / 4);
  const totalOrgans = paths.length;

  const findings: GardenerFinding[] = [];
  const add = (finding: Omit<GardenerFinding, "id">) => {
    findings.push({ id: `${finding.kind}:${finding.path}`, ...finding });
  };

  const bloatLimits: Record<string, number> = {
    "systemprompt.md": maxSystemPromptChars,
    "guardrails.md": maxOrganChars,
    [MEMORY_PATH]: maxOrganChars,
  };
  for (const path of Object.keys(bloatLimits)) {
    const content = snapshot[path];
    const limit = bloatLimits[path]!;
    if (content !== undefined && content.length > limit) {
      add({
        kind: "prompt_bloat",
        severity: "warning",
        path,
        detail: `${path} is ${content.length} chars (threshold ${limit}); prune verbose rules to reduce always-on token overhead.`,
        suggestedAction: "prune",
      });
    }
  }

  for (const { path, name } of untriggeredSkills(snapshot)) {
    add({
      kind: "untriggered_skill",
      severity: "warning",
      path,
      detail: `Skill "${name}" has no trigger reference in systemprompt.md, guardrails.md, or memory/LongTermMEMORY.md.`,
      suggestedAction: "trigger",
    });
  }

  const referenceCorpus = paths.filter(isReferenceCorpusPath).map((path) => snapshot[path]!);
  for (const path of paths) {
    if (SCRIPT_PATH.test(path) && !referencesScript(referenceCorpus, path)) {
      add({
        kind: "orphan_script",
        severity: "advisory",
        path,
        detail: `Script ${path} is not referenced by systemprompt.md, guardrails.md, tool_descriptions, skills, or hooks.`,
        suggestedAction: "prune",
      });
    }
  }

  const seenCues = new Map<string, string>();
  const duplicatePaths = new Set<string>();
  for (const path of paths) {
    if (!EXPERIENCE_PATH.test(path)) continue;
    for (const line of snapshot[path]!.split(/\r?\n/)) {
      const match = CUE_LINE.exec(line);
      if (!match) continue;
      const normalized = normalizeCue(match[1]!);
      if (normalized.length < 12) continue;
      const priorPath = seenCues.get(normalized);
      if (priorPath === undefined) {
        seenCues.set(normalized, path);
      } else if (priorPath !== path && !duplicatePaths.has(path)) {
        duplicatePaths.add(path);
        add({
          kind: "duplicate_experience",
          severity: "advisory",
          path,
          detail: `Experience cue "${normalized}" duplicates ${priorPath}; consolidate overlapping entries.`,
          suggestedAction: "consolidate",
        });
      }
    }
  }

  for (const path of paths) {
    if (isAuditedEmptyOrganPath(path) && snapshot[path]!.trim().length === 0) {
      add({
        kind: "empty_organ",
        severity: "advisory",
        path,
        detail: `${path} has no non-whitespace content; prune or populate this organ.`,
        suggestedAction: "prune",
      });
    }
  }

  const sameModelCollusion = Boolean(
    opts.improverSlot &&
    opts.judgeSlot &&
    opts.improverSlot.providerId === opts.judgeSlot.providerId &&
    opts.improverSlot.modelId === opts.judgeSlot.modelId,
  );
  const modelDiversityOk = !sameModelCollusion;
  if (sameModelCollusion) {
    add({
      kind: "same_model_collusion",
      severity: "advisory",
      path: "slots/improver+judge",
      detail: `Improver and Blind Judge both use ${opts.improverSlot!.providerId}/${opts.improverSlot!.modelId}; sharing one model family can reinforce shared blind spots.`,
      suggestedAction: "diversify_models",
    });
  }

  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const penalty = findings.reduce((sum, finding) => sum + (finding.severity === "warning" ? 12 : 5), 0);
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));
  const suggestedPruningGoal = buildSuggestedPruningGoal(findings);

  return HarnessGardenerReportSchema.parse({
    checkedAt: new Date().toISOString(),
    commitSha: opts.commitSha,
    healthScore,
    alwaysOnBytes,
    alwaysOnEstimatedTokens,
    totalOrgans,
    modelDiversityOk,
    findings,
    suggestedPruningGoal,
  });
}
