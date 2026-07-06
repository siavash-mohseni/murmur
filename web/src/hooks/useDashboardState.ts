import { useEffect, useRef, useState, useCallback } from "react";
import { useNow } from "@/hooks/useNow";
// Single source of truth for the /events SSE wire shape. These types live in
// src/shared-types.ts (re-exported by src/state.ts for the server) and are
// imported here extensionless, mirroring web/src/lib/event-intent.ts importing
// ../../../src/intent. Re-exported below so @/hooks/useDashboardState keeps
// resolving for the rest of the web app.
import type {
  Activity,
  ActivityImage,
  AgentSessionMirror,
  DashboardState,
  Notification,
  PendingOption,
  PendingPermission,
  PendingQuestion,
  PermClassification,
  PermissionDecision,
  PermKind,
  PermRisk,
  PermScope,
  Row,
  RowStatus,
  SessionInfo,
  TokenStats,
  WorkflowAgentMirror,
  WorkflowMirror,
  WorkflowPhaseMirror,
  WorkflowRunStatus,
} from "../../../src/shared-types";

export type {
  Activity,
  ActivityImage,
  AgentSessionMirror,
  DashboardState,
  Notification,
  PendingOption,
  PendingPermission,
  PendingQuestion,
  PermClassification,
  PermissionDecision,
  PermKind,
  PermRisk,
  PermScope,
  Row,
  RowStatus,
  SessionInfo,
  TokenStats,
  WorkflowAgentMirror,
  WorkflowMirror,
  WorkflowPhaseMirror,
  WorkflowRunStatus,
};

// MemoryEntry and DailyActivityEntry originate in node-only server modules
// (src/memory.ts, src/stats-cache.ts), so they are not reachable from the
// browser bundle via shared-types. Kept as local web copies. They are
// structurally identical to the server shapes, so DashboardState.memoryEntries /
// dailyActivity (imported above) stay type-compatible with these.
export interface MemoryEntry {
  name: string;
  description: string;
  type?: string;
  filePath: string;
  modifiedAt: string;
  originSessionId?: string;
  thisSession: boolean;
}

export interface DailyActivityEntry {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

const HEARTBEAT_STALE_MS = 10_000;
const WARNING_FRESH_MS = 30_000;

import type { SessionSummary } from "../../../src/shared-types";
export type { SessionSummary };

export interface UseDashboardStateResult {
  state: DashboardState | null;
  isStale: boolean;
  isWarning: boolean;
  lastWarning: string | null;
  sessions: SessionSummary[];
  submitAnswer(questionId: string, answer: string): Promise<boolean>;
  submitPermission(permissionId: string, decision: PermissionDecision): Promise<boolean>;
  cancelQuestion(questionId: string): Promise<boolean>;
}

// basePath is "" when served directly by a session server, or "/s/<key>" when
// the hub proxies this session (fleet drill-down). Every fetch and the SSE
// stream are prefixed so the same view works on both origins.
export function useDashboardState(basePath = ""): UseDashboardStateResult {
  const [state, setState] = useState<DashboardState | null>(null);
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(() => Date.now());
  const [lastWarning, setLastWarning] = useState<string | null>(null);
  const [lastWarningAt, setLastWarningAt] = useState<number>(0);
  // Staleness/warning freshness need 1s precision (SessionMeta/ProgressPanel
  // also tick at 1s), so derive isStale/isWarning from the shared clock.
  const now = useNow(1_000);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchSessions = async (): Promise<void> => {
      try {
        const res = await fetch(`${basePath}/sessions`);
        if (!res.ok) return;
        const list = (await res.json()) as SessionSummary[];
        if (!cancelled) setSessions(list);
      } catch {
        // ignore network blip
      }
    };
    void fetchSessions();
    const id = setInterval(fetchSessions, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [basePath]);

  useEffect(() => {
    const source = new EventSource(`${basePath}/events`);
    sourceRef.current = source;

    source.addEventListener("state", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as { state: DashboardState };
        setState(event.state);
      } catch {
        // drop malformed frame, keep last good state
      }
    });
    source.addEventListener("heartbeat", () => {
      setLastHeartbeat(Date.now());
    });
    source.addEventListener("warning", (e) => {
      try {
        const event = JSON.parse((e as MessageEvent).data) as { message: string; at: string };
        setLastWarning(event.message);
        setLastWarningAt(Date.now());
      } catch {
        // drop malformed frame, keep last good warning
      }
    });

    return () => {
      source.close();
    };
  }, [basePath]);

  const submitAnswer = useCallback(
    async (questionId: string, answer: string) => {
      const res = await fetch(`${basePath}/api/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId, answer }),
      });
      return res.ok;
    },
    [basePath]
  );

  const cancelQuestion = useCallback(
    async (questionId: string) => {
      const res = await fetch(`${basePath}/api/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId }),
      });
      return res.ok;
    },
    [basePath]
  );

  const submitPermission = useCallback(
    async (permissionId: string, decision: PermissionDecision) => {
      const res = await fetch(`${basePath}/api/permission/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionId, decision }),
      });
      return res.ok;
    },
    [basePath]
  );

  const isStale = now - lastHeartbeat > HEARTBEAT_STALE_MS;
  const isWarning = lastWarning !== null && now - lastWarningAt < WARNING_FRESH_MS;

  return {
    state,
    isStale,
    isWarning,
    lastWarning,
    sessions,
    submitAnswer,
    cancelQuestion,
    submitPermission,
  };
}
