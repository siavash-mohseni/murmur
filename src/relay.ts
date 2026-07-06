#!/usr/bin/env node
// relay.ts: the Murmur relay — the off-LAN layer. Hubs connect OUTBOUND over
// a WebSocket (so no ports open on the laptop), each gets a stable public
// origin at <machine-id>.<relay-host>, and phone traffic forwards over the
// tunnel with responses streamed (SSE included). The relay never holds the
// machine token: authorization happens at the hub on every tunneled request,
// so a compromised or malicious relay can watch ciphertext-free traffic
// shapes but cannot drive sessions.
//
// It also hosts replays: POST a self-contained export, get an expiring share
// link. This is the whole hosted product in one self-hostable binary
// (dist/relay.js / `murmur-relay`), which is the trust story: run it on your
// own box behind your own TLS, or use a hosted one.
//
// Configuration (env):
//   MURMUR_RELAY_PORT        listen port (default 8484)
//   MURMUR_RELAY_PUBLIC      public base origin, e.g. https://relay.example
//                            (machine origins become https://<id>.relay.example)
//   MURMUR_RELAY_KEYS        comma-separated access keys; when set, hubs must
//                            present one and replay uploads must bearer it
//   MURMUR_RELAY_DATA        data dir (default ~/.murmur-relay)
//   MURMUR_RELAY_MAX_REPLAY  replay size cap in bytes (default 5 MB)
//   MURMUR_TLS_CERT/KEY      serve TLS directly (else terminate at a proxy)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acceptWebSocket, type WsConnection } from "./ws.js";
import {
  HOP_BY_HOP,
  MACHINE_ID_RE,
  TUNNEL_PROTOCOL_VERSION,
  type HelloMsg,
  type TunnelMsg,
} from "./tunnel-protocol.js";

const PORT = parsePort(process.env["MURMUR_RELAY_PORT"], 8484);
const TLS_CERT = process.env["MURMUR_TLS_CERT"] ?? "";
const TLS_KEY = process.env["MURMUR_TLS_KEY"] ?? "";
const TLS_ON = TLS_CERT.length > 0 && TLS_KEY.length > 0;
const DATA_DIR = process.env["MURMUR_RELAY_DATA"] ?? join(homedir(), ".murmur-relay");
const REPLAYS_DIR = join(DATA_DIR, "replays");
const MACHINES_FILE = join(DATA_DIR, "machines.json");
const MAX_REPLAY_BYTES = parseInt(process.env["MURMUR_RELAY_MAX_REPLAY"] ?? "", 10) || 5 * 1024 * 1024;
const MAX_TUNNEL_BODY = 10 * 1024 * 1024;
const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 30;
const HEAD_TIMEOUT_MS = 30_000;
const IDLE_TUNNEL_MS = 90_000;

const ACCESS_KEYS = (process.env["MURMUR_RELAY_KEYS"] ?? "")
  .split(",")
  .map((k) => k.trim())
  .filter((k) => k.length > 0);

const log = (msg: string): void => console.error(`[murmur-relay] ${msg}`);

function parsePort(raw: string | undefined, fallback: number): number {
  const p = parseInt(raw ?? "", 10);
  return Number.isFinite(p) && p > 0 ? p : fallback;
}

const PUBLIC_BASE = (() => {
  const raw = process.env["MURMUR_RELAY_PUBLIC"];
  if (raw) {
    try {
      const u = new URL(raw);
      return { scheme: u.protocol.replace(":", ""), host: u.host };
    } catch {
      log(`ignoring unparseable MURMUR_RELAY_PUBLIC: ${raw}`);
    }
  }
  // *.localhost resolves to loopback in browsers (RFC 6761), which makes the
  // default usable for local trials without any DNS setup.
  return { scheme: TLS_ON ? "https" : "http", host: `localhost:${PORT}` };
})();

const machineOrigin = (id: string): string => `${PUBLIC_BASE.scheme}://${id}.${PUBLIC_BASE.host}`;

function keyMatches(candidate: string | undefined): boolean {
  if (ACCESS_KEYS.length === 0) return true;
  if (!candidate) return false;
  const got = Buffer.from(candidate);
  return ACCESS_KEYS.some((k) => {
    const want = Buffer.from(k);
    return want.length === got.length && timingSafeEqual(want, got);
  });
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// --- machine registry (id -> secret hash), persisted across restarts ---------------

let machineSecrets: Record<string, string> = {};
try {
  machineSecrets = JSON.parse(readFileSync(MACHINES_FILE, "utf8")) as Record<string, string>;
} catch {
  machineSecrets = {};
}
function saveMachineSecrets(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(MACHINES_FILE, JSON.stringify(machineSecrets, null, 2), { mode: 0o600 });
  } catch (err) {
    log(`could not persist machine registry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface LiveMachine {
  conn: WsConnection;
  name?: string;
  connectedAt: number;
  lastSeenAt: number;
}
const live = new Map<string, LiveMachine>();

// --- tunneled responses -----------------------------------------------------------

interface PendingResponse {
  res: ServerResponse;
  machine: string;
  headWritten: boolean;
  headTimer: NodeJS.Timeout | null;
}
let nextReqId = 1;
const pending = new Map<number, PendingResponse>();

function failPending(id: number, status: number, reason: string): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.headTimer) clearTimeout(p.headTimer);
  if (!p.headWritten) {
    sendJson(p.res, status, { ok: false, reason });
  } else {
    p.res.end();
  }
}

function failAllForMachine(id: string): void {
  for (const [reqId, p] of pending) {
    if (p.machine === id) failPending(reqId, 502, "machine disconnected");
  }
}

// --- helpers -----------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    // response already gone
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Pause rather than destroy: destroying the socket here would RST the
        // connection before the 413 is written and the client would see a
        // reset instead of the answer. The 413 path closes the connection
        // after the response flushes.
        req.pause();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// 413 with connection: close, so the paused request body is discarded when
// the socket winds down after the response reaches the client.
function sendTooLarge(res: ServerResponse, reason: string): void {
  const payload = JSON.stringify({ ok: false, reason });
  try {
    res.writeHead(413, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      connection: "close",
    });
    res.end(payload);
  } catch {
    // response already gone
  }
}

// The first DNS label names the machine when it differs from the apex host.
function machineIdFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const hostname = hostHeader.split(":")[0]!.toLowerCase();
  const apexname = PUBLIC_BASE.host.split(":")[0]!.toLowerCase();
  if (hostname === apexname) return null;
  const label = hostname.split(".")[0]!;
  return MACHINE_ID_RE.test(label) ? label : null;
}

// --- tunnel request forwarding ------------------------------------------------------

async function forwardToMachine(
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const machine = live.get(id);
  if (!machine) {
    sendJson(res, id in machineSecrets ? 502 : 404, {
      ok: false,
      reason: id in machineSecrets ? "machine offline" : "no such machine",
    });
    return;
  }
  const body = await readBody(req, MAX_TUNNEL_BODY).catch(() => null);
  if (body === "too-large") {
    sendTooLarge(res, "request body too large");
    return;
  }
  if (body === null) return; // client vanished mid-body

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || typeof v !== "string") continue;
    headers[key] = v;
  }
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = PUBLIC_BASE.scheme;

  const reqId = nextReqId++;
  const entry: PendingResponse = {
    res,
    machine: id,
    headWritten: false,
    headTimer: setTimeout(() => failPending(reqId, 504, "machine did not answer"), HEAD_TIMEOUT_MS),
  };
  pending.set(reqId, entry);
  res.on("close", () => {
    if (pending.has(reqId)) {
      pending.delete(reqId);
      if (entry.headTimer) clearTimeout(entry.headTimer);
      machine.conn.send(JSON.stringify({ type: "req-abort", id: reqId }));
    }
  });
  machine.conn.send(
    JSON.stringify({
      type: "req",
      id: reqId,
      method: req.method ?? "GET",
      path: url.pathname + url.search,
      headers,
      body: body.length > 0 ? body.toString("base64") : undefined,
    })
  );
}

function onTunnelMessage(id: string, msg: TunnelMsg): void {
  const machine = live.get(id);
  if (machine) machine.lastSeenAt = Date.now();
  switch (msg.type) {
    case "ping": {
      machine?.conn.send(JSON.stringify({ type: "pong", at: msg.at }));
      return;
    }
    case "res-head": {
      const p = pending.get(msg.id);
      if (!p) return;
      if (p.headTimer) clearTimeout(p.headTimer);
      p.headTimer = null;
      p.headWritten = true;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(msg.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
      }
      try {
        p.res.writeHead(msg.status, headers);
        p.res.flushHeaders();
      } catch {
        pending.delete(msg.id);
      }
      return;
    }
    case "res-chunk": {
      const p = pending.get(msg.id);
      if (!p) return;
      try {
        p.res.write(Buffer.from(msg.chunk, "base64"));
      } catch {
        pending.delete(msg.id);
      }
      return;
    }
    case "res-end": {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (p.headTimer) clearTimeout(p.headTimer);
      try {
        p.res.end();
      } catch {
        // client already gone
      }
      return;
    }
    default:
      return;
  }
}

// --- tunnel registration -------------------------------------------------------------

function handleTunnelConnection(conn: WsConnection): void {
  let registered: string | null = null;
  const helloTimer = setTimeout(() => {
    if (!registered) conn.close(1002, "hello timeout");
  }, 10_000);

  conn.onMessage((text) => {
    let msg: TunnelMsg;
    try {
      msg = JSON.parse(text) as TunnelMsg;
    } catch {
      conn.close(1002, "bad json");
      return;
    }
    if (!registered) {
      if (msg.type !== "hello") {
        conn.close(1002, "expected hello");
        return;
      }
      const hello = msg as HelloMsg;
      if (hello.v !== TUNNEL_PROTOCOL_VERSION) {
        conn.send(JSON.stringify({ type: "error", reason: `unsupported protocol v${hello.v}` }));
        conn.close(1002, "version");
        return;
      }
      if (!keyMatches(hello.key)) {
        conn.send(JSON.stringify({ type: "error", reason: "invalid relay access key" }));
        conn.close(1008, "key");
        return;
      }
      if (!MACHINE_ID_RE.test(hello.machine) || typeof hello.secret !== "string" || hello.secret.length < 16) {
        conn.send(JSON.stringify({ type: "error", reason: "invalid machine id or secret" }));
        conn.close(1008, "machine");
        return;
      }
      const hash = sha256(hello.secret);
      const known = machineSecrets[hello.machine];
      if (known && known !== hash) {
        // Someone is presenting a known machine's id without its secret:
        // refuse, or the phone's next request (with its token cookie) would
        // be delivered to an impostor.
        conn.send(JSON.stringify({ type: "error", reason: "machine id is registered to a different secret" }));
        conn.close(1008, "hijack");
        return;
      }
      if (!known) {
        machineSecrets[hello.machine] = hash;
        saveMachineSecrets();
      }
      // A previous connection for the same machine (hub restart, network
      // flap) is superseded by the newer one.
      const prior = live.get(hello.machine);
      if (prior) prior.conn.close(1000, "superseded");
      registered = hello.machine;
      clearTimeout(helloTimer);
      live.set(hello.machine, {
        conn,
        name: hello.name,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      conn.send(JSON.stringify({ type: "ready", url: machineOrigin(hello.machine) }));
      log(`machine ${hello.machine}${hello.name ? ` (${hello.name})` : ""} connected`);
      return;
    }
    onTunnelMessage(registered, msg);
  });

  conn.onClose(() => {
    clearTimeout(helloTimer);
    if (registered && live.get(registered)?.conn === conn) {
      live.delete(registered);
      failAllForMachine(registered);
      log(`machine ${registered} disconnected`);
    }
  });
}

// --- replays ---------------------------------------------------------------------------

interface ReplayMeta {
  expiresAt: number;
  createdAt: number;
  size: number;
}

function replayPaths(id: string): { html: string; meta: string } {
  return { html: join(REPLAYS_DIR, `${id}.html`), meta: join(REPLAYS_DIR, `${id}.json`) };
}

async function handleReplayUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  if (!keyMatches(bearer)) {
    sendJson(res, 401, { ok: false, reason: "relay access key required" });
    return;
  }
  const body = await readBody(req, MAX_REPLAY_BYTES).catch(() => null);
  if (body === "too-large") {
    sendTooLarge(res, `replay exceeds ${MAX_REPLAY_BYTES} bytes`);
    return;
  }
  if (body === null || body.length === 0) {
    sendJson(res, 400, { ok: false, reason: "empty body" });
    return;
  }
  // ttl in days for real use; ttlSeconds exists for tests and short-lived links.
  const ttlSeconds = parseInt(url.searchParams.get("ttlSeconds") ?? "", 10);
  const ttlDays = parseFloat(url.searchParams.get("ttl") ?? "");
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.min(ttlSeconds, MAX_TTL_DAYS * 86_400) * 1000
    : (Number.isFinite(ttlDays) && ttlDays > 0 ? Math.min(ttlDays, MAX_TTL_DAYS) : DEFAULT_TTL_DAYS) * 86_400_000;

  const id = randomBytes(12).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14) || randomBytes(8).toString("hex");
  const meta: ReplayMeta = { expiresAt: Date.now() + ttlMs, createdAt: Date.now(), size: body.length };
  mkdirSync(REPLAYS_DIR, { recursive: true });
  const paths = replayPaths(id);
  writeFileSync(paths.html, body);
  writeFileSync(paths.meta, JSON.stringify(meta));
  sendJson(res, 200, {
    ok: true,
    id,
    url: `${PUBLIC_BASE.scheme}://${PUBLIC_BASE.host}/r/${id}`,
    expiresAt: new Date(meta.expiresAt).toISOString(),
  });
}

function handleReplayGet(res: ServerResponse, id: string): void {
  if (!/^[a-z0-9]{8,20}$/.test(id)) {
    sendJson(res, 400, { ok: false, reason: "invalid replay id" });
    return;
  }
  const paths = replayPaths(id);
  let meta: ReplayMeta | null = null;
  try {
    meta = JSON.parse(readFileSync(paths.meta, "utf8")) as ReplayMeta;
  } catch {
    meta = null;
  }
  // Lazy expiry: the deadline is enforced at read time, the sweep only
  // reclaims disk.
  if (!meta || meta.expiresAt <= Date.now() || !existsSync(paths.html)) {
    for (const p of [paths.html, paths.meta]) {
      try {
        unlinkSync(p);
      } catch {
        // already gone
      }
    }
    sendJson(res, 404, { ok: false, reason: "replay not found or expired" });
    return;
  }
  const bytes = readFileSync(paths.html);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": bytes.length,
    "cache-control": "private, max-age=300",
    "x-robots-tag": "noindex",
  });
  res.end(bytes);
}

function sweepReplays(): void {
  let files: string[] = [];
  try {
    files = readdirSync(REPLAYS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  const now = Date.now();
  for (const f of files) {
    try {
      const meta = JSON.parse(readFileSync(join(REPLAYS_DIR, f), "utf8")) as ReplayMeta;
      if (meta.expiresAt <= now) {
        unlinkSync(join(REPLAYS_DIR, f));
        unlinkSync(join(REPLAYS_DIR, f.replace(/\.json$/, ".html")));
      }
    } catch {
      // skip unreadable entries
    }
  }
}

// --- HTTP surface ------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  const machineId = machineIdFromHost(req.headers.host);
  if (machineId) {
    await forwardToMachine(machineId, req, res, url);
    return;
  }

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, machines: live.size });
    return;
  }
  if (method === "POST" && url.pathname === "/replays") {
    await handleReplayUpload(req, res, url);
    return;
  }
  if (method === "GET" && url.pathname.startsWith("/r/")) {
    handleReplayGet(res, url.pathname.slice(3));
    return;
  }
  if (method === "GET" && url.pathname === "/") {
    const text = `Murmur relay.\n\nmachines connected: ${live.size}\nreplays: POST /replays, GET /r/<id>\ntunnel: WebSocket at /tunnel\n`;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

function main(): void {
  mkdirSync(REPLAYS_DIR, { recursive: true });
  if (ACCESS_KEYS.length === 0) {
    log("no MURMUR_RELAY_KEYS configured: any hub may register and anyone may upload replays");
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    route(req, res).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    });
  };
  const server = TLS_ON
    ? createTlsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, handler)
    : createServer(handler);

  server.on("upgrade", (req, socket) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/tunnel") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const conn = acceptWebSocket(req, socket, { maxMessageBytes: 16 * 1024 * 1024 });
    if (conn) handleTunnelConnection(conn);
  });

  server.listen(PORT, () => {
    log(`listening on ${PUBLIC_BASE.scheme}://${PUBLIC_BASE.host} (port ${PORT})`);
  });

  sweepReplays();
  setInterval(sweepReplays, 3_600_000);

  // Drop tunnels that have gone silent (hubs ping every 25s).
  setInterval(() => {
    const cutoff = Date.now() - IDLE_TUNNEL_MS;
    for (const [id, m] of live) {
      if (m.lastSeenAt < cutoff) {
        log(`machine ${id} idle, closing tunnel`);
        m.conn.close(1001, "idle");
      }
    }
  }, 30_000);
}

main();
