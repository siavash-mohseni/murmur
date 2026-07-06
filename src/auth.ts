// Machine auth token and request guards shared by the hub and the session
// servers. Import-safe like paths.ts: no state.ts side effects, so the hub,
// the session server, and scripts can all use it.
//
// Threat model, in order of exposure:
//   1. LAN exposure (MURMUR_LAN=1): anyone on the same network can reach the
//      hub, and the dashboard is not read-only (it approves permission
//      requests). Every non-loopback request must carry the machine token.
//   2. DNS rebinding: a malicious page rebinds its hostname to 127.0.0.1 and
//      reads or mutates through the victim's browser with a Host header we
//      never chose. Rejecting unknown Host values kills the class.
//   3. Cross-site request forgery: a page anywhere can fire cross-origin
//      POSTs at 127.0.0.1 (CORS blocks reads, not sends). Mutating requests
//      with a browser-supplied Origin outside the allowlist are rejected.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { STATE_DIR } from "./paths.js";

export const TOKEN_FILE = join(STATE_DIR, "token");

let cachedToken: string | null = null;

/** The per-machine bearer token, created on first use (0600). One token pairs
 * every device with every surface on this machine, which matches the trust
 * boundary: whoever holds it can drive any session here. */
export function machineToken(): string {
  if (cachedToken) return cachedToken;
  try {
    const existing = readFileSync(TOKEN_FILE, "utf8").trim();
    if (existing.length >= 32) {
      cachedToken = existing;
      return existing;
    }
  } catch {
    // fall through to mint
  }
  const minted = randomBytes(32).toString("base64url");
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOKEN_FILE, minted, { mode: 0o600 });
  cachedToken = minted;
  return minted;
}

function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(machineToken());
  const got = Buffer.from(candidate);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Pull a token from the request: Authorization bearer, ?token= query, or the
 * murmur_token cookie the SPA sets after pairing. */
function requestToken(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const q = url.searchParams.get("token");
  if (q) return q;
  const cookies = req.headers.cookie ?? "";
  const m = cookies.match(/(?:^|;\s*)murmur_token=([A-Za-z0-9_-]+)/);
  return m ? m[1]! : null;
}

export function isLoopbackAddr(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Loopback AND not relayed. The hub's tunnel client replays relay traffic
 * against the hub over loopback with the x-murmur-tunneled marker; those
 * requests came from the internet and must earn no loopback trust. Spoofing
 * the marker only ever DOWNGRADES the caller's own trust, so it is safe.  */
export function isTrustedLocal(req: IncomingMessage): boolean {
  return isLoopbackAddr(req) && !("x-murmur-tunneled" in req.headers);
}

/** True when the request may use authenticated surfaces: trusted-local
 * callers (hooks, the hub's own tails, local tabs) are exempt, anything else
 * must present the machine token. */
export function isAuthorized(req: IncomingMessage, url: URL): boolean {
  if (isTrustedLocal(req)) return true;
  const token = requestToken(req, url);
  return token !== null && tokenMatches(token);
}

// --- Host / Origin allowlist -------------------------------------------------

// Hostnames that legitimately name this machine. Interface IPs change (Wi-Fi
// hops, VPNs), so recompute on a short cache instead of once at boot.
let allowedHostsCache: Set<string> | null = null;
let allowedHostsAt = 0;
const ALLOWED_HOSTS_TTL_MS = 10_000;

function allowedHosts(): Set<string> {
  const now = Date.now();
  if (allowedHostsCache && now - allowedHostsAt < ALLOWED_HOSTS_TTL_MS) {
    return allowedHostsCache;
  }
  const hosts = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  const name = hostname().toLowerCase();
  if (name) {
    hosts.add(name);
    const short = name.replace(/\.local$/, "");
    hosts.add(short);
    hosts.add(`${short}.local`);
  }
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      hosts.add(addr.address.toLowerCase());
    }
  }
  // Extra names this machine answers to (e.g. a tailnet DNS name for the TLS
  // path). Comma-separated hostnames, no scheme or port. The canonical TLS
  // hostname is trusted automatically so one env var covers the whole path.
  const extras = `${process.env["MURMUR_HOST_ALLOW"] ?? ""},${process.env["MURMUR_HUB_HOSTNAME"] ?? ""}`;
  for (const extra of extras.split(",")) {
    const h = extra.trim().toLowerCase();
    if (h) hosts.add(h);
  }
  allowedHostsCache = hosts;
  allowedHostsAt = now;
  return hosts;
}

/** Hostname part of a Host header or an Origin URL, lowercased, port and
 * IPv6 brackets stripped. Returns null when unparseable. */
function hostnameOf(value: string): string | null {
  try {
    // URL handles both bare hosts (via a dummy scheme) and full origins.
    const u = value.includes("://") ? new URL(value) : new URL(`http://${value}`);
    return u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

/** DNS-rebinding guard: the Host header must name this machine. */
export function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return true; // HTTP/1.0 or non-browser client: nothing to rebind
  const name = hostnameOf(host);
  return name !== null && allowedHosts().has(name);
}

/** CSRF guard for mutating methods: a browser-sent Origin must name this
 * machine. Requests without an Origin (curl, hooks, the hub proxy) pass.
 * "Origin: null" (sandboxed iframes, the classic origin-stripping trick) is
 * rejected, since no legitimate Murmur surface produces it. */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === "null") return false;
  const name = hostnameOf(origin);
  return name !== null && allowedHosts().has(name);
}
