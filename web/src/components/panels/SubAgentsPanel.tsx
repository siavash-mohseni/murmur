import { useMemo } from "react";
import { Bot } from "lucide-react";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { aggregateAgents } from "@/lib/aggregate";
import { formatLongDuration, relativeTime } from "@/lib/format";
import { filterByPeriod, type Period } from "@/lib/period";

export function SubAgentsPanel({
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
  const stats = useMemo(() => aggregateAgents(inPeriod), [inPeriod]);
  return (
    <Panel
      title="Sub-agents"
      subtitle={
        stats.length === 0
          ? "No sub-agent dispatches in this window"
          : `${stats.length} type${stats.length === 1 ? "" : "s"}`
      }
      empty="Agent / Task tool calls populate this panel with a count, total time, and success rate."
    >
      {stats.length === 0 ? undefined : (
        <>
          <div className="tbl-head">
            <span className="w-7 shrink-0" />
            <span className="flex-1">Type</span>
            <span className="w-16 shrink-0 text-right">Count</span>
            <span className="w-20 shrink-0 text-right">Time</span>
            <span className="w-24 shrink-0 text-right">Outcome</span>
            <span className="w-20 shrink-0 text-right">Last</span>
          </div>
          {stats.map((s) => (
            <div key={s.subagentType} className="tbl-row">
              <span className="avatar-blob -mt-1 bg-violet-500/15 text-violet-300 ring-violet-500/30">
                <Bot className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1 min-w-0 text-sm font-medium text-zinc-100 break-words">
                {s.subagentType}
              </span>
              <span className="w-16 shrink-0 pt-0.5 text-right text-sm tabular-nums text-zinc-200">
                {s.count}
              </span>
              <span className="w-20 shrink-0 pt-0.5 text-right text-xs tabular-nums text-zinc-400">
                {s.totalMs > 0 ? formatLongDuration(s.totalMs) : "—"}
              </span>
              <span className="w-24 shrink-0 pt-0.5 text-right text-xs tabular-nums">
                {s.successes + s.failures === 0 ? (
                  <span className="text-zinc-500">—</span>
                ) : s.failures === 0 ? (
                  <span className="text-emerald-300">{s.successes} ok</span>
                ) : (
                  <span>
                    <span className="text-emerald-300">{s.successes}</span>
                    <span className="text-zinc-500"> · </span>
                    <span className="text-rose-300">{s.failures} err</span>
                  </span>
                )}
              </span>
              <span className="w-20 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                {relativeTime(s.lastAt, now)}
              </span>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
