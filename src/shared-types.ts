/**
 * Shared dashboard wire types. This module is BROWSER-SAFE: it is pure types
 * plus the single ROW_STATUSES const, with no top-level node imports and no
 * side effects, so the web bundle can import it directly (matching the
 * extensionless web-to-src import style used for src/intent.ts).
 *
 * The server's state.ts and permission-classifier.ts re-export everything here
 * (export *), so every existing server importer keeps resolving these names
 * from "./state.js" / "./permission-classifier.js" unchanged. The web
 * useDashboardState.ts imports the same names from "../../../src/shared-types".
 *
 * The two type-only imports below (MemoryEntry, DailyActivityEntry) are erased
 * at compile time, so they never pull memory.ts / stats-cache.ts (which DO use
 * node:*) into the browser bundle.
 */
import type { MemoryEntry } from "./memory.js";
import type { DailyActivityEntry } from "./stats-cache.js";

// Single source for the row-status union. Values verbatim from the previous
// RowStatus union in state.ts. RowStatus is derived so the two never drift.
export const ROW_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export interface Row {
  id: string;
  label: string;
  status: RowStatus;
  detail?: string;
  startedAt?: string;
  endedAt?: string;
  // Groups rows into one dashboard run so a second dashboard started mid-session
  // does not blend into the first. Older persisted rows leave this undefined and
  // render as a single ungrouped run.
  runId?: string;
  // Set on the first row of a run. Names the run in the UI (else it falls back to
  // "Run N" by order).
  runTitle?: string;
}

// A single image surfaced from the transcript: either one the user attached to
// a prompt, or one a tool returned to Claude (a figma grab, a browser
// screenshot). The base64 bytes are written to the session image store on disk
// and served by GET /api/image/<id>; only this light reference travels in the
// broadcast state, so a 0.5 MB PNG never bloats every SSE frame.
export interface ActivityImage {
  // Content hash (also the on-disk filename stem). Stable across re-scans, so
  // the same image captured twice collapses to one reference.
  id: string;
  // Server-relative URL the dashboard loads the bytes from.
  url: string;
  mediaType: string; // "image/png" | "image/jpeg" | ...
  // Where it came from: "prompt" = the user attached it, "tool" = a tool result
  // handed it back to Claude.
  source: "prompt" | "tool";
  // Optional label (e.g. the originating tool name for a capture).
  alt?: string;
}

export type Activity =
  | { kind: "log"; id: string; timestamp: string; message: string }
  | {
      kind: "tool";
      id: string;
      timestamp: string;
      tool: string;
      target?: string;
      durationMs?: number;
      ok: boolean;
      detail?: string;
      runInBackground?: boolean;
    }
  | {
      kind: "agent";
      id: string;
      timestamp: string;
      subagentType?: string;
      description: string;
      durationMs?: number;
      ok?: boolean;
    }
  | { kind: "warn"; id: string; timestamp: string; message: string }
  | {
      kind: "prompt";
      id: string;
      timestamp: string;
      source: "user" | "ask" | "murmur" | "permission" | "assistant";
      question: string;
      answer?: string;
      ok?: boolean;
      // Assistant replies only: a newline-preserved capture of the full reply
      // (see messageOutline in assistant-text.ts). The owner view parses this
      // into semantic milestone groups. Other surfaces use `question`.
      outline?: string;
      // Images carried by this turn: attached to the user's prompt (source
      // "user") or returned to Claude by a tool, in which case the row is
      // emitted with source "assistant". Absent when the turn had no images.
      images?: ActivityImage[];
    }
  | {
      kind: "hook";
      id: string;
      timestamp: string;
      hook: string;
      event?: string;
      detail?: string;
      ok?: boolean;
    };

// One live-or-past session as listed by the session switcher and the fleet
// surfaces. Canonical definition (server discovery and the web hook both
// re-export it from here).
export interface SessionSummary {
  key: string;
  port: number;
  url: string;
  current: boolean;
  alive: boolean;
  branch?: string;
  cwdBasename?: string;
  startedAt?: string;
  claudeSessionId?: string;
  title?: string;
  cwd?: string;
}

export interface SessionInfo {
  branch?: string;
  cwd?: string;
  cwdBasename?: string;
  model?: string;
  effort?: string;
  modifiedFiles?: number;
  userName?: string;
  claudeSessionId?: string;
  claudeSessionStartedAt?: string;
  // Custom usage dimensions parsed from OTEL_RESOURCE_ATTRIBUTES (e.g.
  // team=cpo,repo=murmur). Displayed as session chips, not persisted-derived.
  resourceAttributes?: Record<string, string>;
}

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // Subset of the above attributable to turns whose input side
  // (input + cache read + cache creation) exceeded the long-context
  // pricing threshold (200K for Sonnet/Opus 4.x on the 1M-context beta).
  longContextInputTokens: number;
  longContextOutputTokens: number;
  longContextCacheReadTokens: number;
  longContextCacheCreationTokens: number;
  totalTokens: number;
  lastContextTokens: number;
  contextLimit: number;
  messageCount: number;
  model?: string;
  updatedAt: string;
}

export interface PendingOption {
  label: string;
  description?: string;
}

export interface PendingQuestion {
  questionId: string;
  question: string;
  header?: string;
  options: PendingOption[];
  multiSelect: boolean;
  createdAt: string;
  expiresAt: string;
}

export type PermissionDecision = "allow" | "always" | "deny";

// --- permission classification unions (shared with permission-classifier.ts) -
export type PermKind =
  | "read"
  | "write"
  | "execute"
  | "delete"
  | "network"
  | "remote";

export type PermScope = "project" | "machine" | "web" | "remote";

export type PermRisk = "low" | "medium" | "high" | "critical";

export interface PermClassification {
  kind: PermKind;
  scope: PermScope;
  risk: PermRisk;
  kindLabel: string;
  scopeLabel: string;
  riskLabel: string;
  kindIcon: string;
  scopeIcon: string;
  riskIcon: string;
}

export interface PendingPermission {
  permissionId: string;
  tool: string;
  command: string;
  cwd?: string;
  createdAt: string;
  expiresAt: string;
  classification?: PermClassification;
}

// --- Claude Code dynamic-workflow mirror -----------------------------------
// A read-only projection of the harness's dynamic-workflow runs (the Workflow
// tool / `/workflows` view). Murmur tails the on-disk run files and surfaces
// them ALONGSIDE its own murmur_update progress, in a separate panel. These
// types are the truncated, web-safe shape. The raw wf_<id>.json / journal.jsonl
// files stay the durable source of truth and are never persisted into our
// per-session state file.

export type WorkflowRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "stale";

export interface WorkflowAgentMirror {
  agentId: string;
  // label/phase are only known once the run completes (the live journal has
  // bare agent ids only), they are absent mid-run.
  label?: string;
  agentType?: string;
  model?: string;
  // Already normalized to RowStatus so the web reuses StatusIcon/StatusPill.
  state: RowStatus;
  // Number of runtime attempts behind this row: the Workflow runtime retries a
  // dead agent under the same resume key with a fresh agentId, and the mirror
  // collapses those attempts into one row. Absent when the agent ran once.
  attempts?: number;
  phaseIndex?: number;
  phaseTitle?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
  // Truncated server-side (see clip()), suppressed when MURMUR_WORKFLOW_PREVIEWS=0.
  lastToolSummary?: string;
  resultPreview?: string;
}

export interface WorkflowPhaseMirror {
  index?: number;
  title: string;
  detail?: string;
}

export interface WorkflowMirror {
  runId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  agentCount: number;
  doneCount: number;
  phases?: WorkflowPhaseMirror[];
  agents: WorkflowAgentMirror[];
  // totalTokens stays = output tokens for back-compat with older snapshots.
  // The split fields below let the web estimate workflow cost with the same
  // pricing model as the main session (input/cache/output).
  totalTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
  totalToolCalls?: number;
  durationMs?: number;
  startedAt?: string;
  updatedAt: string;
  summary?: string;
}

// --- claude agents --json mirror -------------------------------------------
// Read-only projection of `claude agents --json` (all live Claude Code
// sessions on this machine). Surfaces sibling sessions, their status, and what
// a waiting session is blocked on (waitingFor). Live-only, never persisted.
export interface AgentSessionMirror {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  cwdBasename?: string;
  name?: string;
  status?: string;
  startedAt?: number;
  // Present when status is waiting/blocked: what it is blocked on (e.g. a
  // permission prompt). Surfaced verbatim from the CLI.
  waitingFor?: string;
  // Fan-out progress when the session is running fanned-out work.
  done?: number;
  total?: number;
  // The longest-running item, when the CLI exposes one (the "peek").
  peek?: string;
}

// A routine notification: written by external jobs (cron routines, the notify
// helper, or POST /api/notify) into the global notifications feed, surfaced in
// the Routines panel. Not tied to a session.
export interface Notification {
  id: string;
  timestamp: string;
  title: string;
  body: string;
  // Optional URL to open from the panel (a PR, a digest file, etc.).
  link?: string;
  // Which routine produced it, e.g. "morning-review-queue".
  source?: string;
  read: boolean;
}

export interface DashboardState {
  sessionId: string;
  rows: Row[];
  activities: Activity[];
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  port: number | null;
  startedAt: string;
  sessionInfo: SessionInfo;
  tokenStats: TokenStats | null;
  memoryEntries: MemoryEntry[];
  // Cross-session daily activity from ~/.claude/stats-cache.json. Live-only:
  // injected at broadcast time, not persisted.
  dailyActivity?: DailyActivityEntry[];
  // Mirrored Claude Code dynamic-workflow runs. Live-only, like dailyActivity:
  // injected at snapshot time, never written to the session state file.
  workflows?: WorkflowMirror[];
  // Mirrored `claude agents --json` sessions (all live sessions on the box).
  // Live-only, injected at snapshot time.
  agentSessions?: AgentSessionMirror[];
  // Whether the native macOS alert modal is currently enabled (env default OR
  // the dashboard's runtime override). Lets the alert chooser reflect reality.
  nativeAlerts?: boolean;
  // Whether native alerts are even possible here (macOS). The chooser hides the
  // native toggle when false.
  nativeSupported?: boolean;
  // Global routine-notifications feed. Live-only, injected at snapshot time from
  // the shared notifications.json (not per-session, not in the state file).
  notifications?: Notification[];
  // Live SSE subscriber count (open dashboard tabs). Live-only, injected at
  // snapshot time. Feeds the watcher gate: questions and permissions only
  // suppress the CLI prompt when someone can actually see them.
  clients?: number;
}

export type StateEvent =
  | { type: "state"; state: DashboardState }
  | { type: "heartbeat"; at: string }
  | { type: "warning"; message: string; at: string };

// --- hub / fleet -------------------------------------------------------------
// The hub (dist/hub.js) tails every live session's /events with ?role=mirror
// and projects each DashboardState down to this summary: enough for a fleet
// card and the global needs-you inbox, never the 3000-entry activity ring.

export interface FleetSessionSummary {
  key: string;
  port: number;
  // False while the hub's upstream tail is disconnected (server gone or not
  // yet reachable). A dead session drops off the registry once its port file
  // is pruned.
  alive: boolean;
  title?: string;
  branch?: string;
  cwd?: string;
  cwdBasename?: string;
  model?: string;
  effort?: string;
  startedAt?: string;
  resourceAttributes?: Record<string, string>;
  // Full payloads (not booleans) so the fleet inbox can render and answer the
  // prompt without a per-session round-trip.
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  rowsTotal: number;
  rowsCompleted: number;
  rowsFailed: number;
  rowsInProgress: number;
  // The newest activity, pre-summarized hub-side for the card's one-liner.
  lastActivityAt?: string;
  lastActivitySummary?: string;
  contextTokens?: number;
  contextLimit?: number;
  totalTokens?: number;
  costUsd?: number;
  messageCount?: number;
  // Human tabs connected directly to the session server (mirrors excluded).
  clients?: number;
  workflowsRunning?: number;
  // When the hub last received any event from this session. The web derives
  // idle/stale from this against its own clock.
  lastEventAt?: string;
}

export interface FleetSnapshot {
  generatedAt: string;
  sessions: FleetSessionSummary[];
}

// Events on the hub's own /events stream. The web's fleet hook listens for
// "fleet"; heartbeat keeps the connection observable like the session stream.
export type HubEvent =
  | { type: "fleet"; fleet: FleetSnapshot }
  | { type: "heartbeat"; at: string };
