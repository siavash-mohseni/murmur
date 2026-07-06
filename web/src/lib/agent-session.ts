import type { AgentSessionMirror } from "@/hooks/useDashboardState";

// A session (from `claude agents --json`) is "waiting" when it reports a
// waiting/blocked status or names what it's blocked on (waitingFor).
export function isWaiting(a: AgentSessionMirror | undefined): boolean {
  if (!a) return false;
  return !!a.waitingFor || /wait|block|paus/i.test(a.status ?? "");
}

// Short human label for an agent session.
export function agentLabel(a: AgentSessionMirror): string {
  return a.name || a.cwdBasename || (a.sessionId ? a.sessionId.slice(0, 8) : "session");
}
