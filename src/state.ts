import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  existsSync,
  watch,
} from "node:fs";
import { writeFile as writeFileAsync, rename as renameAsync } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { isKnownModel } from "./model-caps.js";
import { readDailyActivity } from "./stats-cache.js";
import {
  readNotifications,
  appendNotification as appendNotificationToDisk,
  setNotificationRead as setNotificationReadOnDisk,
  dismissNotification as dismissNotificationOnDisk,
  type NotificationInput,
} from "./notifications.js";
import type { MemoryEntry } from "./memory.js";
import { spawnMacAlert, type MacAlertHandle } from "./mac-alert.js";
import { resolveSessionTitle, pidToSessionId } from "./titles.js";
import { classifyPermission } from "./permission-classifier.js";
import { buildQuestionAlert, buildPermissionAlert } from "./alert-presenter.js";
import type {
  Activity,
  ActivityImage,
  AgentSessionMirror,
  DashboardState,
  Notification,
  PendingPermission,
  PendingQuestion,
  PermissionDecision,
  Row,
  RowStatus,
  SessionInfo,
  StateEvent,
  TokenStats,
  WorkflowMirror,
} from "./shared-types.js";

// Re-export every shared wire type so existing server importers keep resolving
// these names from "./state.js" unchanged (Row, RowStatus, Activity, TokenStats,
// SessionInfo, Pending*, Workflow*, AgentSessionMirror, DashboardState,
// StateEvent, PermissionDecision, Perm* …).
export * from "./shared-types.js";

/**
 * Walk the PPID chain looking for the parent Claude Code process. Used when
 * CLAUDE_CODE_SESSION_ID isn't set in the MCP child's env (harness-spawned
 * children). The hook does the same walk so both sides arrive at the same id.
 */
function findClaudeParentPid(startPid: number): string | null {
  let pid = startPid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    try {
      const cmd = execSync(`ps -p ${pid} -o command=`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (
        /(^|\/)claude(\s|$)/.test(cmd) &&
        !cmd.includes("murmur/dist") &&
        !cmd.includes("claude-mcp")
      ) {
        return String(pid);
      }
      const ppidOut = execSync(`ps -p ${pid} -o ppid=`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      pid = parseInt(ppidOut, 10);
      if (!Number.isFinite(pid)) break;
    } catch {
      break;
    }
  }
  return null;
}

function currentUserName(): string | undefined {
  try {
    const u = userInfo();
    return u.username;
  } catch {
    return undefined;
  }
}

const isTerminalStatus = (s: RowStatus): boolean =>
  s === "completed" || s === "failed";

// UUID-shape gate. Used everywhere we must distinguish a real Claude session
// UUID from a PID-keyed fallback before promoting/mirroring session-id state.
const isUuid = (s: string): boolean => /^[0-9a-f-]{36}$/i.test(s);

type Listener = (event: StateEvent) => void;

const STATE_DIR = join(homedir(), ".claude", "state", "murmur");
const SESSIONS_DIR = join(STATE_DIR, "sessions");
const LEGACY_STATE_FILE = join(STATE_DIR, "session.json");
const WARNINGS_LOG = join(STATE_DIR, "warnings.log");
// Native-alert on/off lives in one shared file under STATE_DIR — not per-session
// and NOT in-memory — so the choice is durable across restarts and identical for
// every concurrent Murmur server regardless of port. Absent file = opt-in default
// OFF; "1"/"0" once the user has toggled it from any dashboard.
const NATIVE_PREF_FILE = join(STATE_DIR, "native-alert.pref");
const MAX_ACTIVITIES = 3000;
// Coalesce on-disk persistence: in-memory mutation and broadcast() stay
// synchronous, but the disk write is deferred up to this long and written at
// most once per window. On the hottest path (addActivity on every mirrored
// hook event) this turns thousands of full re-serializations per session into
// a handful of async writes.
const PERSIST_DEBOUNCE_MS = 250;

// How long a hub remote-watcher heartbeat stays credible. The hub posts every
// 10s while it has clients, so three missed beats means the hub (or its last
// client) is gone and the terminal prompt must win again.
const REMOTE_WATCHER_TTL_MS = 30_000;

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

function readNativePref(): boolean | null {
  try {
    if (!existsSync(NATIVE_PREF_FILE)) return null;
    const raw = readFileSync(NATIVE_PREF_FILE, "utf8").trim();
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeNativePref(enabled: boolean): void {
  try {
    writeFileSync(NATIVE_PREF_FILE, enabled ? "1" : "0");
  } catch {
    // best-effort; the in-memory cache still reflects the latest choice
  }
}

const CLAUDE_SESSION_ID = process.env["CLAUDE_CODE_SESSION_ID"] ?? "";

/**
 * Find the matching orphan state file for a UUID: the readdir + parse scan
 * shared by the import-time adoption (adoptOrphanedStateFile) and the live
 * observeClaudeSession path (adoptOrphanIfRicher). Prefers an exact
 * <uuid>.json when present, otherwise returns the first claude-*.json whose
 * sessionInfo.claudeSessionId matches, or null when none match.
 */
function findOrphanForUuid(uuid: string): string | null {
  const exact = join(SESSIONS_DIR, `${uuid}.json`);
  if (existsSync(exact)) return exact;
  let orphans: string[] = [];
  try {
    orphans = readdirSync(SESSIONS_DIR).filter(
      (f) => f.startsWith("claude-") && f.endsWith(".json")
    );
  } catch {
    return null;
  }
  for (const orphan of orphans) {
    const path = join(SESSIONS_DIR, orphan);
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        sessionInfo?: { claudeSessionId?: string };
      };
      if (data.sessionInfo?.claudeSessionId === uuid) {
        return path;
      }
    } catch {
      // skip unreadable orphan
    }
  }
  return null;
}

/**
 * Resolve the Claude session UUID even when CLAUDE_CODE_SESSION_ID is not in
 * our env. The harness writes `~/.claude/sessions/<pid>.json` containing
 * `{ sessionId, cwd }` for each live Claude process; reading it gives us the
 * stable session UUID so we can survive restarts (PID changes, UUID does not).
 */
function resolveClaudeSessionIdFromPid(pid: string | null): string | null {
  if (!pid) return null;
  const path = join(homedir(), ".claude", "sessions", `${pid}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { sessionId?: string };
    return raw.sessionId ?? null;
  } catch {
    return null;
  }
}

// Session identity. When CLAUDE_CODE_SESSION_ID is present we know everything at
// import with no side effects. When it is absent the PID walk + orphan scan are
// deferred to initServerRuntime() (called by the server entrypoint) so merely
// importing this module never forks `ps` or scans the sessions dir. The values
// below are `let` so initServerRuntime() can fill them in, and consumers read
// the live ESM bindings.
let CLAUDE_PARENT_PID: string | null = null;
let RESOLVED_SESSION_ID: string | null = CLAUDE_SESSION_ID || null;
export let SESSION_KEY: string = CLAUDE_SESSION_ID || "default";

// Mutable so we can promote a PID-keyed file to a UUID-keyed one once the
// UUID becomes known via observeClaudeSession (race when sessions/<pid>.json
// is written by Claude after the MCP child has already started).
let STATE_FILE = stateFileFor(SESSION_KEY);

function stateFileFor(key: string): string {
  return key === "default" &&
    existsSync(LEGACY_STATE_FILE) &&
    !existsSync(join(SESSIONS_DIR, "default.json"))
    ? LEGACY_STATE_FILE
    : join(SESSIONS_DIR, `${key}.json`);
}

/**
 * One-shot migration: if we resolved to a UUID-based SESSION_KEY but the
 * state file does not exist yet, look for a PID-keyed orphan whose
 * sessionInfo.claudeSessionId matches us, and adopt it.
 */
function adoptOrphanedStateFile(targetKey: string): void {
  const target = join(SESSIONS_DIR, `${targetKey}.json`);
  if (existsSync(target)) return;
  // UUID looks like 5-segment hex; only run migration in that case.
  if (!isUuid(targetKey)) return;
  const source = findOrphanForUuid(targetKey);
  if (source && source !== target) {
    try {
      renameSync(source, target);
    } catch {
      // best-effort
    }
  }
}

/**
 * Resolve session identity and adopt any orphaned state file, then (re)load the
 * Store from disk. Called once by the server entrypoint during startup. This is
 * where the `ps`/exec parent-PID walk and the sessions-dir orphan scan run, so
 * importing this module (e.g. from a test or a tool) never forks child
 * processes or touches the sessions dir. Idempotent and a no-op when
 * CLAUDE_CODE_SESSION_ID is already set (identity is fully known at import).
 */
export function initServerRuntime(): void {
  if (CLAUDE_SESSION_ID) {
    // Identity already resolved at import, nothing deferred to do.
    return;
  }
  CLAUDE_PARENT_PID = findClaudeParentPid(process.ppid);
  RESOLVED_SESSION_ID =
    CLAUDE_SESSION_ID || resolveClaudeSessionIdFromPid(CLAUDE_PARENT_PID);
  SESSION_KEY = RESOLVED_SESSION_ID
    ? RESOLVED_SESSION_ID
    : CLAUDE_PARENT_PID
      ? `claude-${CLAUDE_PARENT_PID}`
      : "default";
  adoptOrphanedStateFile(SESSION_KEY);
  STATE_FILE = stateFileFor(SESSION_KEY);
  SESSION_PORT_FILE = join(SESSIONS_DIR, `${SESSION_KEY}.port`);
  store.reloadFromDisk();
}

/**
 * Called when observeClaudeSession learns the real UUID. Renames the on-disk
 * state and port files to match the new UUID so the dashboard, hooks, and
 * session switcher all key off the same identifier. Handles three cases:
 *
 *   1. PID-keyed -> UUID-keyed (initial race: sessions/<pid>.json not yet
 *      written when the MCP started, hook later supplies UUID).
 *   2. UUID-A -> UUID-B (Claude rewrote sessions/<pid>.json with a different
 *      UUID, e.g. on /resume or session switch).
 *   3. No-op when already correct.
 *
 * Updates STATE_FILE and SESSION_PORT_FILE in place. Idempotent.
 */
function promoteStateFileToUuid(uuid: string): void {
  if (!isUuid(uuid)) return;
  const targetState = join(SESSIONS_DIR, `${uuid}.json`);
  const targetPort = join(SESSIONS_DIR, `${uuid}.port`);
  if (STATE_FILE === targetState && SESSION_PORT_FILE === targetPort) return;

  const renameIfNeeded = (from: string, to: string): void => {
    if (from === to) return;
    try {
      if (existsSync(to)) {
        // Target already exists. Don't clobber — just point at it.
        return;
      }
      if (existsSync(from)) {
        renameSync(from, to);
      }
    } catch {
      // best-effort
    }
  };

  renameIfNeeded(STATE_FILE, targetState);
  STATE_FILE = targetState;

  renameIfNeeded(SESSION_PORT_FILE, targetPort);
  SESSION_PORT_FILE = targetPort;
}
// Mutable so promoteStateFileToUuid can rename it when the session UUID
// changes mid-process. Consumers (e.g. tools/open.ts) import this live
// `SESSION_PORT_FILE` binding directly: ESM keeps it current after the
// reassignment, so no accessor is needed.
export let SESSION_PORT_FILE = join(SESSIONS_DIR, `${SESSION_KEY}.port`);
export const SESSIONS_PATH = SESSIONS_DIR;

interface LegacyLogEntry {
  timestamp: string;
  message: string;
}

interface MaybeLegacyState {
  sessionId?: string;
  rows?: Row[];
  activities?: Activity[];
  logs?: LegacyLogEntry[];
  pendingQuestion?: PendingQuestion | null;
  port?: number | null;
  startedAt?: string;
  sessionInfo?: SessionInfo;
  tokenStats?: TokenStats | null;
  memoryEntries?: MemoryEntry[];
}

function migrate(raw: MaybeLegacyState): DashboardState {
  const activities: Activity[] =
    raw.activities ??
    (raw.logs ?? []).map((l) => ({
      kind: "log" as const,
      id: randomUUID(),
      timestamp: l.timestamp,
      message: l.message,
    }));
  const sessionInfo: SessionInfo = { ...(raw.sessionInfo ?? {}) };
  if (!sessionInfo.userName) {
    sessionInfo.userName = currentUserName();
  }
  // Backfill missing duration timestamps for rows that pre-date the feature.
  // - in_progress without startedAt: start the timer from now (best we can do).
  // - completed/failed without endedAt: stamp end = start so duration > 0 if
  //   we have a start, otherwise leave both undefined so the UI shows "—".
  const nowIso = new Date().toISOString();
  const rows: Row[] = (raw.rows ?? []).map((r) => {
    const next: Row = { ...r };
    if (next.status === "in_progress" && !next.startedAt) {
      next.startedAt = nowIso;
    }
    if (isTerminalStatus(next.status) && next.startedAt && !next.endedAt) {
      next.endedAt = nowIso;
    }
    return next;
  });
  return {
    sessionId: raw.sessionId ?? randomUUID(),
    rows,
    activities,
    pendingQuestion: null,
    pendingPermission: null,
    port: raw.port ?? null,
    startedAt: raw.startedAt ?? new Date().toISOString(),
    sessionInfo,
    tokenStats: raw.tokenStats ?? null,
    memoryEntries: raw.memoryEntries ?? [],
  };
}

export class Store {
  state: DashboardState;
  private listeners = new Set<Listener>();
  // Machine subscribers (the hub's fleet tail, connected with ?role=mirror).
  // They receive every event but never count as watchers: a hub connection
  // alone must not convince the gate that a human can see a prompt.
  private mirrorListeners = new Set<Listener>();
  // Remote-watcher heartbeat from the hub ("N humans can see this session
  // through me"). Counts toward hasWatchers() only while fresh, so a dead hub
  // simply stops counting.
  private remoteWatchers = 0;
  private remoteWatchersAt = 0;
  // Live-only workflow mirror (see WorkflowMirror). Held off this.state so
  // persist() never writes it to disk; injected in snapshot() like dailyActivity.
  private workflowMirror: WorkflowMirror[] = [];
  private workflowMirrorJson = "[]";
  // Live-only `claude agents --json` mirror (see AgentSessionMirror).
  private agentSessions: AgentSessionMirror[] = [];
  private agentSessionsJson = "[]";
  // Cached native-alert pref, loaded from the shared NATIVE_PREF_FILE and kept
  // in sync across processes by a file watcher (see watchNativePref). null = no
  // choice made yet → opt-in default OFF. The file, not this field, is the
  // source of truth, so disabling on one dashboard sticks for every port and
  // every restart.
  private nativePref: boolean | null = readNativePref();
  // Most recent orchestrator Skill target, used to name a new dashboard run by
  // its goal instead of "Run N" (see currentRunTitle / addRow).
  private lastSkillTarget: string | null = null;
  private pendingResolvers = new Map<
    string,
    {
      resolve: (value: { ok: true; answer: string }) => void;
      timer: NodeJS.Timeout;
      macHandle?: MacAlertHandle;
    }
  >();
  private permissionResolvers = new Map<
    string,
    {
      resolve: (value: { decision: PermissionDecision } | { decision: "timeout" }) => void;
      timer: NodeJS.Timeout;
      macHandle?: MacAlertHandle;
    }
  >();
  // Debounced-persist bookkeeping: persist() marks the state dirty and arms a
  // single timer, flush() does the actual async temp-file write + atomic rename.
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor() {
    // Loads from STATE_FILE keyed by the import-time SESSION_KEY (env-only when
    // CLAUDE_CODE_SESSION_ID is set, else the "default" placeholder). This is fs
    // only, no child-process side effects. When the session id has to be derived
    // from the PID, initServerRuntime() re-resolves the key and calls
    // reloadFromDisk() to pick up the real per-session file.
    this.state = this.load();
    this.watchNativePref();
  }

  /**
   * Re-read the on-disk state into memory using the current STATE_FILE. Called
   * by initServerRuntime() after it resolves a PID-derived SESSION_KEY (and any
   * orphan adoption), so the in-memory state matches the real per-session file.
   */
  reloadFromDisk(): void {
    this.state = this.load();
  }

  private load(): DashboardState {
    // 1. Per-session file wins.
    if (existsSync(STATE_FILE)) {
      try {
        const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as MaybeLegacyState;
        const migrated = migrate(raw);
        if (CLAUDE_SESSION_ID) {
          migrated.sessionInfo.claudeSessionId = CLAUDE_SESSION_ID;
        }
        return migrated;
      } catch {
        // fall through to fresh
      }
    }
    // 2. Legacy one-time migration: only if NO per-session file exists yet for
    //    any session. This prevents new sessions from inheriting old data.
    if (existsSync(LEGACY_STATE_FILE)) {
      const existingPerSession = readdirSync(SESSIONS_DIR).some((f) => f.endsWith(".json"));
      if (!existingPerSession) {
        try {
          const raw = JSON.parse(readFileSync(LEGACY_STATE_FILE, "utf8")) as MaybeLegacyState;
          const migrated = migrate(raw);
          if (CLAUDE_SESSION_ID) migrated.sessionInfo.claudeSessionId = CLAUDE_SESSION_ID;
          try {
            renameSync(LEGACY_STATE_FILE, LEGACY_STATE_FILE + ".migrated");
          } catch {
            // best-effort
          }
          return migrated;
        } catch {
          // fall through
        }
      }
    }
    return this.fresh();
  }

  private fresh(): DashboardState {
    const projectDir = process.env["CLAUDE_PROJECT_DIR"] || undefined;
    const projectBasename = projectDir ? projectDir.split("/").filter(Boolean).pop() : undefined;
    return {
      sessionId: CLAUDE_SESSION_ID || SESSION_KEY,
      rows: [],
      activities: [],
      pendingQuestion: null,
      pendingPermission: null,
      port: null,
      startedAt: new Date().toISOString(),
      sessionInfo: {
        userName: currentUserName(),
        claudeSessionId: RESOLVED_SESSION_ID || undefined,
        cwd: projectDir,
        cwdBasename: projectBasename,
      },
      tokenStats: null,
      memoryEntries: [],
    };
  }

  /**
   * Mark the in-memory state dirty and arm the debounced flush. The caller's
   * mutation and broadcast() have already happened synchronously, so the
   * dashboard and /state reflect the change immediately; only the disk write is
   * deferred. The timer is unref'd so it never keeps the process alive.
   */
  private persist(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.flushTimer.unref();
  }

  /**
   * Write the current state to disk: serialize once (no pretty-print, the file
   * is machine-read), write to a temp file, then atomic-rename over the target.
   * Coalesces concurrent calls so only one write runs at a time.
   */
  private async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const target = STATE_FILE;
    const tmp = `${target}.tmp`;
    const run = (async (): Promise<void> => {
      try {
        await writeFileAsync(tmp, JSON.stringify(this.state));
        await renameAsync(tmp, target);
      } catch (err) {
        this.appendWarning(`persist failed: ${(err as Error).message}`);
      }
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      if (this.flushing === run) this.flushing = null;
    }
  }

  /**
   * Synchronous best-effort flush for process-exit handlers, where async work
   * cannot finish. Mirrors flush() but blocking, so a graceful shutdown
   * (SIGINT/SIGTERM/SIGHUP or the parent-PID watchdog) persists the last
   * debounced mutations the way the old synchronous persist always did. No-op
   * when nothing is pending.
   */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const target = STATE_FILE;
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, target);
    } catch (err) {
      this.appendWarning(`persist (sync) failed: ${(err as Error).message}`);
    }
  }

  snapshot(): DashboardState {
    return {
      ...this.state,
      dailyActivity: readDailyActivity(),
      workflows: this.workflowMirror,
      agentSessions: this.agentSessions,
      nativeAlerts: this.nativeAlertsEnabled(),
      nativeSupported: process.platform === "darwin",
      notifications: readNotifications(),
      clients: this.listeners.size,
    };
  }

  /** Number of live SSE subscribers (open dashboard tabs, mirrors excluded). */
  clientCount(): number {
    return this.listeners.size;
  }

  /**
   * Record the hub's remote-watcher heartbeat. The hub re-posts every
   * HEARTBEAT interval while it has real clients; the freshness window below
   * makes a crashed hub decay to zero without any explicit teardown.
   */
  setRemoteWatchers(count: number): void {
    this.remoteWatchers = count;
    this.remoteWatchersAt = Date.now();
  }

  /** Remote watchers reported by the hub, zero once the heartbeat goes stale. */
  remoteWatcherCount(): number {
    if (this.remoteWatchers <= 0) return 0;
    return Date.now() - this.remoteWatchersAt <= REMOTE_WATCHER_TTL_MS ? this.remoteWatchers : 0;
  }

  /**
   * Whether a question or permission routed to Murmur would actually reach a
   * human: a dashboard tab is connected, the native macOS alert channel is
   * on, or the hub reports fresh remote watchers (a fleet tab is open). When
   * this is false the CLI prompt is the only channel the user can see, so
   * callers (the murmur_ask tool, the question/permission hooks via
   * GET /watchers) must not suppress it.
   */
  hasWatchers(): boolean {
    return this.listeners.size > 0 || this.nativeAlertsEnabled() || this.remoteWatcherCount() > 0;
  }

  // Routine notifications. These persist to the shared notifications.json (not
  // the per-session state file), so they survive across sessions and show in
  // every pane. Each mutation broadcasts so open panes update live.
  addNotification(input: NotificationInput): Notification {
    const n = appendNotificationToDisk(input);
    this.broadcast();
    return n;
  }

  markNotificationRead(id: string, read: boolean): boolean {
    const ok = setNotificationReadOnDisk(id, read);
    if (ok) this.broadcast();
    return ok;
  }

  dismissNotification(id: string): boolean {
    const ok = dismissNotificationOnDisk(id);
    if (ok) this.broadcast();
    return ok;
  }

  // Deliver an event to every subscriber, human tabs and mirrors alike.
  private deliver(event: StateEvent): void {
    for (const set of [this.listeners, this.mirrorListeners]) {
      for (const listener of set) {
        try {
          listener(event);
        } catch {
          // listener errors are non-fatal
        }
      }
    }
  }

  private broadcast(): void {
    this.deliver({ type: "state", state: this.snapshot() });
  }

  subscribe(listener: Listener, opts?: { mirror?: boolean }): () => void {
    const set = opts?.mirror ? this.mirrorListeners : this.listeners;
    set.add(listener);
    listener({ type: "state", state: this.snapshot() });
    return () => set.delete(listener);
  }

  emitHeartbeat(): void {
    this.deliver({ type: "heartbeat", at: new Date().toISOString() });
  }

  appendWarning(message: string): void {
    const at = new Date().toISOString();
    try {
      const line = `${at} ${message}\n`;
      writeFileSync(WARNINGS_LOG, line, { flag: "a" });
    } catch {
      // can't even log; nothing we can do
    }
    this.addActivity({
      kind: "warn",
      id: randomUUID(),
      timestamp: at,
      message,
    });
    this.deliver({ type: "warning", message, at });
  }

  reset(): void {
    this.state = this.fresh();
    this.persist();
    this.broadcast();
  }

  setPort(port: number): void {
    this.state.port = port;
    // Mirror to <uuid>.port if the session UUID is already known so hooks
    // resolve the right murmur regardless of which call (setPort vs
    // observeClaudeSession) fires first.
    const sid = this.state.sessionInfo.claudeSessionId;
    if (sid && isUuid(sid)) {
      try {
        writeFileSync(join(SESSIONS_DIR, `${sid}.port`), String(port));
      } catch {
        // best-effort
      }
    }
    this.persist();
    this.broadcast();
  }

  setTokenStats(stats: TokenStats): void {
    this.state.tokenStats = stats;
    if (stats.model && !this.state.sessionInfo.model) {
      this.state.sessionInfo.model = stats.model;
    }
    this.warnUnknownModel(stats.model);
    this.persist();
    this.broadcast();
  }

  // Models already warned about, so the transcript poll doesn't repeat the
  // warning on every sync tick.
  private warnedModels = new Set<string>();

  /**
   * Surface model-registry drift the moment a transcript names a model that
   * src/model-caps.ts does not know. Without this the context gauge and the
   * cost estimate silently run on fallback numbers (200K window, Sonnet
   * rates), which is exactly the failure the registry exists to prevent.
   */
  private warnUnknownModel(model?: string): void {
    if (!model || this.warnedModels.has(model) || isKnownModel(model)) return;
    this.warnedModels.add(model);
    this.appendWarning(
      `Model "${model}" is not in the model registry (src/model-caps.ts). Context window and cost are falling back to defaults and may be wrong. Add it to CONTEXT_LIMITS and PRICING, then rebuild.`
    );
  }

  setMemoryEntries(entries: MemoryEntry[]): void {
    this.state.memoryEntries = entries;
    this.persist();
    this.broadcast();
  }

  /**
   * Replace the mirrored Claude Code dynamic-workflow runs. Live-only: this
   * never persists (the wf_<id>.json / journal files on disk are the durable
   * source of truth). Deep-equal short-circuits so a no-change tailer tick
   * does not spam SSE listeners.
   */
  setWorkflowMirror(list: WorkflowMirror[]): void {
    const next = JSON.stringify(list);
    if (next === this.workflowMirrorJson) return;
    this.workflowMirror = list;
    this.workflowMirrorJson = next;
    this.broadcast();
  }

  /**
   * Replace the mirrored `claude agents --json` sessions. Live-only; deep-equal
   * short-circuits so an unchanged poll tick does not spam SSE listeners.
   */
  setAgentSessions(list: AgentSessionMirror[]): void {
    const next = JSON.stringify(list);
    if (next === this.agentSessionsJson) return;
    this.agentSessions = list;
    this.agentSessionsJson = next;
    this.broadcast();
  }

  /** OTEL_RESOURCE_ATTRIBUTES dimensions for this session (team, repo, …). */
  setResourceAttributes(attrs: Record<string, string>): void {
    if (Object.keys(attrs).length === 0) return;
    this.state.sessionInfo.resourceAttributes = attrs;
    this.persist();
    this.broadcast();
  }

  /**
   * Whether the native macOS alert modal should fire. Opt-in and persisted: the
   * dashboard toggle writes a shared pref file (NATIVE_PREF_FILE); an absent file
   * means OFF. That file is the single source of truth across restarts and every
   * port, so the modal can't reappear on a process the user never enabled it on.
   */
  nativeAlertsEnabled(): boolean {
    if (process.platform !== "darwin") return false;
    // Opt-in: OFF until explicitly enabled from a dashboard. MURMUR_MAC_MODAL is
    // no longer consulted — that env-forced default was what made the modal come
    // back on fresh processes and second ports the user thought they'd disabled.
    return this.nativePref ?? false;
  }

  /**
   * Toggle the native macOS alert modal from the alert chooser. Persists to the
   * shared pref file so the choice is durable across restarts and shared by every
   * Murmur server; the file watcher then propagates it to other live servers.
   */
  setNativeAlerts(enabled: boolean): void {
    writeNativePref(enabled);
    this.nativePref = enabled;
    this.broadcast();
  }

  // Watch the shared pref file so a toggle on ANY Murmur server (any port) is
  // reflected here: re-read the cache and rebroadcast so this server's mac-modal
  // gate and its dashboards both track the latest choice. Watching the directory
  // (not the file) tolerates the file not existing yet.
  private watchNativePref(): void {
    try {
      watch(STATE_DIR, (_event, filename) => {
        if (filename !== "native-alert.pref") return;
        const next = readNativePref();
        if (next === this.nativePref) return;
        this.nativePref = next;
        this.broadcast();
      });
    } catch {
      // fs.watch unsupported here; the gate still reads the cached value, just
      // without cross-process push — each server loads the file fresh on startup.
    }
  }

  /** Lean accessor for the workflow tailer: avoids a full snapshot() each tick. */
  sessionContext(): { cwd?: string; claudeSessionId?: string } {
    return {
      cwd: this.state.sessionInfo.cwd,
      claudeSessionId: this.state.sessionInfo.claudeSessionId,
    };
  }

  /**
   * Records the active Claude Code session id. On first observation, or when
   * the id changes, also resets claudeSessionStartedAt so downstream filters
   * (e.g. memory "this session" detection) work correctly.
   */
  /**
   * Start polling sessions/<parentPid>.json for sessionId changes. Claude
   * Code is allowed to mutate its own sessionId (e.g. on /resume or session
   * switch). The MCP must catch up so the dashboard renders the right
   * transcript metadata.
   */
  startSessionIdPolling(): void {
    if (!CLAUDE_PARENT_PID) return;
    const path = join(homedir(), ".claude", "sessions", `${CLAUDE_PARENT_PID}.json`);
    const tick = (): void => {
      try {
        if (!existsSync(path)) return;
        const raw = JSON.parse(readFileSync(path, "utf8")) as { sessionId?: string };
        const sid = raw.sessionId;
        if (sid && sid !== this.state.sessionInfo.claudeSessionId) {
          this.observeClaudeSession(sid);
        }
      } catch {
        // best-effort
      }
    };
    tick(); // fire once right away
    const id = setInterval(tick, 5_000);
    id.unref();
  }

  observeClaudeSession(sessionId: string): boolean {
    if (this.state.sessionInfo.claudeSessionId === sessionId) {
      return false;
    }
    this.state.sessionInfo.claudeSessionId = sessionId;
    this.state.sessionInfo.claudeSessionStartedAt = new Date().toISOString();
    // If we are currently writing to a PID-keyed file and an orphan with this
    // UUID exists with richer history than our (likely empty) in-memory state,
    // adopt it instead of clobbering it.
    const adopted = this.adoptOrphanIfRicher(sessionId);
    if (!adopted) {
      promoteStateFileToUuid(sessionId);
    }
    // Self-heal the port binding: write <uuid>.port unconditionally so hooks
    // (precompact, stop, mirror) can resolve our port even when promote's
    // rename was a no-op (source missing on resume, target already present,
    // or session-id polling never observing the new UUID in this process).
    // Without this, /compact and Stop hooks silently exit on resumed
    // sessions and the dashboard's tokenStats stays frozen.
    if (this.state.port && isUuid(sessionId)) {
      try {
        writeFileSync(
          join(SESSIONS_DIR, `${sessionId}.port`),
          String(this.state.port)
        );
      } catch {
        // best-effort
      }
    }
    this.persist();
    this.broadcast();
    return true;
  }

  /**
   * On first observation of the session UUID, look for a previous-session
   * state file (UUID match) and adopt it if it carries more history than the
   * fresh in-memory state. Any in-memory activities newer than the disk
   * state's latest activity are spliced in so SessionStart hooks etc. that
   * fired before observation are not lost.
   *
   * Returns true if adoption happened.
   */
  private adoptOrphanIfRicher(uuid: string): boolean {
    if (!isUuid(uuid)) return false;
    const target = join(SESSIONS_DIR, `${uuid}.json`);
    // Prefers an exact <uuid>.json, else the first claude-*.json whose
    // sessionInfo.claudeSessionId matches (shared with adoptOrphanedStateFile).
    const source = findOrphanForUuid(uuid);
    if (!source) return false;
    let raw: MaybeLegacyState;
    try {
      raw = JSON.parse(readFileSync(source, "utf8")) as MaybeLegacyState;
    } catch {
      return false;
    }
    const diskActivities = raw.activities?.length ?? 0;
    const diskRows = raw.rows?.length ?? 0;
    const memActivities = this.state.activities.length;
    const memRows = this.state.rows.length;
    // Only adopt if disk has strictly more material than memory. Equal or
    // weaker disk content stays untouched so we never overwrite progress
    // accumulated in this process.
    if (diskActivities + diskRows <= memActivities + memRows) return false;
    try {
      const adopted = migrate(raw);
      adopted.sessionInfo.claudeSessionId = uuid;
      // Preserve in-memory activities whose timestamps are newer than the
      // latest disk activity (e.g. the SessionStart hook fired before
      // observation).
      const latestDiskMs = adopted.activities.reduce((max, a) => {
        const t = Date.parse(a.timestamp);
        return Number.isFinite(t) && t > max ? t : max;
      }, 0);
      const carryOver = this.state.activities.filter((a) => {
        const t = Date.parse(a.timestamp);
        return Number.isFinite(t) && t > latestDiskMs;
      });
      adopted.activities = adopted.activities.concat(carryOver);
      if (adopted.activities.length > MAX_ACTIVITIES) {
        adopted.activities = adopted.activities.slice(-MAX_ACTIVITIES);
      }
      this.state = adopted;
      if (source !== target) {
        try {
          renameSync(source, target);
        } catch {
          // best-effort
        }
      }
      const oldPidFile = STATE_FILE;
      STATE_FILE = target;
      if (
        oldPidFile !== target &&
        /\/claude-\d+\.json$/.test(oldPidFile) &&
        existsSync(oldPidFile)
      ) {
        try {
          unlinkSync(oldPidFile);
        } catch {
          // best-effort
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  setSessionInfo(partial: Partial<SessionInfo>): void {
    // cwd / cwdBasename are pinned to CLAUDE_PROJECT_DIR if set, so the hook
    // can't accidentally overwrite them with a transient subdir cwd.
    const projectDir = process.env["CLAUDE_PROJECT_DIR"] || undefined;
    let changed = false;
    for (const k of Object.keys(partial) as (keyof SessionInfo)[]) {
      const v = partial[k];
      if (v === undefined) continue;
      if (projectDir && (k === "cwd" || k === "cwdBasename")) continue;
      if (this.state.sessionInfo[k] !== v) {
        (this.state.sessionInfo as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
      this.broadcast();
    }
  }

  initRows(labels: string[], title?: string): void {
    // Each call starts a NEW run and appends it. It no longer replaces the
    // existing rows or clears the activity feed, so multiple dashboards can
    // coexist in one session without mixing.
    const runId = randomUUID();
    const runTitle = title ?? this.currentRunTitle();
    const newRows: Row[] = labels.map((label, i) => ({
      id: randomUUID(),
      label,
      status: "pending" as RowStatus,
      runId,
      runTitle: i === 0 ? runTitle : undefined,
    }));
    this.state.rows.push(...newRows);
    this.persist();
    this.broadcast();
  }

  /**
   * Best-effort goal for a newly-started dashboard run, so the UI names it by
   * its goal instead of "Run N". Uses the active orchestrator skill (e.g.
   * "pr-reviewer"); the infra skills that DRIVE the dashboard (progress-dashboard,
   * murmur) are ignored so a run is never named after its own plumbing. Returns
   * undefined when there's no signal — the UI then falls back to the first
   * row's label.
   */
  private currentRunTitle(): string | undefined {
    return this.lastSkillTarget ?? undefined;
  }

  addRow(label: string, title?: string): void {
    const rows = this.state.rows;
    // A fresh batch of phases after every prior row has finished marks the start
    // of a new run. While a run is still active, new rows join it.
    const allTerminal = rows.length === 0 || rows.every((r) => isTerminalStatus(r.status));
    if (allTerminal) {
      rows.push({
        id: randomUUID(),
        label,
        status: "pending",
        runId: randomUUID(),
        runTitle: title ?? this.currentRunTitle(),
      });
    } else {
      const runId = rows[rows.length - 1]!.runId;
      // Dedup only within the active run, so the same phase name can recur across runs.
      if (rows.some((r) => r.runId === runId && r.label === label)) {
        return;
      }
      rows.push({ id: randomUUID(), label, status: "pending", runId });
    }
    this.persist();
    this.broadcast();
  }

  updateRow(label: string, status: RowStatus, detail?: string): boolean {
    // Target the newest matching row so an update lands on the active run, not a
    // finished earlier run that happened to reuse the same phase name.
    let row: Row | undefined;
    for (let i = this.state.rows.length - 1; i >= 0; i--) {
      if (this.state.rows[i]!.label === label) {
        row = this.state.rows[i];
        break;
      }
    }
    if (!row) {
      return false;
    }
    const prevStatus = row.status;
    row.status = status;
    if (detail !== undefined) {
      row.detail = detail;
    }
    const now = new Date().toISOString();
    // Stamp startedAt whenever the row enters in_progress from another state so
    // it always marks the CURRENT run's start. useStuckDetection reads startedAt
    // as the row's last status change, so a row that resumes after finishing
    // must restart this clock — otherwise it inherits the old start time and
    // fires a false "stalled" warning the instant it resumes. Also stamp it on a
    // direct pending -> terminal jump so a start time always exists.
    if (status === "in_progress" && prevStatus !== "in_progress") {
      row.startedAt = now;
    } else if (!row.startedAt && status !== "pending") {
      row.startedAt = now;
    }
    // Reached a terminal state: stamp the end (idempotent).
    if (isTerminalStatus(status) && !row.endedAt) {
      row.endedAt = now;
    }
    // Moved back into in_progress (rare): clear the stale end so the timer ticks
    // again for the resumed run.
    if (status === "in_progress" && row.endedAt) {
      row.endedAt = undefined;
    }
    this.persist();
    this.broadcast();
    return true;
  }

  // Skills that drive the dashboard rather than represent a run's goal. A run
  // is never auto-named after these (see currentRunTitle).
  private static readonly INFRA_SKILLS = new Set(["progress-dashboard", "murmur"]);

  addActivity(activity: Activity): void {
    // Track the active orchestrator skill for run titling. A Skill tool
    // activity's target is "<skill> [args]"; take the skill name and ignore the
    // infra skills so a run is named by its real goal, not its plumbing.
    if (activity.kind === "tool" && activity.tool === "Skill" && activity.target) {
      const skill = activity.target.trim().split(/\s+/)[0]!;
      if (skill && !Store.INFRA_SKILLS.has(skill)) this.lastSkillTarget = skill;
    }
    this.state.activities.push(activity);
    // Bounded ring: drop the oldest in place instead of reallocating a fresh
    // 3000-element array on every push once the cap is reached. Single-push
    // ingestion only ever goes one over, so this trims back to exactly the cap.
    while (this.state.activities.length > MAX_ACTIVITIES) {
      this.state.activities.shift();
    }
    this.persist();
    this.broadcast();
  }

  /**
   * Merge images into an existing prompt activity, deduped by image id. Used by
   * the transcript scan when it finds images on a prompt the UserPromptSubmit
   * hook already recorded text-only (the hook never sees attachments): rather
   * than dropping the image-bearing copy as a duplicate, fold its images into
   * the row already on screen. Returns true when something new was added.
   */
  mergeActivityImages(id: string, images: ActivityImage[]): boolean {
    if (images.length === 0) return false;
    const a = this.state.activities.find((x) => x.id === id);
    if (!a || a.kind !== "prompt") return false;
    const existing = a.images ?? [];
    const seen = new Set(existing.map((im) => im.id));
    const merged = existing.slice();
    for (const im of images) {
      if (!seen.has(im.id)) {
        merged.push(im);
        seen.add(im.id);
      }
    }
    if (merged.length === existing.length) return false;
    a.images = merged;
    this.persist();
    this.broadcast();
    return true;
  }

  /** Convenience wrapper kept for the murmur_log tool. */
  appendLog(message: string): void {
    this.addActivity({
      kind: "log",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message,
    });
  }

  private macAlertSession(): string | undefined {
    const info = this.state.sessionInfo;
    let cid = info.claudeSessionId;
    let cwd = info.cwd;
    if (!cid) {
      const m = SESSION_KEY.match(/^claude-(\d+)$/);
      if (m) {
        const lookup = pidToSessionId(parseInt(m[1]!, 10));
        cid = lookup.sessionId;
        cwd = cwd ?? lookup.cwd;
      }
    }
    const resolved = cid && cwd ? resolveSessionTitle(cid, cwd) : {};
    return resolved.title?.trim() || undefined;
  }

  private macAlertTitle(kind: string, session: string | undefined): string {
    return session ? `Murmur · ${session} · ${kind}` : `Murmur · ${kind}`;
  }

  setPendingQuestion(
    question: PendingQuestion,
    timeoutMs: number
  ): Promise<{ ok: true; answer: string } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      // The pane shows one question at a time. If one is already awaiting an
      // answer, reject this new ask rather than overwriting the slot —
      // overwriting would hide the first question while leaving its resolver
      // armed, stranding that caller (invisibly) until its full timeout elapsed.
      if (this.state.pendingQuestion || this.pendingResolvers.size > 0) {
        resolve({ ok: false, reason: "busy" });
        return;
      }
      const timer = setTimeout(() => {
        const entry = this.pendingResolvers.get(question.questionId);
        if (entry) {
          entry.macHandle?.kill();
          this.pendingResolvers.delete(question.questionId);
          this.state.pendingQuestion = null;
          // Leave a trace: the card just vanished with no human input, and
          // Claude will continue on its own. Without this row the timeout is
          // invisible in the feed and the user never learns a decision was
          // made without them.
          this.addActivity({
            kind: "prompt",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            source: "murmur",
            question: question.question,
            answer: "(timed out with no answer, Claude continued)",
            ok: false,
          });
          this.persist();
          this.broadcast();
          resolve({ ok: false, reason: "timeout" });
        }
      }, timeoutMs);

      let macHandle: MacAlertHandle | undefined;
      // Skip multi-select for now (the modal is single-answer). Otherwise
      // the SwiftUI backend handles any option count; the AppleScript
      // fallback caps at 3.
      const canShowMacModal = this.nativeAlertsEnabled() && !question.multiSelect;
      if (canShowMacModal) {
        const session = this.macAlertSession();
        macHandle = spawnMacAlert(
          buildQuestionAlert(
            question,
            this.macAlertTitle(question.header ?? "Question", session),
            session
          ),
          (answer) => {
            if (answer === "__cancel") {
              this.cancelPending(question.questionId);
              return;
            }
            const match = question.options.find((o) => o.label === answer);
            // For options the value is the label; for custom input it's
            // whatever the user typed. Either way, return it as-is.
            this.resolvePending(question.questionId, match ? match.label : answer);
          }
        );
      }

      this.pendingResolvers.set(question.questionId, {
        resolve: resolve as (value: { ok: true; answer: string }) => void,
        timer,
        macHandle,
      });
      this.state.pendingQuestion = question;
      this.persist();
      this.broadcast();
    });
  }

  resolvePending(questionId: string, answer: string): boolean {
    const entry = this.pendingResolvers.get(questionId);
    if (!entry) {
      return false;
    }
    const question = this.state.pendingQuestion?.question ?? "(question)";
    clearTimeout(entry.timer);
    entry.macHandle?.kill();
    this.pendingResolvers.delete(questionId);
    this.state.pendingQuestion = null;
    this.addActivity({
      kind: "prompt",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: "murmur",
      question,
      answer,
      ok: true,
    });
    entry.resolve({ ok: true, answer });
    return true;
  }

  cancelPending(questionId: string): boolean {
    const entry = this.pendingResolvers.get(questionId);
    if (!entry) {
      return false;
    }
    const question = this.state.pendingQuestion?.question ?? "(question)";
    clearTimeout(entry.timer);
    entry.macHandle?.kill();
    this.pendingResolvers.delete(questionId);
    this.state.pendingQuestion = null;
    this.addActivity({
      kind: "prompt",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: "murmur",
      question,
      ok: false,
    });
    (entry.resolve as unknown as (v: { ok: false; reason: string }) => void)({
      ok: false,
      reason: "cancelled",
    });
    return true;
  }

  askPermission(
    request: { tool: string; command: string; cwd?: string },
    timeoutMs: number
  ): Promise<{ decision: PermissionDecision } | { decision: "timeout" }> {
    // A tool with no shell command (Read/Edit/…) can arrive with `command`
    // stringified as "null"/"undefined". Normalize once at ingestion so the
    // mac alert, classifier, activity row and question all see a clean value.
    const command =
      request.command == null || request.command === "null" || request.command === "undefined"
        ? ""
        : request.command;
    const req = { ...request, command };
    return new Promise((resolve) => {
      // Single-slot pane (see setPendingQuestion): if a permission prompt is
      // already pending, don't displace it. Signal "timeout" so this second
      // request falls back to the harness's own CLI prompt rather than stranding
      // the first prompt invisibly until its timeout.
      if (this.state.pendingPermission || this.permissionResolvers.size > 0) {
        resolve({ decision: "timeout" });
        return;
      }
      const permissionId = randomUUID();
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
      const classification = classifyPermission(req);
      const pending: PendingPermission = {
        permissionId,
        tool: req.tool,
        command,
        cwd: req.cwd,
        createdAt,
        expiresAt,
        classification,
      };
      const timer = setTimeout(() => {
        const entry = this.permissionResolvers.get(permissionId);
        if (entry) {
          entry.macHandle?.kill();
          this.permissionResolvers.delete(permissionId);
          this.state.pendingPermission = null;
          // Trace the silent hand-back: the modal vanished unanswered and the
          // hook falls through to the terminal's own permission dialog.
          this.addActivity({
            kind: "prompt",
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            source: "permission",
            question: command ? `${req.tool} · ${command}` : req.tool,
            answer: "(timed out in Murmur, fell back to the terminal prompt)",
            ok: false,
          });
          this.persist();
          this.broadcast();
          resolve({ decision: "timeout" });
        }
      }, timeoutMs);

      let macHandle: MacAlertHandle | undefined;
      if (this.nativeAlertsEnabled()) {
        const session = this.macAlertSession();
        macHandle = spawnMacAlert(
          buildPermissionAlert(
            req,
            command,
            classification,
            this.macAlertTitle(req.tool, session),
            session
          ),
          (button) => {
            const map: Record<string, PermissionDecision> = {
              Allow: "allow",
              Always: "always",
              Deny: "deny",
            };
            const decision = map[button] ?? "deny";
            this.resolvePermission(permissionId, decision);
          }
        );
      }

      this.permissionResolvers.set(permissionId, {
        resolve,
        timer,
        macHandle,
      });
      this.state.pendingPermission = pending;
      this.persist();
      this.broadcast();
    });
  }

  resolvePermission(permissionId: string, decision: PermissionDecision): boolean {
    const entry = this.permissionResolvers.get(permissionId);
    if (!entry) return false;
    const pending = this.state.pendingPermission;
    clearTimeout(entry.timer);
    entry.macHandle?.kill();
    this.permissionResolvers.delete(permissionId);
    this.state.pendingPermission = null;
    this.addActivity({
      kind: "prompt",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: "permission",
      question: pending
        ? pending.command
          ? `${pending.tool} · ${pending.command}`
          : pending.tool
        : "(permission)",
      answer: decision,
      ok: decision !== "deny",
    });
    this.persist();
    this.broadcast();
    entry.resolve({ decision });
    return true;
  }
}

export const store = new Store();
