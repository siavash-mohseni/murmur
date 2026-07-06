import { useMemo } from "react";
import { Terminal } from "lucide-react";
import type { Activity } from "@/hooks/useDashboardState";
import { Panel } from "@/components/Panel";
import { relativeTime } from "@/lib/format";
import { filterByPeriod, periodLabel, type Period } from "@/lib/period";

export function BackgroundTasksPanel({
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
  // Filter to background Bash invocations, newest first. The reverse is folded
  // into the memo so render does not re-allocate and re-reverse the list on
  // unrelated re-renders. The subtitle below still uses tasks.length, which the
  // reverse leaves unchanged.
  const tasks = useMemo(
    () =>
      (
        inPeriod.filter(
          (a) => a.kind === "tool" && a.tool === "Bash" && a.runInBackground === true
        ) as Extract<Activity, { kind: "tool" }>[]
      )
        .slice()
        .reverse(),
    [inPeriod]
  );
  return (
    <Panel
      title="Background tasks"
      subtitle={
        tasks.length === 0
          ? period === "session"
            ? "No background shells started this session"
            : `No background shells in the ${periodLabel(period).toLowerCase()}`
          : `${tasks.length} background invocation${tasks.length === 1 ? "" : "s"}`
      }
    >
      {tasks.length === 0 ? (
        <div className="px-5 py-6 text-sm text-zinc-500">
          Bash calls with <code className="px-1">run_in_background: true</code> will appear here.
        </div>
      ) : (
        <>
          <div className="tbl-head">
            <span className="w-7 shrink-0" />
            <span className="flex-1 min-w-0">Command</span>
            <span className="w-24 shrink-0 text-right">Started</span>
          </div>
          {tasks.map((t) => (
            <div key={t.id} className="tbl-row">
              <span className="avatar-blob -mt-1 bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">
                <Terminal className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1 min-w-0 text-sm">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5 font-mono text-xs text-zinc-200 break-all whitespace-pre-wrap">
                  {t.target ?? "(empty)"}
                </code>
              </span>
              <span className="w-24 shrink-0 pt-0.5 text-right text-xs text-zinc-500 tabular-nums">
                {relativeTime(t.timestamp, now)}
              </span>
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
