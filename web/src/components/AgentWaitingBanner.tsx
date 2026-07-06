import { Clock } from "lucide-react";
import type { AgentSessionMirror } from "@/hooks/useDashboardState";
import { WarnBanner } from "@/components/Panel";
import { agentLabel, isWaiting } from "@/lib/agent-session";

// Surfaces Claude Code sessions (from `claude agents --json`) that are blocked
// waiting on input — most usefully sibling sessions you're not currently
// looking at, so a permission prompt elsewhere doesn't sit unnoticed.
export function AgentWaitingBanner({
  agentSessions,
  currentSessionId,
}: {
  agentSessions: AgentSessionMirror[];
  currentSessionId?: string;
}): React.JSX.Element | null {
  const waiting = agentSessions.filter(isWaiting);
  if (waiting.length === 0) return null;
  return (
    <WarnBanner
      icon={<Clock className="h-4 w-4" />}
      title={
        waiting.length === 1
          ? "A session is waiting for input"
          : `${waiting.length} sessions are waiting for input`
      }
    >
      <ul className="mt-1.5 space-y-1 text-xs text-amber-100/90">
        {waiting.map((a, i) => {
          const mine = !!currentSessionId && a.sessionId === currentSessionId;
          return (
            <li key={a.sessionId ?? a.pid ?? i}>
              <span className="font-semibold">{agentLabel(a)}</span>
              {mine && <span className="text-amber-300/80"> (this session)</span>}
              {a.waitingFor ? (
                <>
                  {" "}
                  — blocked on{" "}
                  <span className="font-medium">{a.waitingFor}</span>
                </>
              ) : (
                <> — {a.status}</>
              )}
            </li>
          );
        })}
      </ul>
    </WarnBanner>
  );
}
