#!/usr/bin/env node
// hub-smoke.mjs: end-to-end test of the hub (dist/hub.js) against two live
// session servers in an isolated HOME. Covers the Phase 1 guarantees:
//   1. The fleet snapshot lists every live session, tailed over role=mirror.
//   2. THE watcher regression: a hub mirror connection alone must NOT count as
//      a watcher (terminal fallback survives), while a human SSE client on the
//      hub lifts the gate via the remote-watcher relay, and releases it
//      promptly on disconnect.
//   3. The /s/<key>/* proxy round-trips state reads and permission answers.
//
// Requires only node (and the built dist/). Run: node scripts/hub-smoke.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "murmur-hub-smoke-"));
const PORT_A = "5281";
const PORT_B = "5282";
const HUB_PORT = "5290";
const KEY_A = randomUUID();
const KEY_B = randomUUID();

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

const waitFor = async (predicate, tries = 60, delay = 250) => {
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
const getJson = async (url) => (await fetch(url, { signal: AbortSignal.timeout(1000) })).json();

// --- boot two session servers and the hub ---
boot([join(ROOT, "dist", "index.js"), "--port", PORT_A], { CLAUDE_CODE_SESSION_ID: KEY_A });
boot([join(ROOT, "dist", "index.js"), "--port", PORT_B], { CLAUDE_CODE_SESSION_ID: KEY_B });
const upA = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT_A}/state`)).ok);
const upB = await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT_B}/state`)).ok);
check("session servers up", "true,true", `${upA},${upB}`);

boot([join(ROOT, "dist", "hub.js")], { MURMUR_HUB_PORT: HUB_PORT });
const hubUp = await waitFor(async () => {
  const body = await getJson(`http://127.0.0.1:${HUB_PORT}/fleet`);
  return body.hub === true;
});
check("hub up", true, hubUp);

// --- fleet lists both sessions, alive, tails connected ---
const bothTailed = await waitFor(async () => {
  const body = await getJson(`http://127.0.0.1:${HUB_PORT}/fleet`);
  const keys = body.sessions.filter((s) => s.alive).map((s) => s.key);
  return keys.includes(KEY_A) && keys.includes(KEY_B);
});
check("fleet lists both sessions alive", true, bothTailed);

// --- THE watcher regression: mirror tails must not count as watchers ---
let w = await getJson(`http://127.0.0.1:${PORT_A}/watchers`);
check("mirror tail does not count as client", 0, w.clients);
check("mirror tail does not lift the gate", false, w.watching);

// --- a human SSE client on the hub lifts the gate via the relay ---
const ctrl = new AbortController();
const sse = await fetch(`http://127.0.0.1:${HUB_PORT}/events`, { signal: ctrl.signal });
sse.body.getReader().read().catch(() => {});
const lifted = await waitFor(async () => {
  const probe = await getJson(`http://127.0.0.1:${PORT_A}/watchers`);
  return probe.watching === true && probe.remote >= 1;
}, 20, 250);
check("hub client lifts the gate on both sessions", true, lifted);
w = await getJson(`http://127.0.0.1:${PORT_A}/watchers`);
check("gate lifted via remote, not clients", 0, w.clients);

// --- proxy: state read round-trip ---
const proxied = await getJson(`http://127.0.0.1:${HUB_PORT}/s/${KEY_A}/state`);
check("proxied /state reaches the right session", KEY_A, proxied.sessionId);

// --- proxy: permission answer round-trip ---
// Ask session A directly (as the hook would), answer through the hub proxy.
const askPromise = fetch(`http://127.0.0.1:${PORT_A}/permission/ask`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tool: "Bash", command: "make deploy", timeoutMs: 30000 }),
}).then((r) => r.json());
const pending = await waitFor(async () => {
  const s = await getJson(`http://127.0.0.1:${HUB_PORT}/s/${KEY_A}/state`);
  return Boolean(s.pendingPermission);
}, 20, 250);
check("permission pending visible through proxy", true, pending);

// The fleet snapshot should carry the pending permission for the inbox.
const fleetPending = await waitFor(async () => {
  const body = await getJson(`http://127.0.0.1:${HUB_PORT}/fleet`);
  const a = body.sessions.find((s) => s.key === KEY_A);
  return Boolean(a && a.pendingPermission);
}, 20, 250);
check("fleet snapshot carries the pending permission", true, fleetPending);

const stateA = await getJson(`http://127.0.0.1:${HUB_PORT}/s/${KEY_A}/state`);
const answerRes = await fetch(`http://127.0.0.1:${HUB_PORT}/s/${KEY_A}/api/permission/answer`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ permissionId: stateA.pendingPermission.permissionId, decision: "allow" }),
});
check("proxied permission answer accepted", 200, answerRes.status);
const askResult = await askPromise;
check("blocked ask resolved with the proxied decision", "allow", askResult.decision);

// --- transcript images resolve on the hub origin ---
// The urls in session state carry no /s/<key> prefix, so a drill-down or the
// fleet home requests them from the hub. If the hub lets them fall through to
// the SPA shell the response is HTML and every thumbnail renders broken.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const imageName = `${"ab12cd34".repeat(2)}.png`;
mkdirSync(join(TMP, ".claude", "state", "murmur", "sessions", "images"), { recursive: true });
writeFileSync(join(TMP, ".claude", "state", "murmur", "sessions", "images", imageName), PNG_1PX);
const imgRes = await fetch(`http://127.0.0.1:${HUB_PORT}/api/image/${imageName}`);
check("hub serves a transcript image", 200, imgRes.status);
check("hub image is a png, not the SPA shell", "image/png", imgRes.headers.get("content-type"));
const missingRes = await fetch(`http://127.0.0.1:${HUB_PORT}/api/image/${"ff".repeat(16)}.png`);
check("hub 404s an unknown image", 404, missingRes.status);

// --- disconnect: the gate must release promptly ---
ctrl.abort();
const released = await waitFor(async () => {
  const probe = await getJson(`http://127.0.0.1:${PORT_A}/watchers`);
  return probe.watching === false;
}, 20, 250);
check("gate releases when the last hub client leaves", true, released);

console.log("");
if (fail === 0) {
  console.log(`hub smoke: all ${pass} checks pass.`);
  process.exit(0);
} else {
  console.log(`hub smoke: ${fail} check(s) failed.`);
  process.exit(1);
}
