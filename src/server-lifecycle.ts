import {
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { store, SESSION_PORT_FILE, SESSIONS_PATH } from "./state.js";
import { startHttpServer, type HttpHandle } from "./http.js";

let handle: HttpHandle | null = null;
let ownedPort: number | null = null;

async function probeStateEndpoint(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/state`, {
      signal: AbortSignal.timeout(400),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface EnsureResult {
  handle: HttpHandle;
  port: number;
}

// A freshly-written port file may belong to a sibling server still binding;
// give it this grace window before treating an unreachable port as dead.
const PORT_FILE_GRACE_MS = 10_000;

/**
 * Remove orphaned sessions/<key>.port files left behind when a server was
 * SIGKILLed or crashed without running its exit cleanup. A file is pruned only
 * if its port no longer answers /state (so live sibling sessions are kept) and
 * it's older than the grace window (so a concurrently-starting server is never
 * raced). Probes run in parallel; best-effort throughout. Returns the count
 * removed.
 */
export async function pruneDeadPortFiles(): Promise<number> {
  let files: string[];
  try {
    files = readdirSync(SESSIONS_PATH).filter((f) => f.endsWith(".port"));
  } catch {
    return 0;
  }
  const now = Date.now();
  const results = await Promise.all(
    files.map(async (f) => {
      const path = join(SESSIONS_PATH, f);
      let raw: string;
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
        raw = readFileSync(path, "utf8");
      } catch {
        return false;
      }
      if (now - mtimeMs < PORT_FILE_GRACE_MS) return false;
      const port = parseInt(raw.trim(), 10);
      if (Number.isFinite(port) && port > 0 && (await probeStateEndpoint(port))) {
        return false; // live server (ours or a sibling) — keep
      }
      try {
        unlinkSync(path);
        return true;
      } catch {
        return false;
      }
    })
  );
  return results.filter(Boolean).length;
}

/**
 * Bind a per-session HTTP listener. Each Claude Code session owns its own
 * port. Subtle behaviours:
 *
 *  - If a port file already points to a live server for this session, return
 *    that without binding (so ephemeral MCP children spawned by `claude mcp
 *    list` etc. don't fight the long-running owner).
 *  - On EADDRINUSE we walk upward to the next port.
 *  - Cleanup only removes the port file if its current content still matches
 *    OUR bound port — otherwise some other instance has taken ownership and
 *    we leave it alone.
 */
export async function ensureHttpServer(preferredPort: number): Promise<EnsureResult> {
  if (handle) {
    return { handle, port: handle.port };
  }

  if (existsSync(SESSION_PORT_FILE)) {
    try {
      const existing = parseInt(readFileSync(SESSION_PORT_FILE, "utf8").trim(), 10);
      if (Number.isFinite(existing) && existing > 0 && (await probeStateEndpoint(existing))) {
        return {
          handle: { port: existing, close: async () => undefined },
          port: existing,
        };
      }
    } catch {
      // fall through to bind
    }
  }

  let port = preferredPort;
  for (let attempts = 0; attempts < 50; attempts++) {
    try {
      handle = await startHttpServer(store, port);
      store.setPort(handle.port);
      ownedPort = handle.port;
      writeFileSync(SESSION_PORT_FILE, String(handle.port));
      const cleanup = (): void => {
        try {
          if (!existsSync(SESSION_PORT_FILE)) return;
          const cur = readFileSync(SESSION_PORT_FILE, "utf8").trim();
          if (ownedPort !== null && cur === String(ownedPort)) {
            unlinkSync(SESSION_PORT_FILE);
          }
        } catch {
          // best-effort
        }
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("exit", cleanup);
      return { handle, port: handle.port };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        port += 1;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`could not bind a free port starting at ${preferredPort}`);
}
