// Shared formatters used by the dashboard UI and the HTML renderers.
// Keep this file dependency-free so any module can import from it without
// pulling in React or the dashboard hook.

import type { Row } from "@/hooks/useDashboardState";

// Implementation moved to src/export/time.ts (the server-side export renderer
// needs it too); re-exported here so web call sites keep this import path.
export { formatLocalTime } from "../../../src/export/time";

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
export function displayName(raw: string): string {
  const first = raw.split(/[.\s_-]/)[0] ?? raw;
  return first.charAt(0).toUpperCase() + first.slice(1);
}
export function formatDuration(ms?: number): string | null {
  if (ms === undefined || ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
export function formatLongDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
export function rowDuration(row: Row, now: number): string | null {
  if (!row.startedAt) return null;
  const start = Date.parse(row.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = row.endedAt ? Date.parse(row.endedAt) : now;
  return formatLongDuration(Math.max(0, end - start));
}
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}K` : `${k.toFixed(1)}K`;
  }
  const m = n / 1_000_000;
  return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(2)}M`;
}
export function relativeTime(iso: string, now: number): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
export function elapsedString(startedAt: string, now: number): string {
  const startMs = new Date(startedAt).getTime();
  const sec = Math.max(0, Math.floor((now - startMs) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
