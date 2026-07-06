import { useMemo } from "react";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { aggregateTools } from "@/lib/aggregate";
import { formatLongDuration } from "@/lib/format";
import { filterByPeriod, type Period } from "@/lib/period";

export function ToolBreakdownPanel({
  activities,
  period,
  now,
}: {
  activities: Activity[];
  period: Period;
  now: number;
}): React.JSX.Element {
  const inPeriod = useMemo(
    () => filterByPeriod(activities, period, now),
    [activities, period, now]
  );
  const stats = useMemo(() => aggregateTools(inPeriod), [inPeriod]);
  const totalMs = stats.reduce((s, t) => s + t.totalMs, 0);
  const totalCount = stats.reduce((s, t) => s + t.count, 0);
  const totalFailures = stats.reduce((s, t) => s + t.failures, 0);
  return (
    <Panel
      title="Tool breakdown"
      subtitle={
        stats.length === 0
          ? "No tool calls in this window"
          : `${stats.length} tools · ${totalCount} calls · ${formatLongDuration(totalMs)}` +
            (totalFailures > 0 ? ` · ${totalFailures} failed` : "")
      }
      empty="Tool activity will fill this panel."
    >
      {stats.length === 0 ? undefined : (
        <div className="px-5 py-4 space-y-2.5">
          {stats.map((s) => {
            const pct = totalMs > 0 ? (s.totalMs / totalMs) * 100 : 0;
            return (
              <div key={s.tool}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="flex items-baseline gap-2 font-medium text-zinc-200">
                    {s.tool}
                    {s.failures > 0 && (
                      <span
                        className="rounded bg-rose-500/10 px-1 py-px text-[10px] font-semibold tabular-nums text-rose-300 ring-1 ring-inset ring-rose-500/30"
                        title={`${s.failures} of ${s.count} calls failed`}
                      >
                        {s.failures} failed
                      </span>
                    )}
                  </span>
                  <span className="text-zinc-500 tabular-nums">
                    {s.count} call{s.count === 1 ? "" : "s"} ·{" "}
                    {formatLongDuration(s.totalMs)} ({pct.toFixed(0)}%)
                    {s.p95Ms > 0 ? ` · p95 ${formatLongDuration(s.p95Ms)}` : ""}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-white/[0.04]">
                  <div
                    className="h-full bg-gradient-to-r from-blue-500 to-indigo-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
