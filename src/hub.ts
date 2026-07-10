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
//   - Watcher relay: while the hub itself has human clients OR a paired push
//     subscription, it heartbeats POST /watchers/remote to every live session
//     so questions and permissions route to Murmur; when the last client
//     leaves, it posts zero so the terminal prompt wins again immediately.
//   - Pager (Phase 2): non-loopback requests require the machine token
//     (MURMUR_LAN=1 opens the bind), GET /api/pair feeds the QR pairing flow,
//     and Web Push subscriptions get a pager frame the moment any session
//     raises a question or permission.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer, request as httpsRequest } from "node:https";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSIONS_DIR, HUB_PORT_FILE, DEFAULT_HUB_PORT, PUSH_SUBS_FILE } from "./paths.js";
import { listAllSessions, titleFor } from "./discovery.js";
import { estimateCost } from "./model-caps.js";
import { hostAllowed, isAuthorized, isLoopbackAddr, isTrustedLocal, machineToken, originAllowed } from "./auth.js";
import { loadVapid, sendWebPush, type PushSubscriptionJSON } from "./webpush.js";
import { renderSessionHtml } from "./export/render.js";
import { startTunnel, tunnelStatus } from "./tunnel-client.js";
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
const MAX_PUSH_SUBS = 20;

// LAN mode opens the bind to every interface, which is what makes the phone
// pager possible and what makes the token gate non-optional.
const LAN = process.env["MURMUR_LAN"] === "1";
// Optional TLS (e.g. `tailscale cert` output): phones only grant service
// workers and Web Push to secure contexts, so LAN pager alerts need https.
const TLS_CERT = process.env["MURMUR_TLS_CERT"] ?? "";
const TLS_KEY = process.env["MURMUR_TLS_KEY"] ?? "";
const TLS_ON = TLS_CERT.length > 0 && TLS_KEY.length > 0;
const SCHEME = TLS_ON ? "https" : "http";

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

function readJson<T>(req: IncomingMessage, limit = 100_000): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// --- Web Push pager -------------------------------------------------------------

interface StoredSubscription {
  subscription: PushSubscriptionJSON;
  addedAt: string;
  userAgent?: string;
}

let pushSubs: StoredSubscription[] = (() => {
  try {
    const parsed = JSON.parse(readFileSync(PUSH_SUBS_FILE, "utf8")) as StoredSubscription[];
    return Array.isArray(parsed) ? parsed.filter((s) => s?.subscription?.endpoint) : [];
  } catch {
    return [];
  }
})();

function savePushSubs(): void {
  try {
    writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubs, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`could not persist push subscriptions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Push service endpoints are https by definition; plain http is allowed only
// toward loopback so the smoke can stand in a fake push service.
function validSubscription(sub: unknown): sub is PushSubscriptionJSON {
  const s = sub as PushSubscriptionJSON;
  if (typeof s?.endpoint !== "string" || typeof s?.keys?.p256dh !== "string" || typeof s?.keys?.auth !== "string") {
    return false;
  }
  try {
    const u = new URL(s.endpoint);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

// Deliver one pager frame to every paired device, dropping subscriptions the
// push service reports dead (404/410) so a wiped phone stops counting as a
// watcher.
async function broadcastPush(
  payload: Record<string, unknown>,
  opts?: { urgency?: "normal" | "high"; ttlSeconds?: number }
): Promise<void> {
  if (pushSubs.length === 0) return;
  const results = await Promise.all(
    pushSubs.map((s) => sendWebPush(s.subscription, payload, opts))
  );
  const keep = pushSubs.filter((_, i) => !results[i]!.gone);
  if (keep.length !== pushSubs.length) {
    log(`pruned ${pushSubs.length - keep.length} dead push subscription(s)`);
    pushSubs = keep;
    savePushSubs();
    relayWatchers();
  }
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Per-session ids already pushed, so each question/permission pages exactly
// once per appearance. A resolved prompt sends a low-key "resolve" frame so
// the service worker can clear the lock-screen notification (and its now-dead
// Allow/Deny actions) on every paired device.
const pushedQuestion = new Map<string, string>();
const pushedPermission = new Map<string, string>();

function detectAndPush(): void {
  if (pushSubs.length === 0) return;
  for (const t of tails.values()) {
    const s = t.state;
    if (!s || !t.alive) continue;
    const label =
      titleFor(t.key, { claudeSessionId: s.sessionInfo.claudeSessionId, cwd: s.sessionInfo.cwd }) ??
      s.sessionInfo.cwdBasename ??
      t.key.slice(0, 8);

    const q = s.pendingQuestion;
    if (q?.questionId && pushedQuestion.get(t.key) !== q.questionId) {
      pushedQuestion.set(t.key, q.questionId);
      void broadcastPush({
        kind: "question",
        key: t.key,
        label,
        tag: q.questionId,
        title: q.header ? `${label} · ${q.header}` : `${label} · Claude needs an answer`,
        body: clip(q.question ?? "", 300),
        url: `/s/${t.key}`,
      });
    } else if (!q && pushedQuestion.has(t.key)) {
      const tag = pushedQuestion.get(t.key)!;
      pushedQuestion.delete(t.key);
      void broadcastPush({ kind: "resolve", tag }, { urgency: "normal", ttlSeconds: 120 });
    }

    const p = s.pendingPermission;
    if (p?.permissionId && pushedPermission.get(t.key) !== p.permissionId) {
      pushedPermission.set(t.key, p.permissionId);
      void broadcastPush({
        kind: "permission",
        key: t.key,
        label,
        tag: p.permissionId,
        permissionId: p.permissionId,
        title: `${label} · Allow ${p.tool || "Bash"}?`,
        body: clip(p.command ?? "", 300),
        url: `/s/${t.key}`,
      });
    } else if (!p && pushedPermission.has(t.key)) {
      const tag = pushedPermission.get(t.key)!;
      pushedPermission.delete(t.key);
      void broadcastPush({ kind: "resolve", tag }, { urgency: "normal", ttlSeconds: 120 });
    }
  }
  for (const key of Array.from(pushedQuestion.keys())) {
    if (!tails.has(key)) pushedQuestion.delete(key);
  }
  for (const key of Array.from(pushedPermission.keys())) {
    if (!tails.has(key)) pushedPermission.delete(key);
  }
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
  // The hub has already authenticated this request and validated its Origin
  // against names the hub answers to (LAN IPs, a tailnet hostname). The
  // session server's own allowlist may not know those names, so don't make it
  // re-judge a header the hub already vouched for. The tunnel marker likewise
  // stops here: toward the session the hub is an ordinary loopback caller.
  delete headers.origin;
  delete headers["x-murmur-tunneled"];
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

// The static shell (index, assets, icons, the service worker) is the only
// thing an unpaired device may fetch: the SPA has to boot before it can read
// the pairing token out of the URL fragment (fragments never reach the
// server). Everything that carries data or acts on a session needs the token.
function isShellGet(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (path === "/fleet" || path === "/events") return false;
  if (path.startsWith("/sessions") || path.startsWith("/api/") || path.startsWith("/export/")) return false;
  const m = path.match(/^\/s\/[^/]+\/(.+)$/);
  if (m && m[1] !== "index.html") return false; // proxied session data
  return true;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  // Guard stack, cheapest rejection first. Host allowlist kills DNS
  // rebinding, the Origin check kills cross-site POSTs from pages the user
  // has open, and the token gate is what stands between the LAN and a
  // dashboard that can approve shell commands.
  if (!hostAllowed(req)) {
    sendJson(res, 403, { ok: false, reason: "unrecognized host" });
    return;
  }
  if ((method === "POST" || method === "DELETE") && !originAllowed(req)) {
    sendJson(res, 403, { ok: false, reason: "cross-origin request rejected" });
    return;
  }
  if (!isAuthorized(req, url)) {
    if (isShellGet(method, path)) {
      const rel = path === "/" ? "" : path.replace(/^\//, "");
      if (rel && (await serveStatic(res, rel))) return;
      await serveIndex(res);
      return;
    }
    sendJson(res, 401, { ok: false, reason: "pairing required" });
    return;
  }

  // Pairing info for the QR flow. Trusted-local only: the desktop shows the
  // QR, the phone receives the token by scanning it, never by asking for it
  // (and never through the tunnel).
  if (method === "GET" && path === "/api/pair") {
    if (!isTrustedLocal(req)) {
      sendJson(res, 403, { ok: false, reason: "loopback only" });
      return;
    }
    const token = machineToken();
    const port = boundPort;
    const relay = tunnelStatus();
    // The relay origin pairs a phone that works from anywhere, so it leads
    // the list when the tunnel is up; LAN addresses follow.
    const urls: string[] = [];
    if (relay) urls.push(`${relay.url}/#t=${token}`);
    const override = (process.env["MURMUR_HUB_HOSTNAME"] ?? "").trim();
    if (override) urls.push(`${SCHEME}://${override}:${port}/#t=${token}`);
    if (LAN) {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family === "IPv4" && !addr.internal) {
            urls.push(`${SCHEME}://${addr.address}:${port}/#t=${token}`);
          }
        }
      }
    }
    sendJson(res, 200, {
      ok: true,
      lan: LAN,
      tls: TLS_ON,
      relay: relay?.url ?? null,
      port,
      token,
      urls,
    });
    return;
  }

  if (method === "GET" && path === "/api/push/config") {
    // A phone on the https relay origin IS a secure context even when the
    // hub itself serves plain http locally.
    const viaHttpsTunnel =
      "x-murmur-tunneled" in req.headers && (tunnelStatus()?.url ?? "").startsWith("https:");
    sendJson(res, 200, {
      ok: true,
      publicKey: loadVapid().publicKey,
      subscriptions: pushSubs.length,
      secureContext: TLS_ON || viaHttpsTunnel || isTrustedLocal(req),
    });
    return;
  }
  if (method === "POST" && path === "/api/push/subscribe") {
    try {
      const body = await readJson<{ subscription?: unknown }>(req);
      if (!validSubscription(body.subscription)) {
        sendJson(res, 400, { ok: false, reason: "invalid subscription" });
        return;
      }
      const sub = body.subscription;
      pushSubs = pushSubs.filter((s) => s.subscription.endpoint !== sub.endpoint);
      if (pushSubs.length >= MAX_PUSH_SUBS) pushSubs.shift();
      pushSubs.push({
        subscription: sub,
        addedAt: new Date().toISOString(),
        userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      });
      savePushSubs();
      lastNonIdleAt = Date.now();
      relayWatchers(); // a pager just came online: lift the gate immediately
      sendJson(res, 200, { ok: true, subscriptions: pushSubs.length });
    } catch (err) {
      sendJson(res, 400, { ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  if (method === "POST" && path === "/api/push/unsubscribe") {
    try {
      const body = await readJson<{ endpoint?: string }>(req);
      const before = pushSubs.length;
      pushSubs = pushSubs.filter((s) => s.subscription.endpoint !== body.endpoint);
      if (pushSubs.length !== before) savePushSubs();
      relayWatchers(); // possibly the last pager left: release the gate promptly
      sendJson(res, 200, { ok: true, subscriptions: pushSubs.length });
    } catch (err) {
      sendJson(res, 400, { ok: false, reason: err instanceof Error ? err.message : String(err) });
    }
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
// hub. Fires on the interval and immediately on client connect/disconnect or
// subscription change. A paired push device counts as one watcher, same
// precedent as the native-alert channel: the human is reachable, so prompts
// should route to Murmur instead of the terminal.
function relayWatchers(): void {
  const count = hubListeners.size + (pushSubs.length > 0 ? 1 : 0);
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

// Is the process already holding this port another hub? Probed over plain
// http and, when that fails and TLS is configured, over https with
// verification off (the cert names a tailnet host, not 127.0.0.1).
function probeFleetOnce(scheme: "http" | "https", port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const reqFn = scheme === "https" ? httpsRequest : httpRequest;
    const probe = reqFn(
      {
        host: "127.0.0.1",
        port,
        path: "/fleet",
        timeout: 400,
        ...(scheme === "https" ? { rejectUnauthorized: false } : {}),
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

async function probeIsHub(port: number): Promise<boolean> {
  if (await probeFleetOnce("http", port)) return true;
  return TLS_ON ? probeFleetOnce("https", port) : false;
}

// The port this hub actually bound, for the pair payload.
let boundPort = 0;

async function main(): Promise<void> {
  const preferred = parseInt(process.env["MURMUR_HUB_PORT"] ?? String(DEFAULT_HUB_PORT), 10);
  let port = Number.isFinite(preferred) && preferred > 0 ? preferred : DEFAULT_HUB_PORT;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: message });
    });
  };
  const server = TLS_ON
    ? createTlsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, handler)
    : createServer(handler);

  for (let attempts = 0; attempts < 20; attempts++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, LAN ? "0.0.0.0" : "127.0.0.1", () => {
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

  boundPort = port;
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

  log(`listening on ${SCHEME}://${LAN ? "0.0.0.0" : "127.0.0.1"}:${port}/${LAN ? " (LAN mode: token required off loopback)" : ""}`);

  // Outbound relay tunnel (MURMUR_RELAY): gives this machine a stable public
  // origin with the token enforced on every tunneled request.
  startTunnel(port);

  refreshRegistry();
  setInterval(refreshRegistry, REGISTRY_POLL_MS);

  // Debounced fleet broadcast: state frames arrive in bursts (every hook fire
  // rebroadcasts), so coalesce to at most one fleet event per window. The
  // pager rides the same tick: any newly pending question or permission goes
  // out to the paired push devices.
  setInterval(() => {
    detectAndPush();
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
