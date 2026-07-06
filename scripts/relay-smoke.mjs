#!/usr/bin/env node
// relay-smoke.mjs: end-to-end test of the Phase 4 relay in an isolated HOME.
// Boots a session server, a hub tunneled to a local relay, and drives the
// full phone -> relay -> hub -> session chain:
//   1. The tunnel registers and the pair payload leads with the relay origin.
//   2. The machine token is enforced END TO END: tunneled requests 401
//      without it (loopback trust must not leak through the tunnel marker),
//      and pass with it all the way to a session's state.
//   3. A permission raised in a session is answerable through the relay.
//   4. SSE streams through the tunnel (fleet frames arrive).
//   5. Machine-id hijack is rejected: a second "hub" presenting the same id
//      with a different secret is refused and the real tunnel keeps working.
//   6. Hosted replays: upload, fetch, lazy TTL expiry, size cap, and the
//      murmur-export --share flow.
//   7. A dead hub yields 502 machine offline.
//
// Requires only node (and the built dist/). Run: node scripts/relay-smoke.mjs

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "murmur-relay-smoke-"));
const SESSION_PORT = "5581";
const HUB_PORT = "5590";
const RELAY_PORT = 8585;
const RELAY_HOST = `relay.test:${RELAY_PORT}`;
const MAX_REPLAY = 200_000;
const KEY = randomUUID();

let pass = 0;
let fail = 0;
const check = (label, want, got) => {
  if (String(want) === String(got)) {
    console.log(`OK  ${label}`);
    pass++;
  } else {
    console.log(`!!  ${label} (want=${JSON.stringify(want)} got=${JSON.stringify(got)})`);
    fail++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
const boot = (args, extraEnv) => {
  const child = spawn("node", args, {
    env: { ...process.env, HOME: TMP, MURMUR_HUB: "0", MURMUR_AGENTS_POLL: "0", ...extraEnv },
    stdio: "ignore",
  });
  children.push(child);
  return child;
};
process.on("exit", () => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});
const waitFor = async (predicate, tries = 80, delay = 250) => {
  for (let i = 0; i < tries; i++) {
    try {
      if (await predicate()) return true;
    } catch {
      // keep waiting
    }
    await sleep(delay);
  }
  return false;
};

// All relay traffic goes to 127.0.0.1 with an explicit Host header (subdomain
// routing without DNS). fetch() refuses to forge Host, so raw http.request.
const relayRequest = (path, { host = RELAY_HOST, method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: RELAY_PORT, path, method, headers: { host, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(2000) })).json();

// --- boot relay, session, hub -----------------------------------------------------
boot([join(ROOT, "dist", "relay.js")], {
  MURMUR_RELAY_PORT: String(RELAY_PORT),
  MURMUR_RELAY_PUBLIC: `http://${RELAY_HOST}`,
  MURMUR_RELAY_DATA: join(TMP, "relay-data"),
  MURMUR_RELAY_MAX_REPLAY: String(MAX_REPLAY),
});
const relayUp = await waitFor(async () => (await getJson(`http://127.0.0.1:${RELAY_PORT}/healthz`)).ok);
check("relay up", true, relayUp);

boot([join(ROOT, "dist", "index.js"), "--port", SESSION_PORT], { CLAUDE_CODE_SESSION_ID: KEY });
const sessionUp = await waitFor(async () => (await fetch(`http://127.0.0.1:${SESSION_PORT}/state`)).ok);
check("session server up", true, sessionUp);

boot([join(ROOT, "dist", "hub.js")], {
  MURMUR_HUB_PORT: HUB_PORT,
  MURMUR_RELAY: `ws://127.0.0.1:${RELAY_PORT}`,
});

// --- tunnel registers, pair leads with the relay origin ---------------------------
let pair = null;
const tunnelReady = await waitFor(async () => {
  pair = await getJson(`http://127.0.0.1:${HUB_PORT}/api/pair`);
  return Boolean(pair.relay);
});
check("tunnel registered (pair carries the relay origin)", true, tunnelReady);
const machineId = tunnelReady ? new URL(pair.relay).hostname.split(".")[0] : "";
check("machine id shape", true, /^m-[a-z0-9]{10}$/.test(machineId));
check("pair urls lead with the relay", true, pair.urls[0] === `${pair.relay}/#t=${pair.token}`);
const token = pair.token;
const machineHost = `${machineId}.${RELAY_HOST}`;

const sessionTailed = await waitFor(async () => {
  const body = await getJson(`http://127.0.0.1:${HUB_PORT}/fleet`);
  return body.sessions.some((s) => s.key === KEY && s.alive);
});
check("hub tails the session", true, sessionTailed);

// --- token enforced end to end ------------------------------------------------------
const noToken = await relayRequest("/fleet", { host: machineHost });
check("tunneled /fleet without token is 401", 401, noToken.status);
const shell = await relayRequest("/", { host: machineHost });
check("tunneled static shell serves without token", 200, shell.status);
check("tunneled shell is the SPA", true, (shell.headers["content-type"] ?? "").includes("text/html"));
const withToken = await relayRequest("/fleet", {
  host: machineHost,
  headers: { authorization: `Bearer ${token}` },
});
check("tunneled /fleet with token is 200", 200, withToken.status);
check("tunneled /fleet is the hub's", true, JSON.parse(withToken.body).hub === true);
const chain = await relayRequest(`/s/${KEY}/state`, {
  host: machineHost,
  headers: { authorization: `Bearer ${token}` },
});
check("relay -> hub -> session chain reaches the right session", KEY, JSON.parse(chain.body).sessionId);
const pairViaTunnel = await relayRequest("/api/pair", {
  host: machineHost,
  headers: { authorization: `Bearer ${token}` },
});
check("pair endpoint refuses the tunnel even with token", 403, pairViaTunnel.status);

// --- Origin guard at the tunnel boundary ---------------------------------------------
const evilOrigin = await relayRequest("/api/push/unsubscribe", {
  host: machineHost,
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    origin: "http://evil.example",
    "content-type": "application/json",
  },
  body: "{}",
});
check("tunneled cross-site POST is 403", 403, evilOrigin.status);
const goodOrigin = await relayRequest("/api/push/unsubscribe", {
  host: machineHost,
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    origin: `http://${machineHost}`,
    "content-type": "application/json",
  },
  body: "{}",
});
check("tunneled same-machine-origin POST passes", 200, goodOrigin.status);

// --- the pager loop through the relay: raise a permission, answer from "anywhere" ----
const askPromise = fetch(`http://127.0.0.1:${SESSION_PORT}/permission/ask`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tool: "Bash", command: "git push --force", timeoutMs: 30000 }),
}).then((r) => r.json());
let pendingPerm = null;
const permVisible = await waitFor(async () => {
  const res = await relayRequest(`/s/${KEY}/state`, {
    host: machineHost,
    headers: { authorization: `Bearer ${token}` },
  });
  pendingPerm = JSON.parse(res.body).pendingPermission;
  return Boolean(pendingPerm);
});
check("pending permission visible through the relay", true, permVisible);
const answer = await relayRequest(`/s/${KEY}/api/permission/answer`, {
  host: machineHost,
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ permissionId: pendingPerm.permissionId, decision: "deny" }),
});
check("permission answered through the relay", 200, answer.status);
const askResult = await askPromise;
check("blocked ask resolved with the relayed decision", "deny", askResult.decision);

// --- SSE streams through the tunnel ------------------------------------------------
const sseFirstBytes = await new Promise((resolve) => {
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port: RELAY_PORT,
      path: `/events?token=${token}`,
      headers: { host: machineHost, accept: "text/event-stream" },
    },
    (res) => {
      let got = "";
      res.on("data", (c) => {
        got += c.toString("utf8");
        if (got.includes("fleet")) {
          req.destroy();
          resolve(got);
        }
      });
    }
  );
  req.setTimeout(10_000, () => {
    req.destroy();
    resolve("");
  });
  req.on("error", () => resolve(""));
  req.end();
});
check("SSE streams through the tunnel (fleet frame seen)", true, sseFirstBytes.includes("fleet"));

// --- hijack rejection -----------------------------------------------------------------
const hijack = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/tunnel`);
  const timer = setTimeout(() => {
    ws.close();
    resolve("timeout");
  }, 5000);
  ws.addEventListener("open", () => {
    ws.send(
      JSON.stringify({
        type: "hello",
        v: 1,
        machine: machineId,
        secret: "wrong-secret-wrong-secret",
        name: "impostor",
      })
    );
  });
  ws.addEventListener("message", (e) => {
    clearTimeout(timer);
    try {
      resolve(JSON.parse(String(e.data)));
    } catch {
      resolve("bad json");
    }
  });
});
check("impostor with a wrong secret is refused", true, Boolean(hijack?.reason?.includes("different secret")));
const stillWorks = await relayRequest("/fleet", {
  host: machineHost,
  headers: { authorization: `Bearer ${token}` },
});
check("the real tunnel survives the hijack attempt", 200, stillWorks.status);

// --- unknown machine ------------------------------------------------------------------
const unknown = await relayRequest("/fleet", { host: `m-zzzzzzzzzz.${RELAY_HOST}` });
check("unknown machine is 404", 404, unknown.status);

// --- hosted replays ---------------------------------------------------------------------
const replayHtml = "<!doctype html><html><body>receipt for the demo run</body></html>";
const uploaded = await relayRequest("/replays?ttlSeconds=1", {
  method: "POST",
  headers: { "content-type": "text/html" },
  body: replayHtml,
});
check("replay upload accepted", 200, uploaded.status);
const replay = JSON.parse(uploaded.body);
const replayPath = new URL(replay.url).pathname;
const fetched = await relayRequest(replayPath);
check("replay fetch round-trips the html", replayHtml, fetched.body);
check("replay served as html", true, (fetched.headers["content-type"] ?? "").includes("text/html"));
await sleep(1300);
const expired = await relayRequest(replayPath);
check("replay expires lazily after its ttl", 404, expired.status);

const defaultTtl = await relayRequest("/replays", {
  method: "POST",
  headers: { "content-type": "text/html" },
  body: replayHtml,
});
const days = (new Date(JSON.parse(defaultTtl.body).expiresAt) - Date.now()) / 86_400_000;
check("default replay ttl is about 7 days", true, days > 6.5 && days < 7.5);

const oversize = await relayRequest("/replays", {
  method: "POST",
  headers: { "content-type": "text/html" },
  body: "x".repeat(MAX_REPLAY + 1),
});
check("oversize replay is 413", 413, oversize.status);

// --- murmur-export --share ---------------------------------------------------------------
const seededKey = randomUUID();
const sessionsDir = join(TMP, ".claude", "state", "murmur", "sessions");
mkdirSync(sessionsDir, { recursive: true });
writeFileSync(
  join(sessionsDir, `${seededKey}.json`),
  JSON.stringify({
    sessionId: seededKey,
    rows: [{ id: "1", label: "Relay share smoke row", status: "completed" }],
    activities: [
      { kind: "prompt", id: "a1", timestamp: "2026-07-04T10:00:00.000Z", source: "user", question: "share me" },
    ],
    pendingQuestion: null,
    pendingPermission: null,
    port: 0,
    startedAt: "2026-07-04T09:59:00.000Z",
    sessionInfo: { branch: "main", cwd: "/tmp/demo", cwdBasename: "demo" },
    tokenStats: null,
    memoryEntries: [],
  })
);
const shareOut = execFileSync("node", [join(ROOT, "dist", "export-cli.js"), seededKey.slice(0, 8), "--share"], {
  env: { ...process.env, HOME: TMP, MURMUR_RELAY: `ws://127.0.0.1:${RELAY_PORT}` },
  encoding: "utf8",
});
const shareUrl = /replay:\s+(\S+)/.exec(shareOut)?.[1] ?? "";
check("--share prints a replay url", true, shareUrl.startsWith(`http://${RELAY_HOST}/r/`));
const shared = await relayRequest(new URL(shareUrl).pathname);
check("shared replay contains the session content", true, shared.body.includes("Relay share smoke row"));

// --- dead hub -> machine offline ------------------------------------------------------------
children.find((c) => c.spawnargs.some((a) => a.includes("hub.js")))?.kill();
const offline = await waitFor(async () => {
  const res = await relayRequest("/fleet", {
    host: machineHost,
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status === 502 && JSON.parse(res.body).reason === "machine offline";
}, 40, 250);
check("dead hub reports machine offline (502)", true, offline);

console.log("");
if (fail === 0) {
  console.log(`relay smoke: all ${pass} checks pass.`);
  process.exit(0);
} else {
  console.log(`relay smoke: ${fail} check(s) failed.`);
  process.exit(1);
}
