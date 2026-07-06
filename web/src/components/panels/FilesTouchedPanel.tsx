import { useMemo } from "react";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { aggregateFiles } from "@/lib/aggregate";
import { relativeTime } from "@/lib/format";
import { filterByPeriod, periodLabel, type Period } from "@/lib/period";

export function FilesTouchedPanel({
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
  const files = useMemo(() => aggregateFiles(inPeriod), [inPeriod]);
  return (
    <Panel
      title="Files touched"
      subtitle={
        files.length === 0
          ? "No files edited or read yet"
          : period === "session"
            ? `${files.length} unique paths this session`
            : `${files.length} unique paths in the ${periodLabel(period).toLowerCase()}`
      }
      empty="Editing or reading a file will populate this list."
    >
      {files.length === 0 ? undefined : (
        <>
          <div className="tbl-head">
            <span className="flex-1 min-w-0">Path</span>
            <span className="w-16 shrink-0 text-right">Writes</span>
            <span className="w-16 shrink-0 text-right">Reads</span>
            <span className="w-24 shrink-0 text-right">Last</span>
          </div>
          {files.slice(0, 30).map((f) => (
            <div key={f.path} className="tbl-row">
              <span className="flex-1 min-w-0 text-sm text-zinc-200">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-zinc-300 break-all">
                  {f.path}
                </code>
              </span>
              <span className="w-16 shrink-0 pt-0.5 text-right text-sm tabular-nums">
                {f.writes > 0 ? (
                  <span className="text-blue-300">{f.writes}</span>
                ) : (
                  <span className="text-zinc-600">·</span>
                )}
              </span>
              <span className="w-16 shrink-0 pt-0.5 text-right text-sm tabular-nums">
                {f.reads > 0 ? (
                  <span className="text-zinc-300">{f.reads}</span>
                ) : (
                  <span className="text-zinc-600">·</span>
                )}
              </span>
              <span className="w-24 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                {relativeTime(f.lastTouched, now)}
              </span>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
