import { useMemo } from "react";
import type { EvolutionProposal, GenomeCommit } from "@harnex/protocol";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Archive, GitBranch, Sparkles } from "lucide-react";
import {
  localizeCommitMessage,
  localizeComponentTag,
  localizeDomainLabel,
  localizeProposal,
} from "../../i18n/demoContent.ts";
import { useI18n } from "../../i18n/index.ts";
import { cn, shortSha } from "../../lib/utils.ts";

export interface CommitTreeNodeData extends Record<string, unknown> {
  kind: "commit";
  sha: string;
  versionTag: string;
  isHead: boolean;
  isSelected: boolean;
  isRollback: boolean;
  passPct: number | null;
  summary: string;
  organs: string[];
  activeLabel: string;
  rollbackLabel: string;
}

export interface ProposalTreeNodeData extends Record<string, unknown> {
  kind: "proposal";
  proposalId: string;
  title: string;
  domainLabel: string;
  stepsBefore: number;
  stepsAfter: number;
  errorsAfter: number;
  badgeLabel: string;
  stepsUnit: string;
  errorsUnit: string;
}

export interface PrunedTreeNodeData extends Record<string, unknown> {
  kind: "pruned";
  label: string;
  sublabel: string;
}

export type EvolutionTreeNode = Node<
  CommitTreeNodeData | ProposalTreeNodeData | PrunedTreeNodeData
>;

export function buildEvolutionTreeGraph(params: {
  commits: GenomeCommit[];
  proposals: EvolutionProposal[];
  silentArchiveCount: number;
  selectedCommitSha: string | null;
  locale: string;
}): { nodes: EvolutionTreeNode[]; edges: Edge[] } {
  const { commits, proposals, silentArchiveCount, selectedCommitSha, locale } = params;
  const isZh = locale.startsWith("zh");

  // Chronological oldest -> newest for left-to-right trunk
  const trunk = [...commits].reverse();
  const nodes: EvolutionTreeNode[] = [];
  const edges: Edge[] = [];

  const activeLabel = isZh ? "当前生效" : "Active";
  const rollbackLabel = isZh ? "已回滚" : "Rollback";
  const candidateBadge = isZh ? "候选提案" : "Candidate";
  const stepsUnit = isZh ? "步" : "steps";
  const errorsUnit = isZh ? "报错" : "errors";

  trunk.forEach((c, idx) => {
    const isHead = idx === trunk.length - 1;
    const nodeId = `commit-${c.sha}`;
    nodes.push({
      id: nodeId,
      type: "commitNode",
      position: { x: idx * 270, y: 110 },
      data: {
        kind: "commit",
        sha: c.sha,
        versionTag: c.versionTag,
        isHead,
        isSelected: c.sha === selectedCommitSha,
        isRollback: c.isRollback,
        passPct: c.passRate !== undefined ? Math.round(c.passRate * 100) : null,
        summary: localizeCommitMessage(c, locale),
        organs: c.changedComponents.map((comp) => localizeComponentTag(comp, locale)),
        activeLabel,
        rollbackLabel,
      },
    });

    if (idx > 0) {
      const prev = trunk[idx - 1]!;
      edges.push({
        id: `e-trunk-${prev.sha}-${c.sha}`,
        source: `commit-${prev.sha}`,
        target: nodeId,
        type: "smoothstep",
        style: {
          stroke: isHead ? "#0891b2" : "#64748b",
          strokeWidth: isHead ? 2.4 : 1.8,
        },
      });
    }
  });

  const headCommit = trunk[trunk.length - 1];
  const readyProposals = proposals.filter(
    (p) => p.status === "ready" || p.status === "needs_reprobe",
  );

  if (headCommit) {
    const startY = readyProposals.length > 1 ? 20 : 110;
    readyProposals.forEach((p, idx) => {
      const loc = localizeProposal(p, locale);
      const nodeId = `proposal-${p.id}`;
      nodes.push({
        id: nodeId,
        type: "proposalNode",
        position: { x: trunk.length * 270, y: startY + idx * 145 },
        data: {
          kind: "proposal",
          proposalId: p.id,
          title: loc.title,
          domainLabel: localizeDomainLabel(p.domain, locale),
          stepsBefore: p.metricsBefore.steps,
          stepsAfter: p.metricsAfter.steps,
          errorsAfter: p.metricsAfter.errors,
          badgeLabel: candidateBadge,
          stepsUnit,
          errorsUnit,
        },
      });

      edges.push({
        id: `e-cand-${headCommit.sha}-${p.id}`,
        source: `commit-${headCommit.sha}`,
        target: nodeId,
        type: "smoothstep",
        animated: true,
        style: {
          stroke: "#06b6d4",
          strokeWidth: 2,
          strokeDasharray: "6 4",
        },
      });
    });
  }

  if (silentArchiveCount > 0 && trunk.length >= 2) {
    const branchAnchorIdx = Math.max(0, trunk.length - 2);
    const anchorCommit = trunk[branchAnchorIdx]!;
    const prunedId = "pruned-no-entry";
    nodes.push({
      id: prunedId,
      type: "prunedNode",
      position: { x: (branchAnchorIdx + 1) * 270, y: 270 },
      data: {
        kind: "pruned",
        label: isZh
          ? `已剪枝 · 无收益探索 ×${silentArchiveCount}`
          : `Pruned · No-Gain ×${silentArchiveCount}`,
        sublabel: isZh
          ? "未通过影子沙盒或双盲检验，已静默归档"
          : "Filtered by Shadow Sandbox / Blind Judge",
      },
    });
    edges.push({
      id: `e-pruned-${anchorCommit.sha}`,
      source: `commit-${anchorCommit.sha}`,
      target: prunedId,
      type: "smoothstep",
      style: {
        stroke: "#94a3b8",
        strokeWidth: 1.4,
        strokeDasharray: "4 4",
        opacity: 0.65,
      },
    });
  }

  return { nodes, edges };
}

function CommitNodeCard({ data }: NodeProps<Node<CommitTreeNodeData>>) {
  return (
    <div
      className={cn(
        "w-[228px] rounded-2xl border bg-[var(--hx-surface)] p-3 text-left transition-all",
        data.isHead
          ? "border-cyan-500/70 ring-2 ring-cyan-500/20 shadow-md"
          : data.isSelected
            ? "border-[var(--hx-accent-border)] shadow-sm"
            : "border-[var(--hx-border)] hover:border-[var(--hx-border-strong)]",
      )}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-1 !h-1" />

      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1.5">
          <span className="rounded-md bg-[var(--hx-accent-soft)] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[var(--hx-accent)]">
            {data.versionTag}
          </span>
          <code className="font-mono text-[10px] text-[var(--hx-text-3)]">
            {shortSha(data.sha, 6)}
          </code>
        </div>

        {data.passPct !== null && (
          <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            {data.passPct}%
          </span>
        )}
      </div>

      {data.isHead && (
        <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span>{data.activeLabel}</span>
        </div>
      )}

      {data.isRollback && (
        <div className="mt-1.5 inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
          {data.rollbackLabel}
        </div>
      )}

      <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-snug text-[var(--hx-text)]">
        {data.summary}
      </p>

      {data.organs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {data.organs.slice(0, 3).map((org) => (
            <span
              key={org}
              className="rounded-md border border-[var(--hx-border)] bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[9px] text-[var(--hx-text-2)]"
            >
              +{org}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalNodeCard({ data }: NodeProps<Node<ProposalTreeNodeData>>) {
  return (
    <div className="w-[238px] cursor-pointer rounded-2xl border border-dashed border-cyan-500/60 bg-[var(--hx-surface)] p-3 text-left shadow-sm transition-colors hover:border-cyan-500">
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-1 !h-1" />
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-1 !h-1" />

      <div className="flex items-center justify-between gap-1.5">
        <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/12 px-2 py-0.5 text-[10px] font-semibold text-cyan-700 dark:text-cyan-300">
          <Sparkles className="h-2.5 w-2.5" />
          <span>{data.badgeLabel}</span>
        </span>
        <span className="rounded-md bg-[var(--hx-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--hx-text-2)]">
          {data.domainLabel}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[11px] font-semibold leading-snug text-[var(--hx-text)]">
        {data.title}
      </p>

      <div className="mt-2 flex items-center gap-2 font-mono text-[10px]">
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
          {data.stepsBefore}→{data.stepsAfter} {data.stepsUnit}
        </span>
        <span className="text-[var(--hx-text-3)]">
          {data.errorsAfter} {data.errorsUnit}
        </span>
      </div>
    </div>
  );
}

function PrunedNodeCard({ data }: NodeProps<Node<PrunedTreeNodeData>>) {
  return (
    <div className="w-[218px] rounded-2xl border border-dashed border-[var(--hx-border-strong)] bg-[var(--hx-subtle)]/75 p-2.5 text-left opacity-70">
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-1 !h-1" />
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--hx-text-2)]">
        <Archive className="h-3.5 w-3.5 shrink-0 text-[var(--hx-text-3)]" />
        <span className="truncate">{data.label}</span>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-[var(--hx-text-3)]">{data.sublabel}</p>
    </div>
  );
}

const NODE_TYPES = {
  commitNode: CommitNodeCard,
  proposalNode: ProposalNodeCard,
  prunedNode: PrunedNodeCard,
};

interface GenomeEvolutionTreeProps {
  commits: GenomeCommit[];
  proposals: EvolutionProposal[];
  silentArchiveCount: number;
  selectedCommitSha: string | null;
  onSelectCommit: (sha: string) => void;
  onSelectProposal: (proposalId: string) => void;
}

export function GenomeEvolutionTree({
  commits,
  proposals,
  silentArchiveCount,
  selectedCommitSha,
  onSelectCommit,
  onSelectProposal,
}: GenomeEvolutionTreeProps) {
  const { locale, t } = useI18n();

  const { nodes, edges } = useMemo(
    () =>
      buildEvolutionTreeGraph({
        commits,
        proposals,
        silentArchiveCount,
        selectedCommitSha,
        locale,
      }),
    [commits, proposals, silentArchiveCount, selectedCommitSha, locale],
  );

  return (
    <div
      data-testid="genome-evolution-tree"
      className="relative flex h-[340px] w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)]"
    >
      {/* Top Legend Bar */}
      <div className="z-10 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--hx-border)] bg-[var(--hx-subtle)]/70 px-3.5 py-2 text-[11px]">
        <div className="flex items-center gap-1.5 font-semibold text-[var(--hx-text)]">
          <GitBranch className="h-3.5 w-3.5 text-[var(--hx-accent)]" />
          <span>{t("deck.treeView")}</span>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--hx-text-2)]">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-500" />
            {t("deck.legendTrunk")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {t("deck.legendActive")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full border border-dashed border-cyan-500 bg-cyan-500/30" />
            {t("deck.legendCandidate")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-slate-400/50" />
            {t("deck.legendPruned")}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 w-full min-w-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => {
            if (node.data.kind === "commit") {
              onSelectCommit(node.data.sha);
            } else if (node.data.kind === "proposal") {
              onSelectProposal(node.data.proposalId);
            }
          }}
        >
          <Background gap={18} size={1} color="var(--hx-border)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  );
}
