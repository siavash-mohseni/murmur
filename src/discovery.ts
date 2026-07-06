// Session discovery shared by the per-session server and the hub: enumerate
// live sessions from port files (probing each sibling's /state), and persisted
// session history from sessions/*.json. Extracted from http.ts so the hub can
// import it without state.ts's import-time session-identity side effects.

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths.js";
import { estimateCost, type CostInputs } from "./model-caps.js";
import { resolveSessionTitle, pidToSessionId } from "./titles.js";

import type { SessionSummary } from "./shared-types.js";
export type { SessionSummary };

// The caller's own identity, so its row is answered from memory instead of a
// self-probe. The hub passes null: it is not a session, every row is a probe.
export interface SelfSession {
  key: string;
  claudeSessionId?: string;
  branch?: string;
  cwdBasename?: string;
  cwd?: string;
  startedAt?: string;
}

/**
 * Resolve a Claude-Code-style title for a session, handling both the env-set
 * case (key IS the claudeSessionId) and the PPID fallback (key is "claude-<pid>",
 * pid → sessionId via ~/.claude/sessions/<pid>.json).
 */
export function titleFor(
  key: string,
  body: { claudeSessionId?: string; cwd?: string }
): string | undefined {
  let cid = body.claudeSessionId;
  let cwd = body.cwd;
  if (!cid) {
    const m = key.match(/^claude-(\d+)$/);
    if (m) {
      const lookup = pidToSessionId(parseInt(m[1]!, 10));
      cid = lookup.sessionId;
      cwd = cwd ?? lookup.cwd;
    }
  }
  if (!cid || !cwd) return undefined;
  return resolveSessionTitle(cid, cwd).title;
}

export async function listSessions(self: SelfSession | null): Promise<SessionSummary[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".port"));
  const results: SessionSummary[] = [];
  await Promise.all(
    files.map(async (f) => {
      const key = f.replace(/\.port$/, "");
      let port = 0;
      try {
        port = parseInt((await readFile(join(SESSIONS_DIR, f), "utf8")).trim(), 10);
      } catch {
        return;
      }
      if (!Number.isFinite(port) || port <= 0) return;
      // Match by either the caller's static key OR its live claudeSessionId
      // (which may have been updated by the polling-based UUID drift fix).
      // Without the second check, the dropdown loses track of "this session"
      // after a sessionId migration.
      const current =
        self !== null && (key === self.key || (!!self.claudeSessionId && key === self.claudeSessionId));
      if (current && self) {
        results.push({
          key,
          port,
          url: `http://127.0.0.1:${port}/`,
          current: true,
          alive: true,
          branch: self.branch,
          cwdBasename: self.cwdBasename,
          startedAt: self.startedAt,
          claudeSessionId: self.claudeSessionId,
          cwd: self.cwd,
          title: titleFor(key, { claudeSessionId: self.claudeSessionId, cwd: self.cwd }),
        });
        return;
      }
      let summary: SessionSummary = {
        key,
        port,
        url: `http://127.0.0.1:${port}/`,
        current: false,
        alive: false,
      };
      try {
        const probe = await fetch(`http://127.0.0.1:${port}/state`, {
          signal: AbortSignal.timeout(500),
        });
        if (probe.ok) {
          const body = (await probe.json()) as {
            sessionInfo?: {
              branch?: string;
              cwdBasename?: string;
              claudeSessionId?: string;
              cwd?: string;
            };
            startedAt?: string;
          };
          summary = {
            ...summary,
            alive: true,
            branch: body.sessionInfo?.branch,
            cwdBasename: body.sessionInfo?.cwdBasename,
            startedAt: body.startedAt,
            claudeSessionId: body.sessionInfo?.claudeSessionId,
            cwd: body.sessionInfo?.cwd,
            title: titleFor(key, {
              claudeSessionId: body.sessionInfo?.claudeSessionId,
              cwd: body.sessionInfo?.cwd,
            }),
          };
        }
      } catch {
        // unreachable; leave alive=false
      }
      if (!summary.title) {
        // Even unreachable sessions can have a title from the index.
        summary.title = titleFor(key, {});
      }
      results.push(summary);
    })
  );

  // Dedupe: when multiple port files map to the same live session (e.g. an
  // env-derived key + a leftover claude-<pid>.port both pointing at 5173),
  // collapse them into one row. Prefer current=true, then alive=true, then
  // the env-derived key over the PPID-derived one.
  const dedup = new Map<string, SessionSummary>();
  for (const s of results) {
    const k = s.claudeSessionId
      ? `cid:${s.claudeSessionId}:${s.port}`
      : `port:${s.port}`;
    const existing = dedup.get(k);
    if (!existing) {
      dedup.set(k, s);
      continue;
    }
    const better =
      s.current ||
      (!existing.current && s.alive && !existing.alive) ||
      (!existing.current && existing.alive === s.alive && !/^claude-\d+$/.test(s.key));
    if (better) dedup.set(k, s);
  }
  const out = Array.from(dedup.values());
  out.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const ax = a.startedAt ?? "";
    const bx = b.startedAt ?? "";
    return ax < bx ? 1 : -1;
  });
  return out;
}

export interface PastSessionSummary {
  key: string;
  claudeSessionId?: string;
  branch?: string;
  cwdBasename?: string;
  cwd?: string;
  title?: string;
  startedAt?: string;
  lastActivityAt?: string;
  rowCount: number;
  activityCount: number;
  isLive: boolean;
  port?: number;
  bytes: number;
  mtime: string;
  // Derived from the persisted tokenStats so history carries spend, not just
  // event counts. Absent when the session never recorded token stats.
  model?: string;
  totalTokens?: number;
  costUsd?: number;
}

// Parsed-summary cache keyed by session file path, validated by mtime+size so
// repeated /sessions/all calls do not re-read and re-parse unchanged files.
interface PastSessionCacheEntry {
  mtimeMs: number;
  size: number;
  summary: PastSessionSummary;
}
const pastSessionCache = new Map<string, PastSessionCacheEntry>();

export async function listAllSessions(): Promise<PastSessionSummary[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const files = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json"));
  const settled = await Promise.all(
    files.map((f) => buildPastSessionSummary(f))
  );
  const out = settled.filter((s): s is PastSessionSummary => s !== null);
  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return out;
}

async function buildPastSessionSummary(f: string): Promise<PastSessionSummary | null> {
  const key = f.replace(/\.json$/, "");
  const path = join(SESSIONS_DIR, f);
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  const portFile = join(SESSIONS_DIR, `${key}.port`);
  let port: number | undefined;
  let isLive = false;
  if (existsSync(portFile)) {
    try {
      const p = parseInt((await readFile(portFile, "utf8")).trim(), 10);
      if (Number.isFinite(p) && p > 0) {
        port = p;
        // Light liveness check: we don't probe here (would be too slow for the
        // listing call). The /sessions endpoint does the probe and marks
        // alive=true; this listing focuses on persisted history.
        isLive = true;
      }
    } catch {
      // best-effort: a missing/unreadable port file just means not-live
    }
  }

  // Cache the parsed body summary by mtime+size. The liveness fields (port,
  // isLive) depend on a sibling .port file that the .json mtime does not
  // track, so they are recomputed every call above and merged onto the cached
  // body summary below.
  const cached = pastSessionCache.get(path);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { ...cached.summary, isLive, port };
  }

  let data: {
    sessionInfo?: { branch?: string; cwdBasename?: string; cwd?: string; claudeSessionId?: string };
    startedAt?: string;
    rows?: unknown[];
    activities?: { timestamp?: string }[];
    tokenStats?: (CostInputs & { totalTokens?: number }) | null;
  } = {};
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // ignore corrupt file
  }
  const acts = data.activities ?? [];
  const tokenStats = data.tokenStats ?? undefined;
  const lastActivityAt = acts.length > 0 ? acts[acts.length - 1]?.timestamp : data.startedAt;
  const cid = data.sessionInfo?.claudeSessionId;
  const cwd = data.sessionInfo?.cwd;
  const title = titleFor(key, { claudeSessionId: cid, cwd });
  const summary: PastSessionSummary = {
    key,
    claudeSessionId: cid,
    branch: data.sessionInfo?.branch,
    cwdBasename: data.sessionInfo?.cwdBasename,
    cwd,
    title,
    startedAt: data.startedAt,
    lastActivityAt,
    rowCount: (data.rows ?? []).length,
    activityCount: acts.length,
    isLive,
    port,
    bytes: st.size,
    mtime: new Date(st.mtimeMs).toISOString(),
    model: tokenStats?.model,
    totalTokens: tokenStats?.totalTokens,
    costUsd: tokenStats ? estimateCost(tokenStats) : undefined,
  };
  pastSessionCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, summary });
  return summary;
}
