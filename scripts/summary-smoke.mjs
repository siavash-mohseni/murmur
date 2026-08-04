#!/usr/bin/env node
// summary-smoke.mjs: owner-view summary failure handling, against a fake claude
// CLI so the test needs no auth and no network.
//
// Covers the two defects that made an expired login look like a dead feature:
// the nested CLI's reason was discarded, and a failed beat was cached for the
// life of the process so summaries never came back once they stopped.
//
// Run: node scripts/summary-smoke.mjs

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "index.js");
const PORT = process.env.MURMUR_SUMMARY_SMOKE_PORT || "15207";
const TMP = mkdtempSync(join(tmpdir(), "murmur-summary-smoke-"));
const RETRY_MS = 1500;

let pass = 0;
let fail = 0;
const check = (label, want, got) => {
  if (String(want) === String(got)) {
    console.log(`OK  ${label}`);
    pass++;
  } else {
    console.log(`!!  ${label} (want=${want} got=${got})`);
    fail++;
  }
};

// A fake CLI that fails while the flag file is absent and succeeds once it
// appears, standing in for a login that expires and is later restored.
const FLAG = join(TMP, "authed");
const BIN = join(TMP, "fake-claude");
writeFileSync(
  BIN,
  `#!/bin/sh
if [ -f "${FLAG}" ]; then
  echo "Claude fixed the thing"
  exit 0
fi
echo "Failed to authenticate. API Error: 401 OAuth access token has expired." >&2
exit 1
`
);
chmodSync(BIN, 0o755);
mkdirSync(join(TMP, ".claude", "state", "murmur", "sessions"), { recursive: true });

const srv = spawn("node", [DIST, "--port", PORT], {
  env: {
    ...process.env,
    HOME: TMP,
    MURMUR_HUB: "0",
    MURMUR_AGENTS_POLL: "0",
    MURMUR_CLAUDE_BIN: BIN,
    MURMUR_SUMMARY_RETRY_MS: String(RETRY_MS),
  },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shutdown = async (code) => {
  try {
    srv.kill();
  } catch {}
  await sleep(300);
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  process.exit(code);
};
process.on("exit", () => {
  try {
    srv.kill("SIGKILL");
  } catch {}
});

// Long enough to clear the short-circuit that returns brief text verbatim.
const TEXT =
  "Patching the hub route table so transcript images resolve on the hub origin " +
  "instead of falling through to the SPA shell and rendering as broken thumbnails.";

const ask = async (id) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/owner/summary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, text: TEXT }),
  });
  return res.json();
};

// Wait for the server, then for a beat to leave "pending".
const settle = async (id) => {
  for (let i = 0; i < 40; i++) {
    const r = await ask(id);
    if (r.status !== "pending") return r;
    await sleep(250);
  }
  return { status: "timeout" };
};

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    up = (await fetch(`http://127.0.0.1:${PORT}/state`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    await sleep(200);
  }
}
if (!up) {
  console.log(`!!  server did not come up on :${PORT}`);
  await shutdown(1);
}

// --- the CLI is failing: the reason must reach the caller --------------------
const failed = await settle("beat-1");
check("failing CLI reports unavailable", "unavailable", failed.status);
check(
  "the CLI's reason is surfaced, not discarded",
  true,
  typeof failed.reason === "string" && failed.reason.includes("OAuth access token has expired")
);

// --- and be written to warnings.log for someone not watching the UI ----------
let warnings = "";
try {
  warnings = readFileSync(join(TMP, ".claude", "state", "murmur", "warnings.log"), "utf8");
} catch {
  warnings = "";
}
check("the failure is logged", true, warnings.includes("OAuth access token has expired"));

// --- inside the cooldown the beat stays unavailable, without respawning ------
check("failure is held for the cooldown", "unavailable", (await ask("beat-1")).status);

// --- once the cause is fixed, summaries recover on their own -----------------
writeFileSync(FLAG, "1");
await sleep(RETRY_MS + 200);
const recovered = await settle("beat-1");
check("the same beat recovers after the cooldown", "ready", recovered.status);
check("recovered summary is the CLI's output", "Claude fixed the thing", recovered.summary);

console.log("");
if (fail === 0) {
  console.log(`summary smoke: all ${pass} checks pass.`);
  await shutdown(0);
} else {
  console.log(`summary smoke: ${fail} check(s) failed.`);
  await shutdown(1);
}
