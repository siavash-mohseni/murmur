import { useRef, useState } from "react";
import { Archive, ChevronDown, Clock } from "lucide-react";
import type { AgentSessionMirror, SessionSummary } from "@/hooks/useDashboardState";
import { useClickOutside } from "@/hooks/useClickOutside";
import { isWaiting } from "@/lib/agent-session";

export function shortKey(s: SessionSummary): string {
  if (s.claudeSessionId) return s.claudeSessionId.slice(0, 8);
  const m = s.key.match(/^claude-(\d+)$/);
  if (m) return `pid ${m[1]}`;
  return s.key.slice(0, 12);
}
export function displayTitle(s: SessionSummary): string {
  return s.title ?? shortKey(s);
}

export function SessionSwitcher({
  sessions,
  agentSessions = [],
  onBrowsePast,
  onSwitch,
}: {
  sessions: SessionSummary[];
  agentSessions?: AgentSessionMirror[];
  onBrowsePast?: () => void;
  // Under the hub, switching is a client-side route change (/s/<key>) instead
  // of a full navigation to the session's own port.
  onSwitch?: (s: SessionSummary) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useClickOutside(rootRef, () => setOpen(false), open);

  // We render even when `sessions` is empty (e.g. /sessions still loading or
  // failing) so the Browse-past-sessions entry remains reachable. When there
  // is no live session list, the trigger falls back to a generic "Sessions"
  // label and the dropdown shows only the past-sessions footer.
  if (sessions.length === 0 && !onBrowsePast) return null;
  const current = sessions.find((s) => s.current) ?? sessions[0];
  const others = sessions.filter((s) => !s.current);

  // Match `claude agents --json` data to a murmur session by claude session id.
  const agentBySid = new Map<string, AgentSessionMirror>();
  for (const a of agentSessions) if (a.sessionId) agentBySid.set(a.sessionId, a);
  const agentFor = (s: SessionSummary): AgentSessionMirror | undefined =>
    s.claudeSessionId ? agentBySid.get(s.claudeSessionId) : undefined;
  // Any session (other than the one we're viewing) blocked on something — used
  // to badge the trigger so a waiting sibling is noticeable while collapsed.
  const waitingOthers = sessions.filter((s) => !s.current && isWaiting(agentFor(s)));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="period-pill max-w-[24rem]"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2 min-w-0">
          {current ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
              <span className="truncate">{displayTitle(current)}</span>
              {current.cwdBasename && (
                <span className="text-zinc-500 shrink-0">· {current.cwdBasename}</span>
              )}
            </>
          ) : (
            <>
              <Archive className="h-4 w-4 text-zinc-400" />
              <span>Sessions</span>
            </>
          )}
        </span>
        {waitingOthers.length > 0 && (
          <span
            className="ml-1 inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/30 shrink-0"
            title={`${waitingOthers.length} other session${waitingOthers.length === 1 ? "" : "s"} waiting for input`}
          >
            <Clock className="h-3 w-3" />
            {waitingOthers.length}
          </span>
        )}
        <ChevronDown className={`h-4 w-4 transition shrink-0 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-20 mt-2 min-w-[18rem] overflow-hidden rounded-md border border-white/10 bg-zinc-900 shadow-lg ring-1 ring-black/30"
        >
          {sessions.map((s) => {
            const agent = agentFor(s);
            const waiting = isWaiting(agent);
            const hasFanout =
              agent?.total !== undefined && agent.total > 0 && agent.done !== undefined;
            return (
              <button
                key={s.key}
                role="option"
                aria-selected={s.current}
                disabled={!s.alive}
                onClick={() => {
                  if (!s.current && s.alive) {
                    if (onSwitch) onSwitch(s);
                    else window.location.href = s.url;
                  }
                }}
                className={`flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-sm transition ${
                  s.current
                    ? "bg-blue-500/15 text-blue-200"
                    : s.alive
                      ? "text-zinc-200 hover:bg-white/[0.06]"
                      : "cursor-not-allowed text-zinc-500 opacity-60"
                }`}
              >
                <span className="flex items-start gap-2 min-w-0 flex-1">
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                      waiting
                        ? "bg-amber-400"
                        : s.alive
                          ? s.current
                            ? "bg-blue-400"
                            : "bg-emerald-400"
                          : "bg-zinc-600"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{displayTitle(s)}</span>
                      {/* done/total leads the agent detail when work is fanned out */}
                      {hasFanout && (
                        <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[10px] font-medium tabular-nums text-zinc-300">
                          {agent!.done}/{agent!.total}
                        </span>
                      )}
                    </div>
                    {waiting && agent?.waitingFor && (
                      <div className="mt-0.5 flex items-center gap-1 text-[11px] text-amber-300">
                        <Clock className="h-3 w-3 shrink-0" />
                        <span className="truncate">blocked on: {agent.waitingFor}</span>
                      </div>
                    )}
                    {agent?.peek && (
                      <div className="mt-0.5 truncate text-[11px] text-zinc-400">
                        ↳ {agent.peek}
                      </div>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-1.5 text-[11px] text-zinc-500">
                      {s.cwdBasename && <span>{s.cwdBasename}</span>}
                      {s.branch && <span className="font-mono">· {s.branch}</span>}
                      {s.claudeSessionId && (
                        <span className="font-mono">· {s.claudeSessionId.slice(0, 8)}</span>
                      )}
                    </div>
                  </span>
                </span>
                <span className="shrink-0 pt-0.5 text-xs text-zinc-500 tabular-nums">:{s.port}</span>
              </button>
            );
          })}
          {sessions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500">
              No active sessions.
            </div>
          ) : others.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500">
              Only this session is active.
            </div>
          ) : null}
          {onBrowsePast && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onBrowsePast();
              }}
              className="flex w-full items-center gap-2 border-t border-white/5 px-3 py-2.5 text-left text-sm text-zinc-300 transition hover:bg-white/[0.06]"
            >
              <Archive className="h-4 w-4 text-zinc-400" />
              <span>Browse past sessions</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
