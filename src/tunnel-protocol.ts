// The message protocol spoken over the hub -> relay WebSocket. JSON text
// frames, request/response bodies as base64. Shared by src/relay.ts (server)
// and src/tunnel-client.ts (hub side) so the two ends cannot drift.

export const TUNNEL_PROTOCOL_VERSION = 1;

// Hub -> relay, first message on every connection.
export interface HelloMsg {
  type: "hello";
  v: number;
  // Stable DNS-label machine id, minted once per machine by the hub.
  machine: string;
  // Proof of ownership for the machine id: the relay stores a hash on first
  // registration and rejects later connections that do not present the same
  // secret, so nobody can squat a known machine's URL and harvest tokens.
  secret: string;
  name?: string;
  // Relay access key, required when the relay is started with MURMUR_RELAY_KEYS.
  key?: string;
}

// Relay -> hub after a valid hello.
export interface ReadyMsg {
  type: "ready";
  // The machine's stable public origin, e.g. https://m-ab12cd34ef.relay.example
  url: string;
}

export interface ErrorMsg {
  type: "error";
  reason: string;
}

// Relay -> hub: forward one HTTP request.
export interface ReqMsg {
  type: "req";
  id: number;
  method: string;
  // Path including query string.
  path: string;
  headers: Record<string, string>;
  body?: string; // base64
}

// Relay -> hub: the browser went away, abort the in-flight request.
export interface ReqAbortMsg {
  type: "req-abort";
  id: number;
}

// Hub -> relay: response streaming (head, then chunks, then end), so SSE and
// large documents flow without buffering a whole response in memory.
export interface ResHeadMsg {
  type: "res-head";
  id: number;
  status: number;
  headers: Record<string, string>;
}

export interface ResChunkMsg {
  type: "res-chunk";
  id: number;
  chunk: string; // base64
}

export interface ResEndMsg {
  type: "res-end";
  id: number;
}

// Liveness, client-driven: the hub pings, the relay echoes.
export interface PingMsg {
  type: "ping";
  at: number;
}
export interface PongMsg {
  type: "pong";
  at: number;
}

export type TunnelMsg =
  | HelloMsg
  | ReadyMsg
  | ErrorMsg
  | ReqMsg
  | ReqAbortMsg
  | ResHeadMsg
  | ResChunkMsg
  | ResEndMsg
  | PingMsg
  | PongMsg;

export const MACHINE_ID_RE = /^[a-z][a-z0-9-]{3,30}$/;

// Hop-by-hop headers that must not cross the tunnel in either direction.
export const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
