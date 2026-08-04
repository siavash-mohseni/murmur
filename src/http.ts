import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { Store, StateEvent } from "./state.js";
import { SESSION_KEY, SESSIONS_PATH } from "./state.js";
import { readTranscriptStats } from "./transcript.js";
import { readNewTranscriptMessages, type ScannedImage } from "./assistant-text.js";
import { saveImage, resolveImageFile } from "./image-store.js";
import type { ActivityImage } from "./shared-types.js";
import { isDesktopApp, openInBrowser } from "./browser-open.js";
import { lastSummaryFailure, requestOwnerSummary } from "./owner-summary.js";
import { memoryDirFor, scanMemoryDir } from "./memory.js";
import { listSessions, listAllSessions } from "./discovery.js";
import { preferredDashboardUrl } from "./hub-client.js";
import { hostAllowed, originAllowed } from "./auth.js";
import { renderSessionHtml, renderStateHtml } from "./export/render.js";

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

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = join(HERE, "..", "dist", "web");

// SSE keep-alive cadence. Lives here at the interval site, not only in
// index.ts, because this 5s timer is also what keeps the Node event loop
// alive (see the lifecycle note in index.ts). Any client-side reconnect or
// stale-connection timeout must stay in sync with this value.
const HEARTBEAT_INTERVAL_MS = 5_000;

// Path-traversal / session-key guard. A session key may contain only these
// characters, so it can never escape SESSIONS_PATH. Kept as a single shared
// regex so the GET and DELETE by-key handlers cannot drift.
const SESSION_KEY_RE = /[^A-Za-z0-9_-]/;

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// Loopback guard shared by every loopback-only endpoint. Returns true when the
// request is allowed to proceed. When it returns false it has already written
// the 403, so the caller just returns.
function requireLoopback(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, reason: "loopback only" });
    return false;
  }
  return true;
}

// Validate the ?key= query param for the by-key endpoints. Returns the key on
// success, or null after having written the 400 response.
function readValidKey(url: URL, res: ServerResponse): string | null {
  const key = url.searchParams.get("key") ?? "";
  if (!key || SESSION_KEY_RE.test(key)) {
    sendJson(res, 400, { ok: false, reason: "invalid key" });
    return null;
  }
  return key;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
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
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Read the request body and JSON.parse it as T. A read failure (payload too
// large, socket error) or a parse failure both reject, so every POST handler
// can share the single 400 catch arm in dispatch().
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  return JSON.parse(body) as T;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Send a raw string body that is already serialized JSON, setting
// content-length for parity with sendJson (the by-key passthrough avoids a
// re-parse but must still frame its response explicitly).
function sendRawJson(res: ServerResponse, status: number, raw: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, rel: string): Promise<boolean> {
  const safe = normalize(rel).replace(/^([./\\])+/, "");
  const path = join(WEB_DIR, safe);
  if (!path.startsWith(WEB_DIR)) {
    return false;
  }
  let st;
  try {
    st = await stat(path);
  } catch {
    return false;
  }
  if (!st.isFile()) {
    return false;
  }
  const ext = extname(path).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const bytes = await readFile(path);
  res.writeHead(200, {
    "content-type": mime,
    "content-length": st.size,
    "cache-control": "no-cache",
  });
  res.end(bytes);
  return true;
}

async function serveIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (await serveStatic(req, res, "index.html")) {
    return;
  }
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  res.end("Murmur UI not built. Run `bun run build` in ~/.claude/mcp-servers/murmur.");
}

export interface HttpHandle {
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(store: Store, port: number): Promise<HttpHandle> {
  const server = createServer(async (req, res) => {
    try {
      await route(store, req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { ok: false, reason: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const heartbeat = setInterval(() => store.emitHeartbeat(), HEARTBEAT_INTERVAL_MS);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        server.close(() => resolve());
      }),
  };
}

// A route handler runs after the dispatcher has matched method+pathname and
// (when flagged) enforced the loopback guard. It owns parsing and the response.
type RouteHandler = (
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) => void | Promise<void>;

interface RouteEntry {
  handler: RouteHandler;
  // When true, dispatch() runs requireLoopback before the handler.
  loopback?: boolean;
}

// Dispatch table keyed by `${method} ${pathname}`. Each entry isolates one
// endpoint. route() does the matching plus the static / 404 fallthrough so the
// per-request work is a single Map lookup instead of a linear if-chain.
const ROUTES: Record<string, RouteEntry> = {
  "GET /": { handler: (_store, req, res) => serveIndex(req, res) },
  "GET /index.html": { handler: (_store, req, res) => serveIndex(req, res) },
  "GET /state": { handler: (store, _req, res) => sendJson(res, 200, store.snapshot()) },
  // Cheap watcher probe for the question/permission hooks: is anyone actually
  // able to see a prompt routed to Murmur right now? `watching` is the single
  // boolean the hooks gate on (SSE tab connected OR native alerts on), so the
  // policy lives server-side and the hooks stay dumb.
  "GET /watchers": {
    handler: (store, _req, res) =>
      sendJson(res, 200, {
        ok: true,
        clients: store.clientCount(),
        native: store.nativeAlertsEnabled(),
        remote: store.remoteWatcherCount(),
        watching: store.hasWatchers(),
      }),
  },
  "GET /sessions": {
    handler: async (store, _req, res) => {
      const list = await listSessions({
        key: SESSION_KEY,
        claudeSessionId: store.state.sessionInfo.claudeSessionId,
        branch: store.state.sessionInfo.branch,
        cwdBasename: store.state.sessionInfo.cwdBasename,
        cwd: store.state.sessionInfo.cwd,
        startedAt: store.state.startedAt,
      });
      sendJson(res, 200, list);
    },
  },
  "GET /sessions/all": {
    handler: async (_store, _req, res) => {
      const list = await listAllSessions();
      sendJson(res, 200, list);
    },
  },
  "GET /sessions/by-key": { handler: handleGetByKey },
  "DELETE /sessions/by-key": { handler: handleDeleteByKey, loopback: true },
  "GET /events": { handler: handleEvents },
  "POST /sync": { handler: handleSyncRoute, loopback: true },
  "POST /watchers/remote": { handler: handleRemoteWatchers, loopback: true },
  "POST /api/autoopen": { handler: handleAutoOpen, loopback: true },
  // The answer endpoints act on the agent (inject text, approve commands), so
  // they carry the loopback flag at the handler level too: the 127.0.0.1 bind
  // already guarantees it, but the flag keeps the invariant explicit if the
  // bind ever changes. The hub proxy connects over loopback, so the fleet
  // view keeps working through it.
  "POST /api/answer": { handler: handleAnswer, loopback: true },
  "POST /api/cancel": { handler: handleCancel, loopback: true },
  "POST /permission/ask": { handler: handlePermissionAsk, loopback: true },
  // One-shot probe for the question hook: `fallback: true` exactly once after
  // a failed murmur_ask, so the hook lets that single AskUserQuestion through
  // instead of blocking the documented fallback (no request body).
  "POST /question/fallback": {
    handler: (store, _req, res) => sendJson(res, 200, { ok: true, fallback: store.consumeAskFallback() }),
    loopback: true,
  },
  "POST /api/alerts/native": { handler: handleNativeAlerts, loopback: true },
  "POST /api/permission/answer": { handler: handlePermissionAnswer, loopback: true },
  "POST /api/owner/summary": { handler: handleOwnerSummary, loopback: true },
  "POST /api/notify": { handler: handleNotify, loopback: true },
  "POST /api/notify/read": { handler: handleNotifyRead, loopback: true },
  "POST /api/notify/dismiss": { handler: handleNotifyDismiss, loopback: true },
};

async function route(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const method = req.method ?? "GET";

  // Browser-borne attacks on the loopback surface: reject Host headers that
  // don't name this machine (DNS rebinding) and mutating requests whose
  // Origin is a foreign website (CSRF; loopback is reachable from any page
  // the user has open, and CORS only blocks reads, not sends).
  if (!hostAllowed(req)) {
    sendJson(res, 403, { ok: false, reason: "unrecognized host" });
    return;
  }
  if ((method === "POST" || method === "DELETE") && !originAllowed(req)) {
    sendJson(res, 403, { ok: false, reason: "cross-origin request rejected" });
    return;
  }

  const entry = ROUTES[`${method} ${url.pathname}`];
  if (entry) {
    if (entry.loopback && !requireLoopback(req, res)) {
      return;
    }
    // POST handlers parse the body and turn a parse failure into a 400, sharing
    // the single catch arm here instead of repeating it per handler.
    if (method === "POST") {
      try {
        await entry.handler(store, req, res, url);
      } catch (err) {
        sendJson(res, 400, { ok: false, reason: (err as Error).message });
      }
      return;
    }
    await entry.handler(store, req, res, url);
    return;
  }

  // Self-contained session export: the same HTML the Share buttons build,
  // rendered server-side with images inlined as data URIs. The session's own
  // key renders from the live snapshot (includes un-persisted mutations);
  // any other key renders from its persisted state file, so past sessions
  // export too. ?kind=data selects the dense dump over the narrative summary.
  // PII redaction is on by default, ?redact=0 opts out.
  if (method === "GET" && url.pathname.startsWith("/export/")) {
    const m = url.pathname.match(/^\/export\/([A-Za-z0-9_-]+)\.html$/);
    if (!m) {
      sendJson(res, 400, { ok: false, reason: "expected /export/<key>.html" });
      return;
    }
    const kind = url.searchParams.get("kind") === "data" ? "data" : "summary";
    const opts = { redact: url.searchParams.get("redact") !== "0" };
    const html =
      m[1] === SESSION_KEY
        ? renderStateHtml(store.snapshot(), SESSION_KEY, kind, opts)
        : renderSessionHtml(m[1]!, kind, opts);
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

  // Saved transcript images, content-addressed under the session image store.
  // Dynamic path, so it's matched by prefix here rather than in the exact-match
  // ROUTES table. The bytes are immutable per id, so cache them hard.
  if (method === "GET" && url.pathname.startsWith("/api/image/")) {
    const resolved = resolveImageFile(url.pathname.slice("/api/image/".length));
    if (resolved) {
      try {
        const bytes = await readFile(resolved.path);
        res.writeHead(200, {
          "content-type": resolved.mime,
          "content-length": bytes.length,
          "cache-control": "public, max-age=31536000, immutable",
        });
        res.end(bytes);
        return;
      } catch {
        // fall through to 404 if the file vanished between resolve and read
      }
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  // Static fallthrough: /assets/* and any other GET path resolve under WEB_DIR.
  if (method === "GET") {
    const rel = url.pathname.replace(/^\//, "");
    if (rel && (await serveStatic(req, res, rel))) {
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

async function handleGetByKey(
  _store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const key = readValidKey(url, res);
  if (key === null) return;
  const path = join(SESSIONS_PATH, `${key}.json`);
  if (!existsSync(path)) {
    sendJson(res, 404, { ok: false, reason: "not found" });
    return;
  }
  try {
    const raw = await readFile(path, "utf8");
    sendRawJson(res, 200, raw);
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: (err as Error).message });
  }
}

async function handleDeleteByKey(
  store: Store,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const key = readValidKey(url, res);
  if (key === null) return;
  if (key === SESSION_KEY || key === store.state.sessionInfo.claudeSessionId) {
    sendJson(res, 409, { ok: false, reason: "cannot delete the live session" });
    return;
  }
  const portFile = join(SESSIONS_PATH, `${key}.port`);
  if (existsSync(portFile)) {
    sendJson(res, 409, { ok: false, reason: "session still has a port file; close it first" });
    return;
  }
  const removed: string[] = [];
  try {
    const all = (await readdir(SESSIONS_PATH)).filter(
      (f) => f === `${key}.json` || f.startsWith(`${key}.`)
    );
    for (const f of all) {
      try {
        await unlink(join(SESSIONS_PATH, f));
        removed.push(f);
      } catch {
        // best-effort: skip files we can't remove
      }
    }
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: (err as Error).message });
    return;
  }
  if (removed.length === 0) {
    sendJson(res, 404, { ok: false, reason: "not found" });
    return;
  }
  sendJson(res, 200, { ok: true, removed });
}

function handleEvents(store: Store, req: IncomingMessage, res: ServerResponse, url: URL): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const write = (event: StateEvent): void => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  // role=mirror marks a machine subscriber (the hub's fleet tail). It receives
  // every event but is excluded from the client count, so a hub connection
  // alone never convinces the watcher gate that a human can see a prompt.
  const mirror = url.searchParams.get("role") === "mirror";
  const unsubscribe = store.subscribe(write, { mirror });
  // Guard so cleanup runs at most once, then unsubscribe on every terminal
  // signal. req.on("close") covers the normal case; res "close"/"error" catch
  // a socket that aborts/errors without a request "close", which would
  // otherwise leak the listener forever.
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

function handleSyncRoute(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  return readJson<SyncPayload>(req).then((payload) => {
    handleSync(store, payload);
    sendJson(res, 200, { ok: true });
  });
}

// Remote-watcher heartbeat from the hub: "N humans can currently see this
// session through me" (a fleet tab is open, or later a push subscription is
// live). The freshness window lives in the store, so a hub that dies simply
// stops counting. Loopback-only: the hub runs on this machine.
async function handleRemoteWatchers(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = await readJson<{ count?: unknown }>(req);
  if (typeof parsed.count !== "number" || !Number.isFinite(parsed.count) || parsed.count < 0) {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  store.setRemoteWatchers(Math.floor(parsed.count));
  sendJson(res, 200, { ok: true, watching: store.hasWatchers() });
}

// MURMUR_AUTO always-on mode: the user-prompt hook fires this on every prompt
// when the env flag is set, and the dedupe lives HERE so the hook stays dumb.
// The browser is launched at most once per server lifetime, and only when no
// tab is already connected, so an always-on user gets exactly one tab per
// session instead of one per prompt. No request body: the hook POSTs empty.
let autoOpenedOnce = false;
async function handleAutoOpen(store: Store, _req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (autoOpenedOnce || store.clientCount() > 0) {
    sendJson(res, 200, { ok: true, opened: false });
    return;
  }
  const port = store.state.port;
  if (!port) {
    sendJson(res, 200, { ok: false, opened: false, reason: "no port bound yet" });
    return;
  }
  // Same preference as murmur_open: the hub's drill-down route when a hub is
  // alive, so AUTO mode and manual activation land on the same origin.
  const url = await preferredDashboardUrl(SESSION_KEY, port);
  // Desktop app: the in-app Browser pane is the target and only the model can
  // drive it, so return the URL for the hook to inject as an open instruction.
  // autoOpenedOnce stays false so the instruction repeats until a pane
  // actually connects (clientCount takes over the dedupe from then on).
  if (isDesktopApp()) {
    sendJson(res, 200, { ok: true, opened: false, desktop: true, url });
    return;
  }
  autoOpenedOnce = true;
  openInBrowser(url);
  sendJson(res, 200, { ok: true, opened: true });
}

async function handleAnswer(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJson<{ questionId: string; answer: string }>(req);
  if (typeof parsed.questionId !== "string" || typeof parsed.answer !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const ok = store.resolvePending(parsed.questionId, parsed.answer);
  sendJson(res, ok ? 200 : 409, { ok });
}

async function handleCancel(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJson<{ questionId: string }>(req);
  if (typeof parsed.questionId !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const ok = store.cancelPending(parsed.questionId);
  sendJson(res, ok ? 200 : 409, { ok });
}

// Append a routine notification to the global feed. Loopback-only: this is a
// local ingest for cron routines and the notify helper, not a public API.
async function handleNotify(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJson<{ title: string; body: string; link?: string; source?: string }>(req);
  if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
    sendJson(res, 400, { ok: false, reason: "title and body are required" });
    return;
  }
  const n = store.addNotification({
    title: parsed.title,
    body: parsed.body,
    link: typeof parsed.link === "string" ? parsed.link : undefined,
    source: typeof parsed.source === "string" ? parsed.source : undefined,
  });
  sendJson(res, 200, { ok: true, id: n.id });
}

async function handleNotifyRead(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJson<{ id: string; read?: boolean }>(req);
  if (typeof parsed.id !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const ok = store.markNotificationRead(parsed.id, parsed.read !== false);
  sendJson(res, ok ? 200 : 404, { ok });
}

async function handleNotifyDismiss(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const parsed = await readJson<{ id: string }>(req);
  if (typeof parsed.id !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const ok = store.dismissNotification(parsed.id);
  sendJson(res, ok ? 200 : 404, { ok });
}

async function handlePermissionAsk(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = await readJson<{
    tool: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }>(req);
  if (typeof parsed.tool !== "string" || typeof parsed.command !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const timeoutMs = parsed.timeoutMs ?? 120_000;
  const result = await store.askPermission(
    { tool: parsed.tool, command: parsed.command, cwd: parsed.cwd },
    timeoutMs
  );
  sendJson(res, 200, result);
}

// Plain-language summary for one owner-view Claude beat. The dashboard requests
// a summary per visible beat; we return the cached line, or "pending" while a
// worker generates it (the client retries), or "unavailable" so the client
// stops asking and shows the raw text. Does not touch store state.
// Reasons already logged, so a dashboard polling every visible beat writes one
// line per distinct failure instead of one per request.
const warnedSummaryFailures = new Set<string>();

async function handleOwnerSummary(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = await readJson<{ id?: unknown; text?: unknown }>(req);
  if (typeof parsed.id !== "string" || typeof parsed.text !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const result = requestOwnerSummary(parsed.id, parsed.text);
  const failure = lastSummaryFailure();
  if (result.status === "unavailable" && failure && !warnedSummaryFailures.has(failure)) {
    warnedSummaryFailures.add(failure);
    store.appendWarning(
      `Owner-view summaries are failing. The nested claude CLI said: ${failure}. ` +
        `Summaries shell out to your local Claude Code auth, so an expired login disables them until you sign in again.`
    );
  }
  sendJson(res, 200, result);
}

async function handleNativeAlerts(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // `enabled` must be an explicit boolean. Coercing any shape (the old `!!`
  // behavior) let a malformed body — {}, {enabled:null}, or a typo'd field name
  // from a stale client — silently flip the pref to OFF and disable native
  // alerts the user had turned on. Reject those instead so the stored pref only
  // ever changes on a well-formed request.
  const parsed = await readJson<{ enabled?: unknown }>(req);
  if (typeof parsed.enabled !== "boolean") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  store.setNativeAlerts(parsed.enabled);
  sendJson(res, 200, { ok: true, nativeAlerts: store.nativeAlertsEnabled() });
}

async function handlePermissionAnswer(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = await readJson<{
    permissionId: string;
    decision: "allow" | "always" | "deny";
  }>(req);
  if (typeof parsed.permissionId !== "string" || typeof parsed.decision !== "string") {
    sendJson(res, 400, { ok: false, reason: "invalid body" });
    return;
  }
  const ok = store.resolvePermission(parsed.permissionId, parsed.decision);
  sendJson(res, ok ? 200 : 409, { ok });
}

type SyncPayload =
  | { type: "task-create"; label: string; title?: string }
  | { type: "task-update"; label: string; status: import("./state.js").RowStatus; detail?: string }
  | { type: "log"; message: string }
  | {
      type: "tool";
      tool: string;
      target?: string;
      durationMs?: number;
      ok?: boolean;
      detail?: string;
      runInBackground?: boolean;
    }
  | {
      type: "agent";
      subagentType?: string;
      description: string;
      durationMs?: number;
      ok?: boolean;
    }
  | {
      type: "prompt";
      source: "user" | "ask" | "murmur" | "permission" | "assistant";
      question: string;
      answer?: string;
      ok?: boolean;
    }
  | {
      type: "hook";
      hook: string;
      event?: string;
      detail?: string;
      ok?: boolean;
    }
  | { type: "session"; info: Partial<import("./state.js").SessionInfo> }
  | { type: "transcript"; path: string };

// Collapse a prompt to a comparison key for cross-source dedup. The hook saves
// the raw prompt (with any "[Image #N]" prefixes and original whitespace); the
// transcript scan saves a code-stripped first paragraph. Normalising both —
// lowercased, image markers and whitespace removed, capped — lets the same
// message captured by both paths match and collapse to one row.
// Write each scanned base64 image to the image store and collect the light
// references the dashboard renders. Failed/unsupported saves are dropped so a
// row never carries a broken reference.
function toActivityImages(imgs: ScannedImage[] | undefined): ActivityImage[] {
  if (!imgs || imgs.length === 0) return [];
  const out: ActivityImage[] = [];
  for (const im of imgs) {
    const saved = saveImage(im.data, im.mediaType, im.source);
    if (saved) out.push(saved);
  }
  return out;
}

function normalizePrompt(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\[image #\d+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function handleSync(store: Store, payload: SyncPayload): void {
  if (payload.type === "task-create") {
    store.addRow(payload.label, payload.title);
    return;
  }
  if (payload.type === "task-update") {
    store.updateRow(payload.label, payload.status, payload.detail);
    return;
  }
  if (payload.type === "log") {
    store.appendLog(payload.message);
    return;
  }
  if (payload.type === "tool") {
    store.addActivity({
      kind: "tool",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      tool: payload.tool,
      target: payload.target,
      durationMs: payload.durationMs,
      ok: payload.ok ?? true,
      detail: payload.detail,
      runInBackground: payload.runInBackground,
    });
    return;
  }
  if (payload.type === "agent") {
    store.addActivity({
      kind: "agent",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      subagentType: payload.subagentType,
      description: payload.description,
      durationMs: payload.durationMs,
      ok: payload.ok,
    });
    return;
  }
  if (payload.type === "prompt") {
    // A mirrored AskUserQuestion means the fallback was used (or the CLI
    // prompt was reachable anyway), so a still-armed failure flag is stale:
    // without this clear it would leak one CLI prompt much later.
    if (payload.source === "ask") store.consumeAskFallback();
    store.addActivity({
      kind: "prompt",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      source: payload.source,
      question: payload.question,
      answer: payload.answer,
      ok: payload.ok,
    });
    return;
  }
  if (payload.type === "hook") {
    store.addActivity({
      kind: "hook",
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      hook: payload.hook,
      event: payload.event,
      detail: payload.detail,
      ok: payload.ok,
    });
    return;
  }
  if (payload.type === "session") {
    if (payload.info.claudeSessionId) {
      store.observeClaudeSession(payload.info.claudeSessionId);
    }
    store.setSessionInfo(payload.info);
    refreshMemory(store);
    return;
  }
  if (payload.type === "transcript") {
    const sinceMs = store.state.startedAt
      ? Date.parse(store.state.startedAt) || 0
      : 0;
    const stats = readTranscriptStats(payload.path, sinceMs);
    if (stats) {
      store.setTokenStats(stats);
    }
    // Mirror user prompts and assistant replies appended since the last scan
    // as prompt activities. The scanner's cursor primes on first sight of a
    // path, so a fresh Murmur process doesn't re-flood the feed.
    const fresh = readNewTranscriptMessages(payload.path);
    if (fresh.length > 0) {
      const seen = new Set(store.state.activities.map((a) => a.id));
      // The UserPromptSubmit hook already records normal prompts the instant
      // they're submitted; the transcript scan is the catch-all for queued /
      // interrupt prompts it misses. Dedupe the two by normalised content so a
      // normal prompt captured by both paths shows only once.
      const recentUserKeys = new Set<string>();
      for (const a of store.state.activities.slice(-200)) {
        if (a.kind === "prompt" && a.source === "user") {
          recentUserKeys.add(normalizePrompt(a.question));
        }
      }
      for (const entry of fresh) {
        if (seen.has(entry.uuid)) continue;
        const images = toActivityImages(entry.images);
        if (entry.role === "user") {
          const key = normalizePrompt(entry.summary);
          if (recentUserKeys.has(key)) {
            // Hook already recorded this prompt text-only (it never sees
            // attachments). If the transcript copy carries images, fold them
            // into that existing row instead of dropping it as a duplicate.
            if (images.length > 0) {
              const target = store.state.activities
                .slice()
                .reverse()
                .find(
                  (a) =>
                    a.kind === "prompt" &&
                    a.source === "user" &&
                    normalizePrompt(a.question) === key
                );
              if (target) store.mergeActivityImages(target.id, images);
            }
            continue;
          }
          // Track as we go so a message captured twice in one batch (e.g. a
          // queued op plus its later user line) collapses to a single row.
          recentUserKeys.add(key);
        }
        store.addActivity({
          kind: "prompt",
          id: entry.uuid,
          timestamp: new Date().toISOString(),
          source: entry.role,
          question: entry.summary,
          ...(entry.outline ? { outline: entry.outline } : {}),
          ...(images.length > 0 ? { images } : {}),
        });
      }
    }
    refreshMemory(store);
  }
}

function refreshMemory(store: Store): void {
  const cwd = store.state.sessionInfo.cwd;
  if (!cwd) return;
  const dir = memoryDirFor(cwd);
  const started = store.state.sessionInfo.claudeSessionStartedAt;
  const sessionStartMs = started ? new Date(started).getTime() : Date.now();
  const entries = scanMemoryDir(
    dir,
    store.state.sessionInfo.claudeSessionId,
    sessionStartMs
  );
  store.setMemoryEntries(entries);
}
