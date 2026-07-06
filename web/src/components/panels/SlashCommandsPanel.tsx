import { useMemo } from "react";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { aggregateSlashes } from "@/lib/aggregate";
import { relativeTime } from "@/lib/format";
import { filterByPeriod, periodLabel, type Period } from "@/lib/period";

export function SlashCommandsPanel({
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
  const slashes = useMemo(() => aggregateSlashes(inPeriod), [inPeriod]);
  return (
    <Panel
      title="Slash commands"
      subtitle={
        slashes.length === 0
          ? period === "session"
            ? "No slash commands invoked this session"
            : `No slash commands in the ${periodLabel(period).toLowerCase()}`
          : `${slashes.length} distinct`
      }
    >
      {slashes.length === 0 ? (
        <div className="px-5 py-6 text-sm text-zinc-500">Anything starting with <code className="px-1">/</code> in your prompt will appear here.</div>
      ) : (
        <>
          <div className="tbl-head">
            <span className="w-40 shrink-0">Command</span>
            <span className="flex-1 min-w-0">Last args</span>
            <span className="w-12 shrink-0 text-right">Count</span>
            <span className="w-24 shrink-0 text-right">Last</span>
          </div>
          {slashes.map((s) => (
            <div key={s.name} className="tbl-row">
              <span className="w-40 shrink-0 text-sm font-medium text-zinc-100 break-words">
                /{s.name}
              </span>
              <span className="flex-1 min-w-0 text-sm text-zinc-400">
                {s.args ? (
                  <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-zinc-300 break-all whitespace-pre-wrap">
                    {s.args}
                  </code>
                ) : (
                  <em className="text-zinc-600">no args</em>
                )}
              </span>
              <span className="w-12 shrink-0 pt-0.5 text-right text-sm tabular-nums text-zinc-200">
                {s.count}
              </span>
              <span className="w-24 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                {relativeTime(s.lastAt, now)}
              </span>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
