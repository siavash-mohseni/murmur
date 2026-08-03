// Request guards shared by the hub and the session servers. Import-safe like
// paths.ts: no state.ts side effects, so the hub, the session server, and
// scripts can all use it.
//
// Threat model. The servers bind loopback only, but a victim's own browser
// can still be turned against them:
//   1. DNS rebinding: a malicious page rebinds its hostname to 127.0.0.1 and
//      reads or mutates through the victim's browser with a Host header we
//      never chose. Rejecting unknown Host values kills the class.
//   2. Cross-site request forgery: a page anywhere can fire cross-origin
//      POSTs at 127.0.0.1 (CORS blocks reads, not sends). Mutating requests
//      with a browser-supplied Origin outside the allowlist are rejected.

import { hostname, networkInterfaces } from "node:os";
import type { IncomingMessage } from "node:http";

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
