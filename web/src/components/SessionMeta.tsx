import { AlertTriangle, GitBranch, WifiOff } from "lucide-react";
import type { SessionInfo } from "@/hooks/useDashboardState";
import { useNow } from "@/hooks/useNow";
import { elapsedString } from "@/lib/format";

// Only this node re-renders each second, so the static chips around it (branch,
// cwd, model, OTEL attributes, badges) are untouched by the elapsed clock tick.
function ElapsedClock({ startedAt }: { startedAt: string }): React.JSX.Element {
  const now = useNow(1000);
  return <span className="tabular-nums">elapsed {elapsedString(startedAt, now)}</span>;
}

export function SessionMeta({
  sessionInfo,
  startedAt,
  isStale,
  isWarning,
}: {
  sessionInfo: SessionInfo;
  startedAt: string;
  isStale: boolean;
  isWarning: boolean;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      {sessionInfo.branch && (
        <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-0.5 font-mono text-zinc-300 ring-1 ring-inset ring-white/10">
          <GitBranch className="h-3 w-3" />
          {sessionInfo.branch}
        </span>
      )}
      {sessionInfo.cwdBasename && (
        <span className="rounded-md bg-white/[0.04] px-2 py-0.5 font-mono text-zinc-300 ring-1 ring-inset ring-white/10">
          {sessionInfo.cwdBasename}
        </span>
      )}
      {typeof sessionInfo.modifiedFiles === "number" && sessionInfo.modifiedFiles > 0 && (
        <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-amber-300 ring-1 ring-inset ring-amber-500/30">
          {sessionInfo.modifiedFiles} changed
        </span>
      )}
      {sessionInfo.model && (
        <span className="rounded-md bg-white/[0.04] px-2 py-0.5 font-mono text-zinc-300 ring-1 ring-inset ring-white/10">
          {sessionInfo.model}
        </span>
      )}
      {sessionInfo.effort && (
        <span className="text-zinc-500">effort {sessionInfo.effort}</span>
      )}
      {/* Custom usage dimensions from OTEL_RESOURCE_ATTRIBUTES (team, repo, …) */}
      {sessionInfo.resourceAttributes &&
        Object.entries(sessionInfo.resourceAttributes).map(([k, v]) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-2 py-0.5 text-indigo-200 ring-1 ring-inset ring-indigo-500/25"
            title={`OTEL resource attribute: ${k}`}
          >
            <span className="text-indigo-400/80">{k}</span>
            <span className="font-mono">{v}</span>
          </span>
        ))}
      <span className="text-zinc-500">·</span>
      <ElapsedClock startedAt={startedAt} />
      <span className="ml-auto flex items-center gap-2">
        {isStale && (
          <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-amber-300 ring-1 ring-inset ring-amber-500/30">
            <WifiOff className="h-3 w-3" />
            stale
          </span>
        )}
        {isWarning && (
          <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-2 py-0.5 text-rose-300 ring-1 ring-inset ring-rose-500/30">
            <AlertTriangle className="h-3 w-3" />
            mirror
          </span>
        )}
      </span>
    </div>
  );
}
