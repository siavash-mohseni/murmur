import { useMemo } from "react";
import type {
  Activity,
  DailyActivityEntry,
  DashboardState,
  TokenStats,
  WorkflowMirror,
} from "@/hooks/useDashboardState";
import {
  cacheRatio,
  costByComponent,
  estimateWorkflowCost,
  sumWorkflowTokens,
  CONTEXT_CLIFF_FRACTION,
  CONTEXT_WARN_FRACTION,
} from "@/lib/cost";
import { filterByPeriod, periodCutoffMs, type Period } from "@/lib/period";

interface ChartSegment {
  label: string;
  value: number;
  color: string;
}

interface ActivityKpi {
  sparkline: number[];
  latest: {
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  } | null;
  avgMessages: number;
  daysStale: number;
}

export interface DashboardKpis {
  activitiesInPeriod: Activity[];
  toolCount: number;
  tokenStats: TokenStats | null;
  workflowCost: number;
  workflowTokens: number;
  toolSparkline: number[];
  tokenSegments: ChartSegment[];
  costSegments: ChartSegment[];
  activityKpi: ActivityKpi;
  contextPct: number;
  warnPct: number;
  cliffPct: number;
  contextTier: "ok" | "warn" | "cliff";
  contextGaugeColor: string;
  cacheHitPct: number;
  cacheHitColor: string;
}

// The preview override is a debug-only query flag. location.search is stable for
// the page lifetime, so parse it once instead of on every render.
function readTierOverride(): "warn" | "cliff" | null {
  if (typeof window === "undefined") return null;
  const p = new URLSearchParams(window.location.search).get("previewContextBanner");
  return p === "warn" || p === "cliff" ? p : null;
}

/**
 * All the KPI / chart derivation App needs, extracted from the layout shell.
 * Behavior-identical to the former inline block: same memo keys, same math,
 * same colors. Reads only from the live state, the selected period, and the
 * shared clock.
 */
export function useDashboardKpis(
  state: DashboardState | null,
  period: Period,
  now: number
): DashboardKpis {
  const activities = state?.activities ?? [];
  const tokenStats = state?.tokenStats ?? null;
  const dailyActivity: DailyActivityEntry[] = state?.dailyActivity ?? [];
  const workflows: WorkflowMirror[] = state?.workflows ?? [];
  const startedAt = state?.startedAt;

  const activitiesInPeriod = useMemo(
    () => filterByPeriod(activities, period, now),
    [activities, period, now]
  );

  const toolCount = useMemo(
    () => activitiesInPeriod.filter((a) => a.kind === "tool").length,
    [activitiesInPeriod]
  );

  // Dynamic-workflow sub-agents bill on top of the main session. Surface their
  // cost and token usage so the Cost / Tokens KPIs reflect fanned-out work.
  const workflowCost = useMemo(() => estimateWorkflowCost(workflows), [workflows]);
  const workflowTokens = useMemo(() => sumWorkflowTokens(workflows), [workflows]);

  const toolSparkline = useMemo<number[]>(() => {
    const N = 24;
    const toolTs = activitiesInPeriod
      .filter((a) => a.kind === "tool")
      .map((a) => new Date(a.timestamp).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    if (toolTs.length === 0) return new Array(N).fill(0);
    const cutoff = periodCutoffMs(period);
    const parsedStart = startedAt ? new Date(startedAt).getTime() : Number.NaN;
    const sessionStart = Number.isFinite(parsedStart) ? parsedStart : toolTs[0]!;
    const start = cutoff === null ? Math.min(sessionStart, toolTs[0]!) : now - cutoff;
    const end = now;
    const span = Math.max(1, end - start);
    const bins = new Array<number>(N).fill(0);
    for (const t of toolTs) {
      const ratio = (t - start) / span;
      if (ratio < 0 || ratio > 1) continue;
      const idx = Math.min(N - 1, Math.floor(ratio * N));
      bins[idx]! += 1;
    }
    return bins;
  }, [activitiesInPeriod, period, now, startedAt]);

  const tokenSegments = useMemo<ChartSegment[]>(() => {
    if (!tokenStats) return [];
    return [
      { label: "Cache read", value: tokenStats.cacheReadTokens, color: "rgb(45 212 191)" },
      { label: "Cache write", value: tokenStats.cacheCreationTokens, color: "rgb(129 140 248)" },
      { label: "Input", value: tokenStats.inputTokens, color: "rgb(96 165 250)" },
      { label: "Output", value: tokenStats.outputTokens, color: "rgb(52 211 153)" },
    ];
  }, [tokenStats]);

  const costSegments = useMemo<ChartSegment[]>(() => {
    if (!tokenStats) return [];
    const c = costByComponent(tokenStats);
    return [
      { label: "Output", value: c.output, color: "rgb(52 211 153)" },
      { label: "Cache write", value: c.cacheCreation, color: "rgb(129 140 248)" },
      { label: "Input", value: c.input, color: "rgb(96 165 250)" },
      { label: "Cache read", value: c.cacheRead, color: "rgb(45 212 191)" },
    ];
  }, [tokenStats]);

  const activityKpi = useMemo<ActivityKpi>(() => {
    if (dailyActivity.length === 0) {
      return {
        sparkline: new Array<number>(14).fill(0),
        latest: null,
        avgMessages: 0,
        daysStale: 0,
      };
    }
    const sparkline = dailyActivity.map((d) => d.messageCount);
    const latest = dailyActivity[dailyActivity.length - 1] ?? null;
    const sum = dailyActivity.reduce((acc, d) => acc + d.messageCount, 0);
    const avgMessages = Math.round(sum / dailyActivity.length);
    const latestDate = latest ? new Date(`${latest.date}T00:00:00Z`).getTime() : Number.NaN;
    const daysStale = Number.isFinite(latestDate)
      ? Math.max(0, Math.floor((Date.now() - latestDate) / (24 * 60 * 60 * 1000)))
      : 0;
    return { sparkline, latest, avgMessages, daysStale };
  }, [dailyActivity]);

  const tierOverride = useMemo(() => readTierOverride(), []);

  const contextScalars = useMemo(() => {
    const contextPct = tokenStats
      ? Math.min(1, tokenStats.lastContextTokens / tokenStats.contextLimit)
      : 0;
    // Thresholds are a fraction of the model's own window, so the markers mean
    // the same thing on a 200K Haiku session and a 1M Opus one.
    const warnPct = tokenStats ? CONTEXT_WARN_FRACTION : 0;
    const cliffPct = tokenStats ? CONTEXT_CLIFF_FRACTION : 0;
    const contextTier: "ok" | "warn" | "cliff" = tierOverride
      ? tierOverride
      : !tokenStats
        ? "ok"
        : contextPct >= CONTEXT_CLIFF_FRACTION
          ? "cliff"
          : contextPct >= CONTEXT_WARN_FRACTION
            ? "warn"
            : "ok";
    const contextGaugeColor =
      contextTier === "cliff"
        ? "rgb(244 63 94)"
        : contextTier === "warn"
          ? "rgb(251 191 36)"
          : "rgb(96 165 250)";

    const cacheHitPct = tokenStats ? cacheRatio(tokenStats) : 0;
    const cacheHitColor =
      cacheHitPct > 0.7
        ? "rgb(52 211 153)"
        : cacheHitPct > 0.3
          ? "rgb(251 191 36)"
          : "rgb(244 63 94)";

    return {
      contextPct,
      warnPct,
      cliffPct,
      contextTier,
      contextGaugeColor,
      cacheHitPct,
      cacheHitColor,
    };
  }, [tokenStats, tierOverride]);

  return {
    activitiesInPeriod,
    toolCount,
    tokenStats,
    workflowCost,
    workflowTokens,
    toolSparkline,
    tokenSegments,
    costSegments,
    activityKpi,
    ...contextScalars,
  };
}
