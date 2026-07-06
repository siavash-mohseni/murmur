export type ActivityFilter = "all" | "tool" | "agent" | "prompt" | "hook" | "log" | "warn";
export type Period = "session" | "5m" | "15m" | "30m" | "1h";

export const PERIODS: { key: Period; label: string }[] = [
  { key: "session", label: "This session" },
  { key: "5m", label: "Last 5 min" },
  { key: "15m", label: "Last 15 min" },
  { key: "30m", label: "Last 30 min" },
  { key: "1h", label: "Last hour" },
];
export function periodLabel(p: Period): string {
  return PERIODS.find((x) => x.key === p)?.label ?? "This session";
}
export function periodCutoffMs(p: Period): number | null {
  if (p === "session") return null;
  const minutes: Record<Exclude<Period, "session">, number> = {
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
  };
  return minutes[p] * 60_000;
}
export function filterByPeriod<T extends { timestamp: string }>(
  items: T[],
  p: Period,
  now: number
): T[] {
  const cutoffMs = periodCutoffMs(p);
  if (cutoffMs === null) return items;
  const minTs = now - cutoffMs;
  return items.filter((x) => Date.parse(x.timestamp) >= minTs);
}
