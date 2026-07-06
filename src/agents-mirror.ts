// agents-mirror.ts: polls `claude agents --json` and projects the live
// Claude Code sessions on this machine into the dashboard's `agentSessions`
// slice (see AgentSessionMirror in state.ts). Read-only, best-effort.
//
// `claude agents --json` prints every live session as a JSON array and exits
// (no TTY needed). Newer CLIs add `waitingFor` (what a blocked session is
// waiting on, e.g. a permission prompt) and fan-out progress (`done`/`total`
// plus a `peek` of the longest-running item). We surface all of it so the
// dashboard can show sibling sessions and flag the current one when it blocks.
//
// Every spawn is wrapped: a missing CLI, an old CLI without `--json`, a
// timeout, or malformed output all degrade to "no sessions" and keep the last
// good projection rather than clearing the panel.

import { execFile } from "node:child_process";
import { basename } from "./intent.js";
import type { AgentSessionMirror, Store } from "./state.js";

const POLL_MS = 6_000;
const SPAWN_TIMEOUT_MS = 4_000;
const MAX_SESSIONS = 50;
// Disable with MURMUR_AGENTS_POLL=0 (e.g. in CI / headless contexts).
const POLL_ON = process.env["MURMUR_AGENTS_POLL"] !== "0";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function numOr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// `waitingFor` may arrive as a string or as a small object ({ reason, tool }).
// Normalize to a short human string.
function waitingForOf(v: unknown): string | undefined {
  if (typeof v === "string") return str(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o["reason"]) ?? str(o["label"]) ?? str(o["tool"]) ?? str(o["kind"]);
  }
  return undefined;
}

function mapSession(raw: unknown): AgentSessionMirror | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const cwd = str(o["cwd"]);
  return {
    pid: numOr(o["pid"]),
    sessionId: str(o["sessionId"]),
    cwd,
    cwdBasename: basename(cwd) || undefined,
    name: str(o["name"]),
    status: str(o["status"]),
    startedAt: numOr(o["startedAt"]),
    waitingFor: waitingForOf(o["waitingFor"]),
    done: numOr(o["done"]),
    total: numOr(o["total"]),
    peek: str(o["peek"]) ?? str(o["longestRunning"]),
  };
}

// Resolves to the mapped sessions on success (an empty array is a valid "no
// sibling sessions" result and clears the panel), or `null` when the CLI call
// itself failed — timeout, spawn error, non-array, or unparseable output — so
// the caller can distinguish a genuine empty from a transient failure and keep
// the last good projection instead of flickering the panel empty.
function runClaudeAgents(): Promise<AgentSessionMirror[] | null> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      ["agents", "--json"],
      { timeout: SPAWN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          if (!Array.isArray(parsed)) {
            resolve(null);
            return;
          }
          const out: AgentSessionMirror[] = [];
          for (const item of parsed) {
            const m = mapSession(item);
            if (m) out.push(m);
            if (out.length >= MAX_SESSIONS) break;
          }
          resolve(out);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Start the `claude agents --json` poll: once immediately, then every 6s on an
 * unref'd interval (same shape as startWorkflowMirror). Any failure keeps the
 * last good projection.
 */
export function startAgentsMirror(store: Store): void {
  if (!POLL_ON) return;
  let inFlight = false;
  const run = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      const sessions = await runClaudeAgents();
      // null = the CLI call failed; keep the last good projection rather than
      // clearing the panel. A real (empty) result still updates and clears it.
      if (sessions !== null) store.setAgentSessions(sessions);
    } catch {
      // keep last good projection
    } finally {
      inFlight = false;
    }
  };
  void run();
  const id = setInterval(() => void run(), POLL_MS);
  id.unref();
}
