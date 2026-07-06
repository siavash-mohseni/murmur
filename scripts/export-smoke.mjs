#!/usr/bin/env node
// export-smoke.mjs: end-to-end test of the Phase 3 receipts pipeline in an
// isolated HOME. Covers:
//   1. The CLI (dist/export-cli.js): listing, prefix resolution, summary and
//      data exports written from the state dir with no server running.
//   2. Transcript-image inlining: a seeded image-store file must come back as
//      a data: URI in both document kinds.
//   3. The server routes: a session server and the hub both serve
//      GET /export/<key>.html for a persisted session, the session server
//      renders its OWN key from the live snapshot, and bad keys 404.
//
// Requires only node (and the built dist/). Run: node scripts/export-smoke.mjs

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = mkdtempSync(join(tmpdir(), "murmur-export-smoke-"));
const SESSION_PORT = "5481";
const HUB_PORT = "5490";
const SEEDED_KEY = randomUUID();
const LIVE_KEY = randomUUID();

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

// --- seed a persisted session with one stored image ------------------------------
const sessionsDir = join(TMP, ".claude", "state", "murmur", "sessions");
mkdirSync(join(sessionsDir, "images"), { recursive: true });

const IMG_NAME = "0123456789abcdef0123456789abcdef.png";
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
writeFileSync(join(sessionsDir, "images", IMG_NAME), PNG_1PX);

const seededState = {
  sessionId: SEEDED_KEY,
  rows: [
    { id: "1", label: "Design the receipt flow", status: "completed" },
    { id: "2", label: "Ship it", status: "in_progress" },
  ],
  activities: [
    {
      kind: "prompt",
      id: "a1",
      timestamp: "2026-07-04T10:00:00.000Z",
      source: "user",
      question: "Build the export pipeline",
    },
    {
      kind: "tool",
      id: "a2",
      timestamp: "2026-07-04T10:01:00.000Z",
      tool: "Edit",
      target: "src/export/render.ts",
      ok: true,
    },
    {
      kind: "prompt",
      id: "a3",
      timestamp: "2026-07-04T10:02:00.000Z",
      source: "assistant",
      question: "Captured a screenshot",
      images: [
        { id: IMG_NAME.replace(".png", ""), url: `/api/image/${IMG_NAME}`, mediaType: "image/png", source: "tool" },
      ],
    },
    {
      kind: "prompt",
      id: "a4",
      timestamp: "2026-07-04T10:03:00.000Z",
      source: "permission",
      question: "Bash: rm -rf ./build",
      answer: "deny",
      ok: false,
    },
  ],
  pendingQuestion: null,
  pendingPermission: null,
  port: 0,
  startedAt: "2026-07-04T09:59:00.000Z",
  sessionInfo: { branch: "main", cwd: "/tmp/demo", cwdBasename: "demo", userName: "smoke" },
  tokenStats: null,
  memoryEntries: [],
};
writeFileSync(join(sessionsDir, `${SEEDED_KEY}.json`), JSON.stringify(seededState));

const env = { ...process.env, HOME: TMP, MURMUR_HUB: "0", MURMUR_AGENTS_POLL: "0" };
const cli = (args) =>
  execFileSync("node", [join(ROOT, "dist", "export-cli.js"), ...args], { env, encoding: "utf8" });

// --- CLI: list, export summary, export data ------------------------------------
const listing = cli([]);
check("CLI lists the seeded session", true, listing.includes(SEEDED_KEY.slice(0, 8)));

const summaryPath = join(TMP, "receipt.html");
const summaryOut = cli([SEEDED_KEY.slice(0, 8), "--out", summaryPath]).trim();
check("CLI resolves a key prefix and prints the path", summaryPath, summaryOut);
const summary = readFileSync(summaryPath, "utf8");
check("summary contains the seeded row", true, summary.includes("Design the receipt flow"));
check("summary inlines the image as a data URI", true, summary.includes("data:image/png;base64"));
check("summary records the denied permission", true, summary.includes("Denied"));

const dataPath = join(TMP, "data.html");
cli([SEEDED_KEY, "--data", "--out", dataPath]);
const dataDump = readFileSync(dataPath, "utf8");
check("data dump has an Images section", true, dataDump.includes("Images (1)"));
check("data dump inlines the image", true, dataDump.includes("data:image/png;base64"));

let threw = "";
try {
  cli(["ffffffff"]);
} catch (err) {
  threw = String(err.stderr ?? err.message);
}
check("CLI fails on an unknown prefix", true, threw.includes("no session starts"));

// --- server routes ---------------------------------------------------------------
const boot = (args, extraEnv) => {
  const child = spawn("node", args, { env: { ...env, ...extraEnv }, stdio: "ignore" });
  children.push(child);
  return child;
};
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

boot([join(ROOT, "dist", "index.js"), "--port", SESSION_PORT], { CLAUDE_CODE_SESSION_ID: LIVE_KEY });
const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${SESSION_PORT}/state`)).ok);
check("session server up", true, up);

const viaSession = await fetch(`http://127.0.0.1:${SESSION_PORT}/export/${SEEDED_KEY}.html`);
check("session server exports a persisted session", 200, viaSession.status);
check("...with the inlined image", true, (await viaSession.text()).includes("data:image/png;base64"));

const viaSelf = await fetch(`http://127.0.0.1:${SESSION_PORT}/export/${LIVE_KEY}.html`);
check("session server exports its own key from the live snapshot", 200, viaSelf.status);

const missing = await fetch(`http://127.0.0.1:${SESSION_PORT}/export/${randomUUID()}.html`);
check("unknown key 404s", 404, missing.status);
const malformed = await fetch(`http://127.0.0.1:${SESSION_PORT}/export/nope`);
check("malformed export path 400s", 400, malformed.status);

boot([join(ROOT, "dist", "hub.js")], { MURMUR_HUB_PORT: HUB_PORT });
const hubUp = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${HUB_PORT}/fleet`);
  return res.ok && (await res.json()).hub === true;
});
check("hub up", true, hubUp);
const viaHub = await fetch(`http://127.0.0.1:${HUB_PORT}/export/${SEEDED_KEY}.html?kind=data`);
check("hub exports a persisted session (data kind)", 200, viaHub.status);
check("...with the Images section", true, (await viaHub.text()).includes("Images (1)"));

console.log("");
if (fail === 0) {
  console.log(`export smoke: all ${pass} checks pass.`);
  process.exit(0);
} else {
  console.log(`export smoke: ${fail} check(s) failed.`);
  process.exit(1);
}
