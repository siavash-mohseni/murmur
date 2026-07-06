// hub-client.ts: how a session server finds (and lazily spawns) the hub.
// The hub is one detached process per machine; any session server that boots
// and finds none becomes the spawner. Races are settled by the hub itself:
// a loser binds EADDRINUSE, probes, sees a live hub, and exits 0.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_PORT_FILE, DEFAULT_HUB_PORT } from "./paths.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// When the hub is configured for TLS (see hub.ts), its surface answers https
// even on loopback, and its cert names a tailnet host rather than 127.0.0.1,
// so local probes skip verification.
const TLS_ON =
  (process.env["MURMUR_TLS_CERT"] ?? "").length > 0 &&
  (process.env["MURMUR_TLS_KEY"] ?? "").length > 0;
const HUB_SCHEME = TLS_ON ? "https" : "http";

function readHubPort(): number | null {
  try {
    const p = parseInt(readFileSync(HUB_PORT_FILE, "utf8").trim(), 10);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

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

/** The live hub's port, or null when no hub answers. */
export async function liveHubPort(): Promise<number | null> {
  const filed = readHubPort();
  if (filed && (await probeIsHub(filed))) return filed;
  return null;
}

// The compiled hub sits next to the compiled server (dist/hub.js); a dev run
// from src/ finds it one level up in dist/ from the last build.
function hubEntryPath(): string | null {
  for (const candidate of [join(HERE, "hub.js"), join(HERE, "..", "dist", "hub.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Make sure a hub is running, spawning one detached if needed. Returns the
 * hub port, or null when disabled (MURMUR_HUB=0), not built, or failed to
 * come up in time. Never throws: the hub is an enhancement, and a session
 * works fully without it.
 */
export async function ensureHub(): Promise<number | null> {
  if (process.env["MURMUR_HUB"] === "0") return null;

  const alive = await liveHubPort();
  if (alive) return alive;

  const entry = hubEntryPath();
  if (!entry) return null;

  try {
    const child = spawn("node", [entry], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    return null;
  }

  // Wait briefly for the port file + probe. The hub binds fast; if it lost a
  // spawn race it exits and the winner's port file answers instead.
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const port = await liveHubPort();
    if (port) return port;
  }
  return null;
}

/**
 * The URL a human should open for this session: the hub's drill-down route
 * when a hub is alive (fleet home one click away, stable origin), else the
 * session server's own root.
 */
export async function preferredDashboardUrl(sessionKey: string, sessionPort: number): Promise<string> {
  const hubPort = await liveHubPort();
  if (hubPort) {
    // A TLS hub carries a cert for a real hostname (e.g. a tailnet name), so
    // prefer that name when configured: it is the URL the cert validates for.
    const host = TLS_ON ? (process.env["MURMUR_HUB_HOSTNAME"] ?? "").trim() || "127.0.0.1" : "127.0.0.1";
    return `${HUB_SCHEME}://${host}:${hubPort}/s/${sessionKey}`;
  }
  return `http://127.0.0.1:${sessionPort}/`;
}

export { DEFAULT_HUB_PORT };
