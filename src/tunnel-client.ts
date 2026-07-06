// tunnel-client.ts: the hub's outbound connection to a Murmur relay
// (src/relay.ts). Activated by MURMUR_RELAY, e.g. wss://relay.example or
// ws://127.0.0.1:8484. The hub dials OUT, so nothing on the laptop listens
// beyond loopback, and the relay assigns this machine a stable public origin.
//
// Every tunneled request is replayed against the hub's own HTTP surface with
// an `x-murmur-tunneled` marker, which auth.ts treats as NOT loopback: the
// machine token is therefore enforced on relay traffic exactly as on the LAN,
// and the relay itself never holds a credential that can drive sessions.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, type ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";
import {
  HOP_BY_HOP,
  TUNNEL_PROTOCOL_VERSION,
  type ReqMsg,
  type TunnelMsg,
} from "./tunnel-protocol.js";

const MACHINE_FILE = join(STATE_DIR, "relay-machine.json");
const PING_INTERVAL_MS = 25_000;
const PONG_DEADLINE_MS = 65_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// The hub's own scheme: when it serves TLS, self-requests must speak https
// (its cert names a tailnet host, not 127.0.0.1, so verification is off for
// this loopback hop).
const HUB_TLS =
  (process.env["MURMUR_TLS_CERT"] ?? "").length > 0 &&
  (process.env["MURMUR_TLS_KEY"] ?? "").length > 0;

const log = (msg: string): void => console.error(`[murmur-hub] tunnel: ${msg}`);

interface MachineIdentity {
  id: string;
  secret: string;
}

/** Stable per-machine identity for the relay: the id names the public origin,
 * the secret proves ownership so the id cannot be squatted by another hub. */
function machineIdentity(): MachineIdentity {
  try {
    const parsed = JSON.parse(readFileSync(MACHINE_FILE, "utf8")) as MachineIdentity;
    if (parsed.id && parsed.secret) return parsed;
  } catch {
    // mint below
  }
  const minted: MachineIdentity = {
    id: `m-${randomBytes(8).toString("hex").slice(0, 10)}`,
    secret: randomBytes(24).toString("base64url"),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(MACHINE_FILE, JSON.stringify(minted), { mode: 0o600 });
  return minted;
}

let publicUrl: string | null = null;

/** The machine's public origin on the relay, when the tunnel is up. */
export function tunnelStatus(): { url: string } | null {
  return publicUrl ? { url: publicUrl } : null;
}

function relayWsUrl(): string | null {
  const raw = (process.env["MURMUR_RELAY"] ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "http:") u.protocol = "ws:";
    if (u.protocol === "https:") u.protocol = "wss:";
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    if (u.pathname === "/" || u.pathname === "") u.pathname = "/tunnel";
    return u.toString();
  } catch {
    return null;
  }
}

export function startTunnel(hubPort: number): void {
  const wsUrl = relayWsUrl();
  if (!wsUrl) return;
  if (typeof WebSocket === "undefined") {
    log("this Node has no WebSocket client (needs Node 22+); relay disabled");
    return;
  }
  const identity = machineIdentity();
  let backoff = RECONNECT_MIN_MS;
  let stopped = false;

  const connect = (): void => {
    if (stopped) return;
    const ws = new WebSocket(wsUrl);
    const inflight = new Map<number, ClientRequest>();
    let lastPongAt = Date.now();
    let pingTimer: NodeJS.Timeout | null = null;

    const send = (msg: TunnelMsg): void => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          // socket is tearing down; the close handler reconnects
        }
      }
    };

    ws.addEventListener("open", () => {
      send({
        type: "hello",
        v: TUNNEL_PROTOCOL_VERSION,
        machine: identity.id,
        secret: identity.secret,
        name: hostname(),
        key: process.env["MURMUR_RELAY_KEY"] || undefined,
      });
      lastPongAt = Date.now();
      pingTimer = setInterval(() => {
        if (Date.now() - lastPongAt > PONG_DEADLINE_MS) {
          log("relay stopped answering pings, reconnecting");
          ws.close();
          return;
        }
        send({ type: "ping", at: Date.now() });
      }, PING_INTERVAL_MS);
    });

    ws.addEventListener("message", (event) => {
      let msg: TunnelMsg;
      try {
        msg = JSON.parse(String(event.data)) as TunnelMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          publicUrl = msg.url;
          backoff = RECONNECT_MIN_MS;
          log(`connected, public origin ${msg.url}`);
          return;
        case "pong":
          lastPongAt = Date.now();
          return;
        case "error":
          log(`relay refused: ${msg.reason}`);
          if (msg.reason.includes("different secret") || msg.reason.includes("access key")) {
            // Retrying cannot fix a credential mismatch; stay down until the
            // hub restarts with corrected configuration.
            stopped = true;
          }
          return;
        case "req":
          handleReq(msg, send, inflight, hubPort);
          return;
        case "req-abort": {
          const req = inflight.get(msg.id);
          if (req) {
            inflight.delete(msg.id);
            req.destroy();
          }
          return;
        }
        default:
          return;
      }
    });

    const onGone = (): void => {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      publicUrl = null;
      for (const req of inflight.values()) req.destroy();
      inflight.clear();
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    };
    ws.addEventListener("close", onGone, { once: true });
    ws.addEventListener("error", () => {
      // close fires after error; reconnect is handled there
    });
  };

  connect();
}

function handleReq(
  msg: ReqMsg,
  send: (m: TunnelMsg) => void,
  inflight: Map<number, ClientRequest>,
  hubPort: number
): void {
  // CSRF at the tunnel boundary: a browser-sent Origin must be this machine's
  // own public origin. Validated here, then stripped, so the hub's allowlist
  // (which knows LAN names, not relay names) is not re-judging it.
  const origin = msg.headers["origin"];
  if (origin && origin !== "null" && origin !== publicUrl) {
    send({
      type: "res-head",
      id: msg.id,
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    send({
      type: "res-chunk",
      id: msg.id,
      chunk: Buffer.from(JSON.stringify({ ok: false, reason: "cross-origin request rejected" })).toString("base64"),
    });
    send({ type: "res-end", id: msg.id });
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.headers)) {
    if (HOP_BY_HOP.has(k) || k === "origin") continue;
    headers[k] = v;
  }
  headers["x-murmur-tunneled"] = "1";

  const reqFn = HUB_TLS ? httpsRequest : httpRequest;
  const upstream = reqFn(
    {
      host: "127.0.0.1",
      port: hubPort,
      path: msg.path,
      method: msg.method,
      headers,
      ...(HUB_TLS ? { rejectUnauthorized: false } : {}),
    },
    (res) => {
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string" && !HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
      }
      send({ type: "res-head", id: msg.id, status: res.statusCode ?? 502, headers: outHeaders });
      res.on("data", (chunk: Buffer) => {
        send({ type: "res-chunk", id: msg.id, chunk: chunk.toString("base64") });
      });
      res.on("end", () => {
        inflight.delete(msg.id);
        send({ type: "res-end", id: msg.id });
      });
      res.on("error", () => {
        inflight.delete(msg.id);
        send({ type: "res-end", id: msg.id });
      });
    }
  );
  inflight.set(msg.id, upstream);
  upstream.on("error", () => {
    if (inflight.delete(msg.id)) {
      send({
        type: "res-head",
        id: msg.id,
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
      send({
        type: "res-chunk",
        id: msg.id,
        chunk: Buffer.from(JSON.stringify({ ok: false, reason: "hub unreachable" })).toString("base64"),
      });
      send({ type: "res-end", id: msg.id });
    }
  });
  if (msg.body) upstream.write(Buffer.from(msg.body, "base64"));
  upstream.end();
}
