import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function shortSha(sha: string, len = 7): string {
  return sha.slice(0, len);
}

export function resolveCommitVersionLabel(
  commits: ReadonlyArray<{ sha: string; versionTag: string }>,
  sha?: string | null,
  explicitLabel?: string | null,
): string {
  if (explicitLabel && explicitLabel.trim()) return explicitLabel;
  if (sha) {
    const matched = commits.find((c) => c.sha === sha || c.sha.startsWith(sha));
    if (matched?.versionTag) return matched.versionTag;
  }
  return commits[0]?.versionTag ?? "v1";
}

export function resolveCommitSha(
  commits: ReadonlyArray<{ sha: string }>,
  sha?: string | null,
  fallbackSha?: string | null,
): string {
  if (sha && sha.trim()) return sha;
  if (fallbackSha && fallbackSha.trim()) return fallbackSha;
  return commits[0]?.sha ?? "0000000";
}

export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.floor(secs % 60);
  return `${mins}m ${rem}s`;
}

export function formatUsd(amount: number): string {
  if (amount < 0.01 && amount > 0) {
    return `$${amount.toFixed(4)}`;
  }
  return `$${amount.toFixed(2)}`;
}

export function formatDurationMs(ms: number, locale = "en-US"): string {
  const isZh = locale.startsWith("zh");
  if (ms < 1000) return isZh ? `${ms} 毫秒` : `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return isZh ? `${s.toFixed(1)} 秒` : `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return isZh ? `${m} 分 ${rem} 秒` : `${m}m ${rem}s`;
}

export function formatTokens(tokens: number, locale = "en-US"): string {
  if (locale.startsWith("zh")) {
    if (tokens >= 100_000_000) return `${(tokens / 100_000_000).toFixed(2)}亿`;
    if (tokens >= 10_000) return `${(tokens / 10_000).toFixed(1)}万`;
  }
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function formatDeltaPct(before: number, after: number): string {
  if (before === 0) {
    return after === 0 ? "0%" : "+100%";
  }
  const pct = Math.round(((after - before) / before) * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

export function formatRelativeTime(iso: string, locale = "en-US"): string {
  const isZh = locale.startsWith("zh");
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return isZh ? "刚刚" : "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return isZh ? `${sec} 秒前` : `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return isZh ? `${min} 分钟前` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return isZh ? `${hr} 小时前` : `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return isZh ? `${day} 天前` : `${day}d ago`;
}
