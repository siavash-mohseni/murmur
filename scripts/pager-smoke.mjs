#!/usr/bin/env node
// pager-smoke.mjs: end-to-end test of the Phase 2 pager surface in an
// isolated HOME. Covers:
//   1. The token gate: loopback is trusted, LAN requests 401 without the
//      machine token and pass with bearer/query/cookie; the static shell
//      stays fetchable so an unpaired phone can boot the SPA.
//   2. Host and Origin guards on both the hub and a session server (DNS
//      rebinding, cross-site POSTs).
//   3. QR pairing: /api/pair is loopback-only and carries the LAN URLs.
//   4. Real Web Push: subscribe against a fake push service, raise a
//      permission, receive an aes128gcm push, DECRYPT it with the receiver
//      keys (full RFC 8291 round trip), verify the VAPID ES256 JWT, answer
//      through the proxy, and receive the resolve frame that clears the
//      lock-screen alert. A subscription must count as a watcher; dropping
//      it must release the gate.
//
// Requires only node (and the built dist/). Run: node scripts/pager-smoke.mjs

import { spawn } from "node:child_process";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify as cryptoVerify,
} from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "murmur-pager-smoke-"));
const SESSION_PORT = "5381";
const HUB_PORT = "5390";
const PUSH_PORT = 5399;
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
const skip = (label, why) => console.log(`--  ${label} (skipped: ${why})`);
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
const getJson = async (url, init) =>
  (await fetch(url, { signal: AbortSignal.timeout(2000), ...init })).json();

// Raw request with full header control (fetch refuses to forge Host/Origin).
const rawRequest = (opts, body) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", timeout: 2000, ...opts }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });

// --- fake push service -----------------------------------------------------------
const pushInbox = [];
const pushService = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    pushInbox.push({ headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(201);
    res.end();
  });
});
await new Promise((r) => pushService.listen(PUSH_PORT, "127.0.0.1", r));
process.on("exit", () => pushService.close());

// --- receiver ("browser") keys ------------------------------------------------------
const receiver = createECDH("prime256v1");
receiver.generateKeys();
const authSecret = randomBytes(16);
const subscription = {
  endpoint: `http://127.0.0.1:${PUSH_PORT}/push/device-1`,
  keys: {
    p256dh: receiver.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
  },
};

// RFC 8291 receiver side: what the browser does before waking the SW.
function decryptPush(body) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdhSecret = receiver.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const record = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--; // strip zero padding
  if (record[end] === 0x02 || record[end] === 0x01) end--; // strip delimiter
  return JSON.parse(record.subarray(0, end + 1).toString("utf8"));
}

function verifyVapid(authHeader, expectedAud) {
  const m = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authHeader ?? "");
  if (!m) return { ok: false, reason: "header shape" };
  const [h, p, s] = m[1].split(".");
  const point = Buffer.from(m[2], "base64url");
  const pub = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const sigOk = cryptoVerify(
    "sha256",
    Buffer.from(`${h}.${p}`),
    { key: pub, dsaEncoding: "ieee-p1363" },
    Buffer.from(s, "base64url")
  );
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  return { ok: sigOk && payload.aud === expectedAud && payload.exp > Date.now() / 1000 };
}

// --- boot: one session server, one hub in LAN mode ---------------------------------
boot([join(ROOT, "dist", "index.js"), "--port", SESSION_PORT], { CLAUDE_CODE_SESSION_ID: KEY });
const sessionUp = await waitFor(async () => (await fetch(`http://127.0.0.1:${SESSION_PORT}/state`)).ok);
check("session server up", true, sessionUp);

boot([join(ROOT, "dist", "hub.js")], { MURMUR_HUB_PORT: HUB_PORT, MURMUR_LAN: "1" });
const hubUp = await waitFor(async () => {
  const body = await getJson(`http://127.0.0.1:${HUB_PORT}/fleet`);
  return body.hub === true;
});
check("hub up (loopback trusted without token)", true, hubUp);

const tailed = await waitFor(async () => {
  const body = await getJson(`http://127.0.0.1:${HUB_PORT}/fleet`);
  return body.sessions.some((s) => s.key === KEY && s.alive);
});
check("fleet lists the session alive", true, tailed);

// --- token material on disk ----------------------------------------------------
const tokenFile = join(TMP, ".claude", "state", "murmur", "token");
const pair = await getJson(`http://127.0.0.1:${HUB_PORT}/api/pair`);
check("pair endpoint answers on loopback", true, pair.ok);
check("pair reports lan mode", true, pair.lan);
const token = readFileSync(tokenFile, "utf8").trim();
check("pair token matches the state-dir token file", token, pair.token);
check("token file is 0600", "600", (statSync(tokenFile).mode & 0o777).toString(8));

// --- host and origin guards ------------------------------------------------------
const evilHostHub = await rawRequest({ port: HUB_PORT, path: "/fleet", headers: { host: "evil.example" } });
check("hub rejects a rebound Host", 403, evilHostHub.status);
const evilHostSession = await rawRequest({ port: SESSION_PORT, path: "/state", headers: { host: "evil.example:5381" } });
check("session server rejects a rebound Host", 403, evilHostSession.status);
const evilOriginHub = await rawRequest(
  {
    port: HUB_PORT,
    path: "/api/push/unsubscribe",
    method: "POST",
    headers: { host: `127.0.0.1:${HUB_PORT}`, origin: "http://evil.example", "content-type": "application/json" },
  },
  "{}"
);
check("hub rejects a cross-site POST", 403, evilOriginHub.status);
const evilOriginSession = await rawRequest(
  {
    port: SESSION_PORT,
    path: "/api/permission/answer",
    method: "POST",
    headers: { host: `127.0.0.1:${SESSION_PORT}`, origin: "http://evil.example", "content-type": "application/json" },
  },
  JSON.stringify({ permissionId: "x", decision: "allow" })
);
check("session server rejects a cross-site POST", 403, evilOriginSession.status);
const okOriginHub = await rawRequest(
  {
    port: HUB_PORT,
    path: "/api/push/unsubscribe",
    method: "POST",
    headers: { host: `127.0.0.1:${HUB_PORT}`, origin: `http://127.0.0.1:${HUB_PORT}`, "content-type": "application/json" },
  },
  "{}"
);
check("hub accepts a same-machine Origin", 200, okOriginHub.status);

// --- the LAN gate ---------------------------------------------------------------
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
if (!lanIp) {
  skip("LAN token checks", "no non-loopback IPv4 interface");
} else {
  try {
    const noToken = await fetch(`http://${lanIp}:${HUB_PORT}/fleet`, { signal: AbortSignal.timeout(2000) });
    check("LAN /fleet without token is 401", 401, noToken.status);
    const shell = await fetch(`http://${lanIp}:${HUB_PORT}/`, { signal: AbortSignal.timeout(2000) });
    check("LAN static shell serves without token", 200, shell.status);
    check(
      "LAN shell is the SPA (html)",
      true,
      (shell.headers.get("content-type") ?? "").includes("text/html")
    );
    const bearer = await fetch(`http://${lanIp}:${HUB_PORT}/fleet`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    check("LAN /fleet with bearer token is 200", 200, bearer.status);
    const query = await fetch(`http://${lanIp}:${HUB_PORT}/fleet?token=${token}`, {
      signal: AbortSignal.timeout(2000),
    });
    check("LAN /fleet with query token is 200", 200, query.status);
    const cookie = await fetch(`http://${lanIp}:${HUB_PORT}/fleet`, {
      headers: { cookie: `murmur_token=${token}` },
      signal: AbortSignal.timeout(2000),
    });
    check("LAN /fleet with cookie token is 200", 200, cookie.status);
    const wrong = await fetch(`http://${lanIp}:${HUB_PORT}/fleet`, {
      headers: { authorization: "Bearer nope" },
      signal: AbortSignal.timeout(2000),
    });
    check("LAN /fleet with a wrong token is 401", 401, wrong.status);
    const proxyNoToken = await fetch(`http://${lanIp}:${HUB_PORT}/s/${KEY}/state`, {
      signal: AbortSignal.timeout(2000),
    });
    check("LAN proxied session data without token is 401", 401, proxyNoToken.status);
    const pairLan = await fetch(`http://${lanIp}:${HUB_PORT}/api/pair`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    check("pair endpoint refuses non-loopback even with token", 403, pairLan.status);
    check("pair URLs include the LAN address", true, pair.urls.some((u) => u.includes(lanIp)));
  } catch (err) {
    skip("LAN token checks", `LAN self-connect failed (${err.message}); local firewall?`);
  }
}

// --- push: subscribe, page, decrypt, answer, resolve ---------------------------------
const subRes = await getJson(`http://127.0.0.1:${HUB_PORT}/api/push/subscribe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ subscription }),
});
check("subscribe accepted", true, subRes.ok);
check("one subscription registered", 1, subRes.subscriptions);

const gateLifted = await waitFor(async () => {
  const w = await getJson(`http://127.0.0.1:${SESSION_PORT}/watchers`);
  return w.watching === true && w.remote >= 1 && w.clients === 0;
});
check("push subscription counts as a watcher (no tabs anywhere)", true, gateLifted);

const askPromise = fetch(`http://127.0.0.1:${SESSION_PORT}/permission/ask`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tool: "Bash", command: "rm -rf ./build", timeoutMs: 30000 }),
}).then((r) => r.json());

const pushed = await waitFor(() => pushInbox.length >= 1, 40, 250);
check("permission raised a push within the window", true, pushed);
if (pushed) {
  const first = pushInbox[0];
  check("push content-encoding is aes128gcm", "aes128gcm", first.headers["content-encoding"]);
  check("push carries a TTL", true, Number(first.headers["ttl"]) > 0);
  check("push urgency is high", "high", first.headers["urgency"]);
  const vapid = verifyVapid(first.headers["authorization"], `http://127.0.0.1:${PUSH_PORT}`);
  check("VAPID JWT verifies against its own key and audience", true, vapid.ok);
  const payload = decryptPush(first.body);
  check("payload decrypts with the receiver keys", "permission", payload.kind);
  check("payload names the session", KEY, payload.key);
  check("payload carries the command", true, String(payload.body).includes("rm -rf ./build"));
  check("payload deep-links the drill-down", `/s/${KEY}`, payload.url);

  // Answer through the hub proxy, as the SW's lock-screen Deny would.
  const answered = await getJson(`http://127.0.0.1:${HUB_PORT}/s/${KEY}/api/permission/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissionId: payload.permissionId, decision: "deny" }),
  });
  check("lock-screen style answer accepted through the proxy", true, answered.ok);
  const askResult = await askPromise;
  check("blocked ask resolved with deny", "deny", askResult.decision);

  const resolved = await waitFor(() => pushInbox.length >= 2, 40, 250);
  check("resolve frame pushed after the answer", true, resolved);
  if (resolved) {
    const second = decryptPush(pushInbox[1].body);
    check("resolve frame targets the shown notification", payload.tag, second.tag);
    check("resolve frame kind", "resolve", second.kind);
  }
}

const unsubRes = await getJson(`http://127.0.0.1:${HUB_PORT}/api/push/unsubscribe`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ endpoint: subscription.endpoint }),
});
check("unsubscribe accepted", true, unsubRes.ok && unsubRes.subscriptions === 0);
const gateReleased = await waitFor(async () => {
  const w = await getJson(`http://127.0.0.1:${SESSION_PORT}/watchers`);
  return w.watching === false;
});
check("gate releases when the last pager unsubscribes", true, gateReleased);

console.log("");
if (fail === 0) {
  console.log(`pager smoke: all ${pass} checks pass.`);
  process.exit(0);
} else {
  console.log(`pager smoke: ${fail} check(s) failed.`);
  process.exit(1);
}
