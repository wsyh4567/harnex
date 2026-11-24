// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { HarnessCompatibilityReportSchema, type HarnessCompatibilityReport } from "@harnex/protocol";
import type { HarnessStore, HarnessTree, LlmClient, RustBridge, TaskRunner, TaskRunRequest, TaskRunResult, TraceRunRecord, TraceStore } from "@harnex/interfaces";
import {
  EvolutionProposalSchema, EvolutionReviseParamsSchema, EvolutionTriggerParamsSchema, InlineDiffCommentSchema, RunMetricsSchema,
  type BlindJudgeResult, type EvolutionProposal, type EvolutionReviseParams, type EvolutionStage, type EvolutionTriggerParams,
  type GitCommitPatchResult, type InlineDiffComment, type RegressionCheckSummary, type Thread, type UntrustedSourceTag,
} from "@harnex/protocol";
import { dryRunDisposition, observedExternalEffects, type ExternalEffect } from "../sandbox/dry_run.ts";
import type { ShadowLimits } from "../sandbox/shadow_workspace.ts";
import { assignIds, blindJudge, hasDeliverable, REGRESSION_CASE_PATH, spotCheckRegressions } from "./blind_judge.ts";
import { inspectHarnessCompatibility, parseJsonObject, toolRenamesFromIssues } from "./compatibility.ts";
import { assertNoGraderVerdicts, assertNoLeakPaths, buildProposerEvidence, buildReflectorEvidence, type EvidenceCandidate, type EvidenceInput, type EvidenceRollout } from "./context.ts";
import { experiencePatchOps, readDomainLibrary } from "./library.ts";
import type { ModeToken } from "./ledger.ts";
import { assertEvolutionBudget, probeTask } from "./prober.ts";
import { inlineRevisionPrompt, migrationPrompt } from "./prompts.ts";
import { isEvolutionManagedPath, proposeHarness, type ModelControl } from "./proposer.ts";
import { runParallel, runSequential, type ModeResult } from "./recursion.ts";
import { reflectAdoption } from "./reflector.ts";
import { applyPatchOps, computeFileDiffs, editableTree, fileLines, normalizeHarnessPath, treeToPatchOps, validateTree } from "./tree.ts";

const now = () => new Date().toISOString();
const combineTags = (...lists: readonly UntrustedSourceTag[][]): UntrustedSourceTag[] => [...new Set(lists.flat())];
const MIGRATION_DOMAIN = "upgrade_migration";
const emptyMetrics = { steps: 0, errors: 0, durationMs: 0, tokens: 0, costUsd: 0 };

function assertManifestPreserved(base: HarnessTree, next: HarnessTree): void {
  if (base["manifest.json"] === next["manifest.json"]) return;
  const after = parseJsonObject(next["manifest.json"]);
  if (!after) throw new Error("Migrated manifest must be a JSON object");
  const before = parseJsonObject(base["manifest.json"]);
  const metadata = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "schemaVersion"));
  if (before && !isDeepStrictEqual(metadata(before), metadata(after))) throw new Error("Migration must preserve manifest fields other than schemaVersion");
}

export function modeToken(mode: string): ModeToken {
  if (mode === "agg" || mode === "parallel") return "agg";
  if (mode === "seq" || mode === "sequential") return "seq";
  throw new Error(`Unknown evolution mode: ${mode}`);
}

export function streamOrder(tasksByDomain: Readonly<Record<string, readonly string[]>>, seed?: string | number, referenceOrder?: readonly string[]): [string, string][] {
  const domains = Object.keys(tasksByDomain).sort();
  const sortedDomains = seed !== undefined ? Object.values(assignIds(domains, `${seed}:__domains__`)) : (referenceOrder ?? domains).filter(domain => Object.hasOwn(tasksByDomain, domain));
  if (sortedDomains.length !== domains.length || new Set(sortedDomains).size !== domains.length) throw new Error("Reference order must cover each domain exactly once");
  return sortedDomains.flatMap(domain => {
    const tasks = tasksByDomain[domain]!;
    return (seed === undefined ? [...tasks].sort() : Object.values(assignIds(tasks, `${seed}:${domain}`))).map((task): [string, string] => [domain, task]);
  });
}

export interface EvolutionDependencies { llm: LlmClient; runner: TaskRunner; bridge: RustBridge; harnessStore: HarnessStore; traceStore: TraceStore }
export interface EvolutionOptions {
  sourceFilesSnapshot?: Record<string, string>;
  leakPaths?: readonly string[];
  effects?: readonly ExternalEffect[];
  limits?: ShadowLimits;
  judgeModelId?: string;
  reverseJudgeModelId?: string;
}
export interface EvolutionRun { proposal: EvolutionProposal; recursion?: ModeResult }

class JobScope {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  constructor(private readonly bridge: RustBridge, private readonly proposalId: string) {}

  checkpoint = async (): Promise<void> => {
    this.signal.throwIfAborted();
    try { await assertEvolutionBudget(this.bridge); }
    catch (error) { this.controller.abort(error); }
    this.signal.throwIfAborted();
  };

  get model(): ModelControl {
    return { signal: this.signal, beforeCall: this.checkpoint, afterCall: async response => {
      try { await this.bridge.recordUsage(response.modelId, response.usage); }
      catch (error) { this.controller.abort(error); }
      await this.checkpoint();
    } };
  }

  async stage<T>(stage: EvolutionStage, label: string, action: () => T | Promise<T>): Promise<T> {
    await this.checkpoint();
    this.bridge.emitEvent({ type: "evolution.step.started", proposalId: this.proposalId, stage, label, timestamp: now() });
    const result = await action();
    await this.checkpoint();
    const metrics = result && typeof result === "object" && "metrics" in result ? RunMetricsSchema.safeParse(result.metrics) : undefined;
    if (metrics?.success) {
      this.bridge.emitEvent({ type: "evolution.step.progress", proposalId: this.proposalId, stage, message: label,
        metricsSnapshot: metrics.data, timestamp: now() });
    }
    this.bridge.emitEvent({ type: "evolution.step.completed", proposalId: this.proposalId, stage, summary: label, timestamp: now() });
    return result;
  }

  fail(error: unknown): void {
    this.controller.abort(error);
    this.bridge.emitEvent({ type: "evolution.step.completed", proposalId: this.proposalId, stage: "failed",
      summary: error instanceof Error ? error.message.slice(0, 240) : "Evolution failed", timestamp: now() });
  }
}

interface Job {
  original: TraceRunRecord;
  thread: Thread;
  options: EvolutionOptions;
  snapshot: HarnessTree;
  tree: HarnessTree;
  evidence: EvidenceInput;
}

const solverTree = (tree: HarnessTree): HarnessTree => Object.fromEntries(Object.entries(tree).filter(([path]) => !isEvolutionManagedPath(path)));
const traceAsRun = (trace: TraceRunRecord): TaskRunResult => ({ ...trace, delivered: trace.succeeded && Boolean(trace.finalOutput.trim()), deliverables: {} });
const orderTrace = (runs: TraceRunRecord[]) => [...runs].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const originalEvidence = (trace: TraceRunRecord) => ({ trajectory: trace.trajectoryMarkdown, steering: trace.steerInstructions });

export class EvolutionScheduler {
  private readonly active = new Set<string>();
  constructor(private readonly deps: EvolutionDependencies, private readonly defaults: EvolutionOptions = {}) {}

  private async job(threadId: string, domain: string, options: EvolutionOptions, before?: string, baseCommitSha?: string): Promise<Job> {
    const { traceStore, harnessStore } = this.deps;
    const thread = await traceStore.getThread(threadId);
    if (!thread) throw new Error(`Unknown evolution thread: ${threadId}`);
    const runs = orderTrace(await traceStore.listTraceRunsByThread(threadId));
    const runIndex = runs.findIndex(run => !before || run.createdAt <= before);
    const original = runs[runIndex];
    if (!original) throw new Error(`No task trace for thread ${threadId}`);
    const nextRunAt = runs[runIndex - 1]?.createdAt;
    const tools = (await traceStore.listMessages(threadId)).filter(message => message.createdAt >= original.createdAt && (!nextRunAt || message.createdAt < nextRunAt)).flatMap(message => message.toolCalls ?? []);
    const readInputs = tools.flatMap(tool => tool.name === "read_file" && tool.status === "completed" && typeof tool.args.path === "string" ? [tool.args.path] : []);
    const snapshot = await harnessStore.readTreeAt(baseCommitSha ?? original.pinnedCommitSha);
    const tree = validateTree(solverTree(editableTree(snapshot)));
    const evidence: EvidenceInput = { prompt: original.prompt, source: options.sourceFilesSnapshot, leakPaths: options.leakPaths,
      sourceTags: combineTags(thread.sourceTags, original.sourceTags, options.sourceFilesSnapshot ? ["external_file"] : []) };
    assertNoLeakPaths(Object.keys(evidence.source ?? {}), options.leakPaths);
    const sourceFiles = Object.fromEntries(Object.entries(evidence.source ?? {}).map(([path, text]) => [`source/${path}`, text]));
    assertNoGraderVerdicts({ ...sourceFiles, "request.md": original.prompt });
    return { original: { ...original, domain, touchedFiles: [...new Set([...original.touchedFiles, ...readInputs])] }, thread,
      options: { ...options, effects: options.effects ?? observedExternalEffects(tools.filter(tool => tool.status === "completed").map(tool => tool.name)) }, snapshot, tree, evidence };
  }

  private async probe(scope: JobScope, job: Job, label: string, tree: HarnessTree, caseInput?: { prompt: string; sourceFilesSnapshot: Record<string, string> }): Promise<TaskRunResult> {
    const { original, thread, options, snapshot } = job;
    const override = solverTree(applyPatchOps(snapshot, treeToPatchOps(job.tree, tree)));
    const request: TaskRunRequest = { threadId: thread.id, workspacePath: thread.workspacePath, prompt: caseInput?.prompt ?? original.prompt,
      mode: thread.mode, domain: original.domain, pinnedCommitSha: original.pinnedCommitSha, overrideHarnessTree: override };
    const run = async () => {
      const result = await probeTask(this.deps.runner, this.deps.bridge, request, { touchedFiles: original.touchedFiles,
        snapshot: caseInput?.sourceFilesSnapshot ?? options.sourceFilesSnapshot, limits: options.limits,
        effects: caseInput ? undefined : options.effects, leakPaths: options.leakPaths, signal: scope.signal, checkpoint: scope.checkpoint });
      if (!result.run) throw new Error(result.degradedReason);
      return result.run;
    };
    return caseInput ? run() : scope.stage("shadow_probing", label, run);
  }

  private async compare(scope: JobScope, job: Job, seed: string, base: EvidenceRollout, candidate: EvidenceRollout): Promise<BlindJudgeResult> {
    return blindJudge(this.deps.llm, { ...job.evidence, ...scope.model, seed, base, candidate,
      judgeModelId: job.options.judgeModelId, reverseJudgeModelId: job.options.reverseJudgeModelId });
  }

  private async regressions(scope: JobScope, job: Job, tree: HarnessTree): Promise<RegressionCheckSummary> {
    return scope.stage("regression_checking", "regression", () => spotCheckRegressions(job.snapshot[REGRESSION_CASE_PATH] ?? "", job.original.domain,
      item => this.probe(scope, job, "regression", tree, item), job.options.leakPaths));
  }

  private async finish(proposal: EvolutionProposal): Promise<EvolutionProposal> {
    const next = EvolutionProposalSchema.parse({ ...proposal, updatedAt: now() });
    await this.deps.traceStore.saveProposal(next);
    if (next.status === "ready") this.deps.bridge.emitEvent({ type: "evolution.proposal_ready", proposal: next });
    return next;
  }

  async run(params: EvolutionTriggerParams, options: EvolutionOptions = {}): Promise<EvolutionRun> {
    const input = EvolutionTriggerParamsSchema.parse(params);
    if (input.triggerSource === "upgrade_migration") throw new Error("Upgrade migration requires a compatibility report");
    if (input.goal !== undefined) assertNoGraderVerdicts({ "evolution_goal.md": input.goal });
    const id = randomUUID();
    const scope = new JobScope(this.deps.bridge, id);
    const model = { ...scope.model, modelId: input.improverModelOverride, providerIdOverride: input.improverProviderIdOverride };
    let initial: EvolutionProposal | undefined;
    try {
      const job = await scope.stage("queued", "evolution", () => this.job(input.threadId, input.domain, { ...this.defaults, ...options }));
      const { original, tree, evidence } = job;
      evidence.goal = input.goal;
      initial = { ...input, id, title: job.thread.title, status: "running", requiresHumanTrust: false,
        baseCommitSha: original.pinnedCommitSha, sourceTags: [...evidence.sourceTags ?? []], metricsBefore: original.metrics,
        metricsAfter: original.metrics, diffs: [], inlineComments: [], createdAt: now(), updatedAt: now() };
      await this.deps.traceStore.saveProposal(initial);

      const dryRun = dryRunDisposition(job.options.effects);
      if (dryRun.degradedReason) {
        const view = buildReflectorEvidence({ ...evidence, harness: tree, baseHarness: tree,
          rollouts: [{ label: "original", run: traceAsRun(original) }], winner: "original", reason: dryRun.degradedReason });
        const entry = await scope.stage("reflecting", "reflection-only", () => reflectAdoption(this.deps.llm, input.domain, view, model, true));
        await scope.stage("completed", "evolution", () => undefined);
        return { proposal: await this.finish({ ...initial, status: entry ? "ready" : "archived_no_entry",
          degradedReason: dryRun.degradedReason, experienceEntry: entry }) };
      }

      const mode = modeToken(input.mode);
      const recurse = mode === "agg" ? runParallel : runSequential;
      const library = readDomainLibrary(job.snapshot, input.domain);
      const recursion = await recurse({ taskId: original.runId, k: input.k, baseTree: tree, checkpoint: scope.checkpoint,
        rollout: (label, candidate) => this.probe(scope, job, label, candidate),
        propose: stage => scope.stage(stage.dim === "INV" ? "proposing_inv" : stage.dim === "DOM" ? "proposing_dom" : "composing", stage.label,
          () => proposeHarness(this.deps.llm, { ...model, prompt: stage.prompt, label: stage.label, base: stage.base,
            evidence: buildProposerEvidence({ ...evidence, harness: stage.base, rollouts: stage.reference, pool: stage.pool, library, original: originalEvidence(original) }), leakPaths: evidence.leakPaths })),
      });
      const rollouts = Object.entries(recursion.rollouts).map(([label, run]) => ({ label, run }));
      const pool: EvidenceCandidate[] = recursion.stages.map(stage => ({ label: stage.label, tree: stage.tree,
        run: recursion.rollouts[stage.label]!, notes: stage.notes || stage.error }));
      const references = rollouts.filter(rollout => rollout.label.startsWith("base"));
      const base = references.find(rollout => hasDeliverable(rollout.run)) ?? references[0]!;
      const finalists = recursion.finals.map(label => ({ label, run: recursion.rollouts[label]! })).filter(rollout => hasDeliverable(rollout.run));
      const seed = `${original.runId}|${input.k}|${mode}`;
      const judge = await scope.stage("blind_judging", "selection", async () => {
        let finalist = finalists[0];
        for (const contender of finalists.slice(1)) {
          const verdict = await this.compare(scope, job, `${seed}|finals`, finalist!, contender);
          if (verdict.winnerIsCandidate) finalist = contender;
        }
        if (!finalist) return undefined;
        return this.compare(scope, job, seed, base, finalist);
      });
      const winner = judge?.winnerIsCandidate ? judge.winnerLabel : base.label;
      const winningTree = recursion.trees[winner] ?? tree;
      const diffs = computeFileDiffs(tree, winningTree);
      const regressionCheck = judge?.winnerIsCandidate && diffs.length ? await this.regressions(scope, job, winningTree) : undefined;
      const entry = judge?.winnerIsCandidate && !regressionCheck?.failed
        ? await scope.stage("reflecting", winner, () => reflectAdoption(this.deps.llm, input.domain, buildReflectorEvidence({ ...evidence,
          harness: winningTree, baseHarness: tree, rollouts: references, pool, library, winner, reason: judge.reasoning, original: originalEvidence(original) }), model,
          dryRun.useMock || judge.confidence === "low")) : undefined;
      const proposal: EvolutionProposal = { ...initial, status: regressionCheck?.failed ? "rejected" : entry ? "ready" : "archived_no_entry",
        blindJudge: dryRun.useMock && judge ? { ...judge, confidence: "low" } : judge, regressionCheck, experienceEntry: entry,
        diffs, requiresHumanTrust: diffs.some(diff => diff.isHighPrivilege), metricsBefore: base.run.metrics,
        metricsAfter: recursion.rollouts[winner]!.metrics, sourceTags: combineTags(initial.sourceTags, ...rollouts.map(rollout => rollout.run.sourceTags)),
      };
      await scope.stage("completed", "evolution", () => undefined);
      return { proposal: await this.finish(proposal), recursion };
    } catch (error) {
      scope.fail(error);
      if (initial) await this.finish({ ...initial, status: "rejected" });
      throw error;
    }
  }

  async triggerMigration(params: { report: HarnessCompatibilityReport; threadId?: string; workspacePath?: string }): Promise<EvolutionProposal> {
    const report = HarnessCompatibilityReportSchema.parse(params.report);
    const { harnessStore, llm, traceStore, bridge } = this.deps;
    const id = randomUUID();
    const scope = new JobScope(bridge, id);
    try {
      const { base, current, opts } = await scope.stage("queued", MIGRATION_DOMAIN, async () => {
        if (await harnessStore.getHeadSha() !== report.commitSha) throw new Error("The compatibility report belongs to an older harness snapshot");
        const snapshot = await harnessStore.readTreeAt(report.commitSha);
        const opts = { commitSha: report.commitSha, appVersion: report.appVersion, expectedSchemaVersion: report.expectedSchemaVersion,
          deprecatedToolRenames: toolRenamesFromIssues(report.issues) };
        return { base: solverTree(editableTree(snapshot, true)), current: inspectHarnessCompatibility(snapshot, opts), opts };
      });
      if (!current.needsMigration) throw new Error("The current harness has no compatibility issues to migrate");
      const allowedPaths = new Set(current.issues.map(issue => issue.path));
      if (current.issues.some(issue => issue.kind === "untriggered_skill")) allowedPaths.add("systemprompt.md");
      const issueKey = ({ path, kind, message }: HarnessCompatibilityReport["issues"][number]) => JSON.stringify([path, kind, message]);
      const baselineIssues = new Set(current.issues.map(issueKey));
      const evidence = buildProposerEvidence({ harness: base, rollouts: [], leakPaths: this.defaults.leakPaths,
        prompt: JSON.stringify({ appVersion: current.appVersion, expectedSchemaVersion: current.expectedSchemaVersion,
          issues: current.issues, migrationGuideSummary: current.migrationGuideSummary }) });
      const output = await scope.stage("composing", MIGRATION_DOMAIN, () => proposeHarness(llm, { ...scope.model,
        prompt: migrationPrompt([...allowedPaths].sort()), evidence, base, label: MIGRATION_DOMAIN, leakPaths: this.defaults.leakPaths,
        migration: { allowedPaths, validate: candidate => {
          assertManifestPreserved(base, candidate);
          const check = inspectHarnessCompatibility(candidate, opts);
          if (check.hasBreakingIssues) {
            const unresolved = check.issues.filter(issue => issue.severity === "breaking").map(issue => `${issue.path}: ${issue.kind}`);
            throw new Error(`Unresolved compatibility issues: ${unresolved.join(", ")}`);
          }
          if (check.issues.some(issue => !baselineIssues.has(issueKey(issue))) || check.issues.length >= current.issues.length) {
            throw new Error("Migration must resolve a reported issue without introducing new ones");
          }
        } },
      }));
      const diffs = computeFileDiffs(base, output.tree, true);
      const thread = params.workspacePath && !params.threadId
        ? (await traceStore.listThreads()).find(thread => thread.workspacePath === params.workspacePath) : undefined;
      const proposal: EvolutionProposal = { id, threadId: params.threadId ?? thread?.id ?? MIGRATION_DOMAIN,
        title: "Harness compatibility migration", domain: MIGRATION_DOMAIN, triggerSource: "upgrade_migration", mode: "sequential", k: 1,
        baseCommitSha: report.commitSha, sourceTags: output.sourceTags, requiresHumanTrust: diffs.some(diff => diff.isHighPrivilege),
        status: output.fellBack ? "rejected" : "ready", degradedReason: output.fellBack ? output.error : undefined,
        metricsBefore: emptyMetrics, metricsAfter: emptyMetrics, diffs, inlineComments: [], createdAt: now(), updatedAt: now() };
      if (output.fellBack) scope.fail(new Error(output.error ?? "No compatible migration was proposed"));
      else await scope.stage("completed", MIGRATION_DOMAIN, () => undefined);
      return await this.finish(proposal);
    } catch (error) { scope.fail(error); throw error; }
  }

  private async withProposal<T>(id: string, action: (proposal: EvolutionProposal) => Promise<T>): Promise<T> {
    if (this.active.has(id)) throw new Error(`Proposal ${id} already has an active action`);
    this.active.add(id);
    try {
      const proposal = await this.deps.traceStore.getProposal(id);
      if (!proposal) throw new Error(`Unknown proposal: ${id}`);
      return await action(EvolutionProposalSchema.parse(proposal));
    } finally { this.active.delete(id); }
  }

  async reviseWithInlineComments(proposalId: string, rawComments: EvolutionReviseParams["comments"] | InlineDiffComment[], options: EvolutionOptions = {}): Promise<EvolutionProposal> {
    const parsed = EvolutionReviseParamsSchema.parse({ proposalId, comments: rawComments });
    return this.withProposal(proposalId, async proposal => {
      if (proposal.status !== "ready" && proposal.status !== "needs_reprobe") throw new Error(`Cannot revise proposal in state ${proposal.status}`);
      const comments = parsed.comments.map((raw, i) => {
        const filePath = normalizeHarnessPath(raw.filePath);
        const diff = proposal.diffs.find(item => item.path === filePath);
        if (!diff || raw.lineNumber > fileLines(diff.changeType === "deleted" ? diff.before : diff.after).length || !raw.comment.trim()) {
          throw new Error(`Review comment is outside proposal diff: ${filePath}:${raw.lineNumber}`);
        }
        return InlineDiffCommentSchema.parse({ id: randomUUID(), author: "user", createdAt: now(), ...rawComments[i], ...raw, filePath });
      });
      const scope = new JobScope(this.deps.bridge, proposalId);
      try {
        const job = await scope.stage("queued", "inline revision", () => this.job(proposal.threadId, proposal.domain, { ...this.defaults, ...options }, proposal.createdAt, proposal.baseCommitSha));
        job.original.pinnedCommitSha = proposal.baseCommitSha;
        const previous = this.treeForProposal(job.tree, proposal);
        for (const comment of comments) assertNoGraderVerdicts({ "comment.md": comment.comment });
        const output = await scope.stage("composing", "inline revision", () => proposeHarness(this.deps.llm, { ...scope.model,
          prompt: inlineRevisionPrompt(comments), label: "revision", base: previous, comments, leakPaths: job.evidence.leakPaths,
          evidence: buildProposerEvidence({ ...job.evidence, harness: previous, rollouts: [{ label: "original", run: traceAsRun(job.original) }], original: originalEvidence(job.original) }),
        }));
        if (output.fellBack) throw new Error(`Inline revision did not produce an acceptable change: ${output.error}`);
        if (proposal.status === "needs_reprobe") await this.rebaseRevision(job, output.tree);
        const changed = output.tree;
        const diffs = computeFileDiffs(job.tree, changed);
        const base = { label: "base", run: await this.probe(scope, job, "base", job.tree) };
        const candidate = { label: "revision", run: await this.probe(scope, job, "revision", changed) };
        const judge = await scope.stage("blind_judging", "inline revision", () => this.compare(scope, job, `${proposal.id}|revision`, base, candidate));
        const regressionCheck = await this.regressions(scope, job, changed);
        const experienceEntry = await scope.stage("reflecting", "inline revision", () => reflectAdoption(this.deps.llm, proposal.domain,
          buildReflectorEvidence({ ...job.evidence, harness: changed, baseHarness: job.tree, rollouts: [base],
            pool: [{ ...candidate, tree: changed, notes: output.notes }], winner: judge.winnerLabel, reason: judge.reasoning }), scope.model,
          !judge.winnerIsCandidate || judge.confidence === "low" || dryRunDisposition(job.options.effects).useMock));
        await scope.stage("completed", "inline revision", () => undefined);
        return await this.finish({ ...proposal, triggerSource: "inline_revision", status: regressionCheck.failed || !hasDeliverable(candidate.run) ? "needs_reprobe" : "ready",
          baseCommitSha: job.original.pinnedCommitSha, diffs, blindJudge: dryRunDisposition(job.options.effects).useMock ? { ...judge, confidence: "low" } : judge,
          regressionCheck, experienceEntry, metricsBefore: base.run.metrics, metricsAfter: candidate.run.metrics,
          requiresHumanTrust: diffs.some(diff => diff.isHighPrivilege), inlineComments: [...proposal.inlineComments, ...comments],
          sourceTags: combineTags(proposal.sourceTags, output.sourceTags, base.run.sourceTags, candidate.run.sourceTags) });
      } catch (error) { scope.fail(error); throw error; }
    });
  }

  private async rebaseRevision(job: Job, changed: HarnessTree): Promise<void> {
    const head = await this.deps.harnessStore.getHeadSha();
    if (head === job.original.pinnedCommitSha) return;
    const nextSnapshot = await this.deps.harnessStore.readTreeAt(head);
    const nextBase = validateTree(solverTree(editableTree(nextSnapshot)));
    const ops = treeToPatchOps(job.tree, changed);
    for (const op of ops) {
      if (nextBase[op.path] !== job.tree[op.path] && nextBase[op.path] !== changed[op.path]) {
        throw new Error(`Re-probe requires resolving overlapping harness edit at ${op.path}`);
      }
    }
    const next = validateTree(applyPatchOps(nextBase, ops));
    for (const path of Object.keys(changed)) delete changed[path];
    Object.assign(changed, next);
    job.tree = nextBase;
    job.snapshot = nextSnapshot;
    job.original.pinnedCommitSha = head;
  }

  private treeForProposal(base: HarnessTree, proposal: EvolutionProposal, migration = false): HarnessTree {
    const tree = applyPatchOps(base, proposal.diffs.map(diff => {
      const path = normalizeHarnessPath(diff.path, migration);
      if (isEvolutionManagedPath(path)) throw new Error(`Proposal cannot edit engine metadata: ${path}`);
      if (migration && (diff.changeType === "deleted" || !diff.after.trim())) throw new Error("Migration cannot remove user assets");
      if ((base[path] ?? "") !== diff.before || Object.hasOwn(base, path) !== (diff.changeType !== "added")) throw new Error(`Proposal does not match pinned file: ${path}`);
      return diff.changeType === "deleted" ? { path, op: "delete" } : { path, op: "upsert", content: diff.after };
    }), migration);
    if (migration) { assertManifestPreserved(base, tree); return tree; }
    return validateTree(tree);
  }

  async acceptProposal(proposalId: string, trustHighPrivilegeAssets = false): Promise<GitCommitPatchResult> {
    return this.withProposal(proposalId, async proposal => {
      if (proposal.status !== "ready" || proposal.regressionCheck?.failed) throw new Error(`Proposal cannot be adopted in state ${proposal.status}`);
      const store = this.deps.harnessStore;
      const snapshot = await store.readTreeAt(proposal.baseCommitSha);
      const migration = proposal.triggerSource === "upgrade_migration" && proposal.domain === MIGRATION_DOMAIN;
      if (migration && await store.getHeadSha() !== proposal.baseCommitSha) {
        await this.finish({ ...proposal, status: "needs_reprobe" });
        return { ok: false, conflict: true, conflictingFiles: [], error: "Harness changed after the migration proposal was created" };
      }
      const editable = solverTree(editableTree(snapshot, migration));
      const base = migration ? editable : validateTree(editable);
      const next = this.treeForProposal(base, proposal, migration);
      const diffs = computeFileDiffs(base, next, migration);
      if (diffs.some(diff => diff.isHighPrivilege) && !trustHighPrivilegeAssets) throw new Error("High-privilege edits require explicit human trust");
      assertNoLeakPaths(diffs.map(diff => diff.path));
      assertNoGraderVerdicts(Object.fromEntries(diffs.map(diff => [diff.path, diff.after])));
      if (proposal.experienceEntry && proposal.experienceEntry.domain !== proposal.domain) throw new Error("Experience domain does not match proposal");
      const operations = [...treeToPatchOps(base, next, migration), ...experiencePatchOps(snapshot, proposal.id, proposal.experienceEntry)];
      if (!operations.length) throw new Error("Proposal has no changes to adopt");
      const result = await store.commitPatch(proposal.baseCommitSha, operations, `Adopt evolution: ${proposal.title}`, proposal.domain);
      if (result.conflict) await this.finish({ ...proposal, status: "needs_reprobe" });
      else if (result.ok) await this.finish({ ...proposal, status: "adopted" });
      return result;
    });
  }
}
