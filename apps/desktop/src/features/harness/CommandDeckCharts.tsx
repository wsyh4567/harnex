import { useMemo } from "react";
import type {
  EvolutionProposal,
  GenomeCommit,
  GenomeFile,
  TrustRecord,
} from "@harnex/protocol";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useI18n } from "../../i18n/index.ts";

export interface TrendPoint {
  version: string;
  passRate: number;
}

export interface RadarPoint {
  pillar: string;
  baseline: number;
  current: number;
}

export interface ProposalBarPoint {
  name: string;
  beforeSteps: number;
  afterSteps: number;
  beforeErrors: number;
  afterErrors: number;
}

export function buildDeckChartData(params: {
  commits: GenomeCommit[];
  proposals: EvolutionProposal[];
  genomeFiles: GenomeFile[];
  trustRecords: TrustRecord[];
  locale: string;
}): {
  trend: TrendPoint[];
  radar: RadarPoint[];
  proposalBars: ProposalBarPoint[];
  headTag: string;
} {
  const { commits, proposals, genomeFiles, trustRecords, locale } = params;
  const isZh = locale.startsWith("zh");

  const chronological = [...commits].reverse();
  const trend: TrendPoint[] = chronological.map((c) => ({
    version: c.versionTag,
    passRate: Math.round((c.passRate ?? 0.5) * 100),
  }));

  const readyProposals = proposals.filter((p) => p.status === "ready");
  if (readyProposals.length > 0 && trend.length > 0) {
    const lastRate = trend[trend.length - 1]!.passRate;
    trend.push({
      version: isZh ? "v8* (候选)" : "v8* (cand)",
      passRate: Math.min(99, lastRate + 4),
    });
  }

  const countByComp = (comp: string) => genomeFiles.filter((f) => f.component === comp).length;
  const trustedCount = trustRecords.filter((r) => r.status === "trusted").length;

  const radar: RadarPoint[] = [
    {
      pillar: isZh ? "记忆" : "Memory",
      baseline: 18,
      current: Math.min(96, 54 + countByComp("memory") * 18 + commits.length * 3),
    },
    {
      pillar: isZh ? "技能" : "Skills",
      baseline: 14,
      current: Math.min(96, 52 + countByComp("skills") * 18 + proposals.length * 4),
    },
    {
      pillar: isZh ? "工具MCP" : "MCP",
      baseline: 16,
      current: Math.min(95, 50 + countByComp("mcp") * 16 + trustedCount * 6),
    },
    {
      pillar: isZh ? "钩子" : "Hooks",
      baseline: 12,
      current: Math.min(95, 56 + countByComp("hooks") * 16 + trustedCount * 5),
    },
    {
      pillar: isZh ? "多代理" : "Agents",
      baseline: 10,
      current: Math.min(92, 48 + countByComp("sub_agents") * 18),
    },
    {
      pillar: isZh ? "安全沙盒" : "Sandbox",
      baseline: 48,
      current: Math.min(98, 76 + countByComp("sandbox_policies") * 14),
    },
  ];

  const proposalBars: ProposalBarPoint[] = proposals
    .filter((p) => p.status !== "rejected" && p.status !== "archived_no_entry")
    .slice(0, 4)
    .map((p, idx) => ({
      name: `#${p.id.replace("prop-", "") || idx + 1}`,
      beforeSteps: p.metricsBefore.steps,
      afterSteps: p.metricsAfter.steps,
      beforeErrors: p.metricsBefore.errors,
      afterErrors: p.metricsAfter.errors,
    }));

  const headTag = commits[0]?.versionTag ?? "v7";
  return { trend, radar, proposalBars, headTag };
}

const TOOLTIP_STYLE = {
  backgroundColor: "var(--hx-surface)",
  borderColor: "var(--hx-border-strong)",
  borderRadius: "12px",
  fontSize: "11px",
  color: "var(--hx-text)",
  boxShadow: "var(--hx-shadow-popover)",
};

export function GenerationAreaMiniChart({
  commits,
  proposals,
}: {
  commits: GenomeCommit[];
  proposals: EvolutionProposal[];
}) {
  const { locale, t } = useI18n();
  const data = useMemo(
    () =>
      buildDeckChartData({
        commits,
        proposals,
        genomeFiles: [],
        trustRecords: [],
        locale,
      }),
    [commits, proposals, locale],
  );

  return (
    <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-[var(--hx-text)]">
            {t("deck.chartTrendTitle")}
          </h3>
          <p className="text-[11px] text-[var(--hx-text-3)]">{t("deck.chartTrendSub")}</p>
        </div>
      </div>

      <div className="h-[170px] w-full min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={data.trend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="hxMiniTrendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#0891b2" stopOpacity={0.32} />
                <stop offset="95%" stopColor="#0891b2" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--hx-border)" vertical={false} />
            <XAxis
              dataKey="version"
              tick={{ fill: "var(--hx-text-3)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fill: "var(--hx-text-3)", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              unit="%"
            />
            <Tooltip contentStyle={TOOLTIP_STYLE} />
            <Area
              type="monotone"
              dataKey="passRate"
              name={t("deck.passRateLabel")}
              stroke="#0891b2"
              strokeWidth={2}
              fill="url(#hxMiniTrendGrad)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function CommandDeckCharts({
  commits,
  proposals,
  genomeFiles,
  trustRecords,
}: {
  commits: GenomeCommit[];
  proposals: EvolutionProposal[];
  genomeFiles: GenomeFile[];
  trustRecords: TrustRecord[];
}) {
  const { locale, t } = useI18n();

  const { trend, radar, proposalBars, headTag } = useMemo(
    () =>
      buildDeckChartData({
        commits,
        proposals,
        genomeFiles,
        trustRecords,
        locale,
      }),
    [commits, proposals, genomeFiles, trustRecords, locale],
  );

  return (
    <div
      data-testid="command-deck-charts"
      className="grid grid-cols-1 gap-3.5 lg:grid-cols-3"
    >
      {/* 1. AreaChart: Generation Pass-Rate Trend */}
      <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5">
        <div className="mb-2">
          <div className="text-xs font-semibold text-[var(--hx-text)]">
            {t("deck.chartTrendTitle")}
          </div>
          <div className="text-[11px] text-[var(--hx-text-3)]">{t("deck.chartTrendSub")}</div>
        </div>
        <div className="h-[190px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={trend} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
              <defs>
                <linearGradient id="hxDeckTrendGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0891b2" stopOpacity={0.34} />
                  <stop offset="95%" stopColor="#0891b2" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--hx-border)" vertical={false} />
              <XAxis
                dataKey="version"
                tick={{ fill: "var(--hx-text-3)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fill: "var(--hx-text-3)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                unit="%"
              />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Area
                type="monotone"
                dataKey="passRate"
                name={t("deck.passRateLabel")}
                stroke="#0891b2"
                strokeWidth={2}
                fill="url(#hxDeckTrendGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 2. RadarChart: 6 Capability Pillars */}
      <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5">
        <div className="mb-2">
          <div className="text-xs font-semibold text-[var(--hx-text)]">
            {t("deck.chartRadarTitle")}
          </div>
          <div className="text-[11px] text-[var(--hx-text-3)]">{t("deck.chartRadarSub")}</div>
        </div>
        <div className="h-[190px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <RadarChart data={radar} outerRadius="68%">
              <PolarGrid stroke="var(--hx-border)" />
              <PolarAngleAxis
                dataKey="pillar"
                tick={{ fill: "var(--hx-text-2)", fontSize: 10 }}
              />
              <PolarRadiusAxis
                domain={[0, 100]}
                tick={false}
                axisLine={false}
              />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Radar
                name={t("deck.radarBaseline")}
                dataKey="baseline"
                stroke="#94a3b8"
                fill="#94a3b8"
                fillOpacity={0.18}
              />
              <Radar
                name={t("deck.radarCurrent", { tag: headTag })}
                dataKey="current"
                stroke="#0891b2"
                fill="#0891b2"
                fillOpacity={0.28}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 3. BarChart: Proposal Uplift Before vs After */}
      <div className="rounded-2xl border border-[var(--hx-border)] bg-[var(--hx-surface)] p-3.5">
        <div className="mb-2">
          <div className="text-xs font-semibold text-[var(--hx-text)]">
            {t("deck.chartBarTitle")}
          </div>
          <div className="text-[11px] text-[var(--hx-text-3)]">{t("deck.chartBarSub")}</div>
        </div>
        <div className="h-[190px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={proposalBars} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--hx-border)" vertical={false} />
              <XAxis
                dataKey="name"
                tick={{ fill: "var(--hx-text-3)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "var(--hx-text-3)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar
                dataKey="beforeSteps"
                name={t("deck.barBeforeSteps")}
                fill="#94a3b8"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="afterSteps"
                name={t("deck.barAfterSteps")}
                fill="#0891b2"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="beforeErrors"
                name={t("deck.barBeforeErrors")}
                fill="#f43f5e"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="afterErrors"
                name={t("deck.barAfterErrors")}
                fill="#10b981"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
