#!/usr/bin/env node
// hub.ts: the Murmur hub — one stable local entry point over every per-session
// server. Spawned lazily by the first session server that finds no live hub
// (see hub-client.ts), detached from any Claude session, and self-exiting
// after a long idle window with no sessions and no clients.
//
// What it does:
//   - Registry: polls sessions/*.port and tails each live session's /events
//     with ?role=mirror (excluded from that session's watcher count).
//   - Fleet: projects each session's DashboardState down to a
//     FleetSessionSummary and serves the set over GET /fleet and as `fleet`
//     events on its own SSE stream.
//   - Proxy: forwards /s/<key>/* to the owning session server, streaming both
//     ways (SSE included), so one origin can drive any session's dashboard.
//   - Watcher relay: while the hub itself has human clients, it heartbeats
//     POST /watchers/remote to every live session so questions and
//     permissions route to Murmur. When the last client leaves, it posts
//     zero so the terminal prompt wins again immediately.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSIONS_DIR, HUB_PORT_FILE, DEFAULT_HUB_PORT } from "./paths.js";
import { listAllSessions, titleFor } from "./discovery.js";
import { estimateCost } from "./model-caps.js";
import { hostAllowed, originAllowed } from "./auth.js";
import { resolveImageFile } from "./image-store.js";
import { renderSessionHtml } from "./export/render.js";
import type {
  DashboardState,
  FleetSessionSummary,
  FleetSnapshot,
  HubEvent,
  Activity,
} from "./shared-types.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = join(HERE, "..", "dist", "web");

const REGISTRY_POLL_MS = 3_000;
const RECONNECT_DELAY_MS = 2_000;
const FLEET_DEBOUNCE_MS = 250;
const HEARTBEAT_INTERVAL_MS = 5_000;
const WATCHER_RELAY_INTERVAL_MS = 10_000;
const IDLE_EXIT_MS = 30 * 60_000;
const SESSION_KEY_RE = /[^A-Za-z0-9_-]/;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const log = (msg: string): void => console.error(`[murmur-hub] ${msg}`);

// --- session tails ------------------------------------------------------------

interface SessionTail {
  key: string;
  port: number;
  alive: boolean;
  state: DashboardState | null;
  lastEventAt: number;
  abort: AbortController;
}

const tails = new Map<string, SessionTail>();
let fleetDirty = true;
let lastNonIdleAt = Date.now();

// One-line summary of the newest activity for the fleet card.
function summarizeActivity(a: Activity | undefined): { at?: string; text?: string } {
  if (!a) return {};
  const clip = (s: string): string => (s.length > 140 ? `${s.slice(0, 139)}…` : s);
  switch (a.kind) {
    case "tool":
      return { at: a.timestamp, text: clip(a.target ? `${a.tool}: ${a.target.split("\n")[0]}` : a.tool) };
    case "agent":
      return { at: a.timestamp, text: clip(`agent: ${a.description}`) };
    case "log":
      return { at: a.timestamp, text: clip(a.message) };
    case "prompt":
      return { at: a.timestamp, text: clip(a.question) };
    case "warn":
      return { at: a.timestamp, text: clip(a.message) };
    case "hook":
      return { at: a.timestamp, text: clip(a.hook) };
    default:
      return {};
  }
}

function toFleetSummary(t: SessionTail): FleetSessionSummary {
  const s = t.state;
  const rows = s?.rows ?? [];
  const last = summarizeActivity(s?.activities?.[s.activities.length - 1]);
  const ts = s?.tokenStats ?? null;
  return {
    key: t.key,
    port: t.port,
    alive: t.alive,
    title: s ? titleFor(t.key, { claudeSessionId: s.sessionInfo.claudeSessionId, cwd: s.sessionInfo.cwd }) : titleFor(t.key, {}),
    branch: s?.sessionInfo.branch,
    cwd: s?.sessionInfo.cwd,
    cwdBasename: s?.sessionInfo.cwdBasename,
    model: s?.sessionInfo.model ?? ts?.model,
    effort: s?.sessionInfo.effort,
    startedAt: s?.startedAt,
    resourceAttributes: s?.sessionInfo.resourceAttributes,
    pendingQuestion: s?.pendingQuestion ?? null,
    pendingPermission: s?.pendingPermission ?? null,
    rowsTotal: rows.length,
    rowsCompleted: rows.filter((r) => r.status === "completed").length,
    rowsFailed: rows.filter((r) => r.status === "failed").length,
    rowsInProgress: rows.filter((r) => r.status === "in_progress").length,
    lastActivityAt: last.at,
    lastActivitySummary: last.text,
    contextTokens: ts?.lastContextTokens,
    contextLimit: ts?.contextLimit,
    totalTokens: ts?.totalTokens,
    costUsd: ts ? estimateCost(ts) : undefined,
    messageCount: ts?.messageCount,
    clients: s?.clients,
    workflowsRunning: (s?.workflows ?? []).filter((w) => w.status === "running").length,
    lastEventAt: t.lastEventAt ? new Date(t.lastEventAt).toISOString() : undefined,
  };
}

function fleetSnapshot(): FleetSnapshot {
  const sessions = Array.from(tails.values()).map(toFleetSummary);
  sessions.sort((a, b) => {
    const aNeeds = a.pendingQuestion || a.pendingPermission ? 1 : 0;
    const bNeeds = b.pendingQuestion || b.pendingPermission ? 1 : 0;
    if (aNeeds !== bNeeds) return bNeeds - aNeeds;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return (b.lastEventAt ?? "") < (a.lastEventAt ?? "") ? -1 : 1;
  });
  return { generatedAt: new Date().toISOString(), sessions };
}

// Minimal SSE client over fetch: the session servers emit exactly
// `event: <type>\ndata: <json>\n\n` frames (see http.ts handleEvents), so a
// line-oriented parse is sufficient. Node's global EventSource is still
// flag-gated on some versions, so we do not rely on it.
async function tailSession(tail: SessionTail): Promise<void> {
  while (!tail.abort.signal.aborted) {
    try {
      // Version gate: only tail servers that understand role=mirror. An older
      // build would count our tail as a human tab and lift its watcher gate,
      // routing prompts to a pane nobody may be looking at. The `remote` field
      // in /watchers ships in the same build as role=mirror, so probe for it.
      const probe = await fetch(`http://127.0.0.1:${tail.port}/watchers`, {
        signal: AbortSignal.timeout(1000),
      });
      const watchers = (await probe.json()) as Record<string, unknown>;
      if (!("remote" in watchers)) {
        throw new Error("session server predates role=mirror; not tailing");
      }
      const res = await fetch(`http://127.0.0.1:${tail.port}/events?role=mirror`, {
        signal: tail.abort.signal,
        headers: { accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
      tail.alive = true;
      tail.lastEventAt = Date.now();
      fleetDirty = true;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventType = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            tail.lastEventAt = Date.now();
            if (eventType === "state") {
              try {
                const parsed = JSON.parse(line.slice(6)) as { state?: DashboardState };
                if (parsed.state) {
                  tail.state = parsed.state;
                  fleetDirty = true;
                  lastNonIdleAt = Date.now();
                }
              } catch {
                // malformed frame: skip
              }
            }
          } else if (line === "") {
            eventType = "";
          }
        }
      }
      throw new Error("stream ended");
    } catch {
      if (tail.abort.signal.aborted) return;
      if (tail.alive) {
        tail.alive = false;
        fleetDirty = true;
      }
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }
}

// Poll the port files: start tails for new sessions, retarget moved ports,
// drop tails whose port file disappeared (session exited and cleaned up, or
// the stale file was pruned).
function refreshRegistry(): void {
  let files: string[] = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".port"));
  } catch {
    files = [];
  }
  const seen = new Set<string>();
  for (const f of files) {
    const key = f.replace(/\.port$/, "");
    if (SESSION_KEY_RE.test(key)) continue;
    let port = 0;
    try {
      port = parseInt(readFileSync(join(SESSIONS_DIR, f), "utf8").trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isFinite(port) || port <= 0) continue;
    seen.add(key);
    const existing = tails.get(key);
    if (existing && existing.port === port) continue;
    if (existing) existing.abort.abort();
    const tail: SessionTail = {
      key,
      port,
      alive: false,
      state: existing?.state ?? null,
      lastEventAt: existing?.lastEventAt ?? 0,
      abort: new AbortController(),
    };
    tails.set(key, tail);
    void tailSession(tail);
    lastNonIdleAt = Date.now();
  }
  for (const [key, tail] of tails) {
    if (!seen.has(key)) {
      tail.abort.abort();
      tails.delete(key);
      fleetDirty = true;
    }
  }
}

// --- hub HTTP surface -----------------------------------------------------------

type HubListener = (event: HubEvent) => void;
const hubListeners = new Set<HubListener>();

function deliverHub(event: HubEvent): void {
  for (const l of hubListeners) {
    try {
      l(event);
    } catch {
      // non-fatal
    }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(res: ServerResponse, rel: string): Promise<boolean> {
  const safe = normalize(rel).replace(/^([./\\])+/, "");
  const path = join(WEB_DIR, safe);
  if (!path.startsWith(WEB_DIR)) return false;
  let st;
  try {
    st = await stat(path);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const bytes = await readFile(path);
  res.writeHead(200, {
    "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": "no-cache",
  });
  res.end(bytes);
  return true;
}

async function serveIndex(res: ServerResponse): Promise<void> {
  if (await serveStatic(res, "index.html")) return;
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  res.end("Murmur UI not built. Run `bun run build`.");
}

function handleHubEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const write = (event: HubEvent): void => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  hubListeners.add(write);
  lastNonIdleAt = Date.now();
  write({ type: "fleet", fleet: fleetSnapshot() });
  relayWatchers(); // a human just connected: lift the gate without waiting a tick
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    hubListeners.delete(write);
    relayWatchers(); // possibly the last human left: release the gate promptly
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

// Forward /s/<key>/<rest> to the owning session server, streaming both
// directions so SSE and images pass through untouched. The hub connects over
// loopback, so the session's loopback-gated routes keep working through it.
function proxyToSession(req: IncomingMessage, res: ServerResponse, key: string, rest: string): void {
  const tail = tails.get(key);
  let port = tail?.port ?? 0;
  if (!port) {
    try {
      port = parseInt(readFileSync(join(SESSIONS_DIR, `${key}.port`), "utf8").trim(), 10);
    } catch {
      port = 0;
    }
  }
  if (!Number.isFinite(port) || port <= 0) {
    sendJson(res, 502, { ok: false, reason: `no live server for session ${key}` });
    return;
  }
  const headers = { ...req.headers };
  delete headers.host;
  // The hub has already validated this request's Origin against names it
  // answers to. The session server's own allowlist may not know those names,
  // so don't make it re-judge a header the hub already vouched for.
  delete headers.origin;
  const upstream = httpRequest(
    { host: "127.0.0.1", port, path: `/${rest}`, method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, reason: "session server unreachable" });
    else res.end();
  });
  req.pipe(upstream);
  // Tear down the upstream when the CLIENT goes away. This must hang off res,
  // not req: an incoming GET's request stream completes immediately, so a
  // req-side close would abort every proxied read before its response.
  res.on("close", () => upstream.destroy());
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  // Guard stack, cheapest rejection first. Host allowlist kills DNS
  // rebinding, the Origin check kills cross-site POSTs from pages the user
  // has open.
  if (!hostAllowed(req)) {
    sendJson(res, 403, { ok: false, reason: "unrecognized host" });
    return;
  }
  if ((method === "POST" || method === "DELETE") && !originAllowed(req)) {
    sendJson(res, 403, { ok: false, reason: "cross-origin request rejected" });
    return;
  }

  // Session proxy: /s/<key> serves the SPA (client route), /s/<key>/<rest>
  // forwards to the session server.
  const m = path.match(/^\/s\/([^/]+)(?:\/(.*))?$/);
  if (m) {
    const key = m[1]!;
    if (SESSION_KEY_RE.test(key)) {
      sendJson(res, 400, { ok: false, reason: "invalid key" });
      return;
    }
    const rest = m[2] ?? "";
    if (rest === "" || rest === "index.html") {
      await serveIndex(res);
      return;
    }
    proxyToSession(req, res, key, `${rest}${url.search}`);
    return;
  }

  if (method === "GET" && (path === "/" || path === "/index.html")) {
    await serveIndex(res);
    return;
  }
  if (method === "GET" && path === "/fleet") {
    sendJson(res, 200, { ok: true, hub: true, ...fleetSnapshot() });
    return;
  }
  // Self-contained session export from persisted state (works for past
  // sessions and for live ones, whose stores persist on a short debounce).
  // PII redaction is on by default, ?redact=0 opts out.
  if (method === "GET" && path.startsWith("/export/")) {
    const em = path.match(/^\/export\/([A-Za-z0-9_-]+)\.html$/);
    if (!em) {
      sendJson(res, 400, { ok: false, reason: "expected /export/<key>.html" });
      return;
    }
    const html = renderSessionHtml(
      em[1]!,
      url.searchParams.get("kind") === "data" ? "data" : "summary",
      { redact: url.searchParams.get("redact") !== "0" }
    );
    if (html === null) {
      sendJson(res, 404, { ok: false, reason: "no state for that session" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(html),
      "cache-control": "no-cache",
    });
    res.end(html);
    return;
  }
  // Transcript images. The store is content-addressed and machine-wide, and
  // the urls in a session's state carry no /s/<key> prefix, so on the hub
  // origin (a drill-down or the fleet home) they land here rather than on the
  // owning session. Without this they fall through to the SPA shell and every
  // thumbnail renders broken.
  if (method === "GET" && path.startsWith("/api/image/")) {
    const resolved = resolveImageFile(path.slice("/api/image/".length));
    if (!resolved) {
      sendJson(res, 404, { ok: false, reason: "no such image" });
      return;
    }
    const bytes = await readFile(resolved.path);
    res.writeHead(200, {
      "content-type": resolved.mime,
      "content-length": bytes.byteLength,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(bytes);
    return;
  }
  if (method === "GET" && path === "/events") {
    handleHubEvents(req, res);
    return;
  }
  if (method === "GET" && path === "/sessions/all") {
    sendJson(res, 200, await listAllSessions());
    return;
  }
  // Past-session archive access, so the fleet home's "Past sessions" browser
  // works on the hub origin. Same key validation and live-session guard as
  // the session servers' handlers.
  if (path === "/sessions/by-key" && (method === "GET" || method === "DELETE")) {
    const key = url.searchParams.get("key") ?? "";
    if (!key || SESSION_KEY_RE.test(key)) {
      sendJson(res, 400, { ok: false, reason: "invalid key" });
      return;
    }
    const statePath = join(SESSIONS_DIR, `${key}.json`);
    if (method === "GET") {
      try {
        const raw = await readFile(statePath, "utf8");
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(raw),
        });
        res.end(raw);
      } catch {
        sendJson(res, 404, { ok: false, reason: "not found" });
      }
      return;
    }
    if (existsSync(join(SESSIONS_DIR, `${key}.port`))) {
      sendJson(res, 409, { ok: false, reason: "session still has a port file; close it first" });
      return;
    }
    const removed: string[] = [];
    for (const f of readdirSync(SESSIONS_DIR).filter((f) => f === `${key}.json` || f.startsWith(`${key}.`))) {
      try {
        unlinkSync(join(SESSIONS_DIR, f));
        removed.push(f);
      } catch {
        // best-effort: skip files we can't remove
      }
    }
    sendJson(res, removed.length > 0 ? 200 : 404, { ok: removed.length > 0, removed });
    return;
  }
  if (method === "GET") {
    const rel = path.replace(/^\//, "");
    if (rel && (await serveStatic(res, rel))) return;
    // Unknown GET path: hand the SPA its index so client-side routes deep-link.
    await serveIndex(res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

// --- watcher relay ---------------------------------------------------------------

// Tell every live session how many humans can currently see it through the
// hub. Fires on the interval and immediately on client connect/disconnect.
function relayWatchers(): void {
  const count = hubListeners.size;
  for (const tail of tails.values()) {
    if (!tail.alive) continue;
    void fetch(`http://127.0.0.1:${tail.port}/watchers/remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count }),
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});
  }
}

// --- boot ---------------------------------------------------------------------------

// Is the process already holding this port another hub?
function probeIsHub(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/fleet",
        timeout: 400,
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => {
          try {
            resolve((JSON.parse(body) as { hub?: boolean }).hub === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    probe.on("timeout", () => probe.destroy());
    probe.on("error", () => resolve(false));
    probe.end();
  });
}

async function main(): Promise<void> {
  const preferred = parseInt(process.env["MURMUR_HUB_PORT"] ?? String(DEFAULT_HUB_PORT), 10);
  let port = Number.isFinite(preferred) && preferred > 0 ? preferred : DEFAULT_HUB_PORT;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: message });
    });
  };
  const server = createServer(handler);

  for (let attempts = 0; attempts < 20; attempts++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        // Another hub already alive on this port? Then this spawn lost the
        // race and can simply exit; otherwise walk to the next port.
        if (await probeIsHub(port)) {
          log(`another hub owns :${port}, exiting`);
          process.exit(0);
        }
        port += 1;
        continue;
      }
      throw err;
    }
  }
  if (!server.listening) {
    log(`could not bind a port starting at ${preferred}`);
    process.exit(1);
  }

  writeFileSync(HUB_PORT_FILE, String(port));
  const cleanup = (): void => {
    try {
      if (existsSync(HUB_PORT_FILE) && readFileSync(HUB_PORT_FILE, "utf8").trim() === String(port)) {
        unlinkSync(HUB_PORT_FILE);
      }
    } catch {
      // best-effort
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  log(`listening on http://127.0.0.1:${port}/`);

  refreshRegistry();
  setInterval(refreshRegistry, REGISTRY_POLL_MS);

  // Debounced fleet broadcast: state frames arrive in bursts (every hook fire
  // rebroadcasts), so coalesce to at most one fleet event per window.
  setInterval(() => {
    if (!fleetDirty) return;
    fleetDirty = false;
    deliverHub({ type: "fleet", fleet: fleetSnapshot() });
  }, FLEET_DEBOUNCE_MS);

  setInterval(() => {
    deliverHub({ type: "heartbeat", at: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);

  setInterval(relayWatchers, WATCHER_RELAY_INTERVAL_MS);

  // Idle self-exit: no sessions, no clients, nothing seen for the window.
  setInterval(() => {
    if (tails.size === 0 && hubListeners.size === 0 && Date.now() - lastNonIdleAt > IDLE_EXIT_MS) {
      log("idle, exiting");
      process.exit(0);
    }
  }, 60_000);
}

main().catch((err) => {
  log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
