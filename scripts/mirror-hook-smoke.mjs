#!/usr/bin/env node
// mirror-hook-smoke.mjs: end-to-end test of hooks/murmur-hook.mjs (mirror
// subcommand) against a live Murmur server in an isolated HOME. Covers the two
// correctness guarantees that regressed before:
//   1. A TaskUpdate status=deleted (the sweep the harness runs when a new run
//      starts) must NOT flip the prior, completed run's rows to failed.
//   2. A new dashboard run is named by the active orchestrator skill, not "Run N".
//
// Requires only node (and the built dist/). Run: node scripts/mirror-hook-smoke.mjs

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(ROOT, "hooks", "murmur-hook.mjs");
const DIST = join(ROOT, "dist", "index.js");
const PORT = process.env.MURMUR_SMOKE_PORT || "5192";
const TMP = mkdtempSync(join(tmpdir(), "murmur-smoke-"));

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

const srv = spawn("node", [DIST, "--port", PORT], {
  env: { ...process.env, HOME: TMP, MURMUR_HUB: "0" },
  stdio: "ignore",
});

const stateUrl = `http://127.0.0.1:${PORT}/state`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srvExited = new Promise((resolve) => srv.on("exit", resolve));

// Await the server's exit before removing its HOME: rmSync while the child is
// still flushing state throws ENOTEMPTY.
const shutdown = async (code) => {
  try {
    srv.kill();
  } catch {
    // already gone
  }
  await Promise.race([srvExited, sleep(3000)]);
  try {
    srv.kill("SIGKILL");
  } catch {
    // already gone
  }
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    console.log(`(cleanup: could not remove ${TMP}: ${err.code || err})`);
  }
  process.exit(code);
};

// Backstop for exits that bypass shutdown (thrown errors). It must stay
// tolerant because an exit handler cannot await the child.
process.on("exit", () => {
  try {
    srv.kill("SIGKILL");
  } catch {
    // already gone
  }
  try {
    rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // best effort
  }
});

// Wait for the server to answer /state.
let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    const res = await fetch(stateUrl, { signal: AbortSignal.timeout(500) });
    up = res.ok;
  } catch {
    await sleep(200);
  }
}
if (!up) {
  console.log(`!!  server did not come up on :${PORT}`);
  await shutdown(1);
}

// Feed one PostToolUse event through the real hook, exactly as the harness
// would: JSON on stdin, isolated HOME, explicit port override.
const feed = (event) =>
  execFileSync("node", [HOOK, "mirror"], {
    input: event,
    env: { ...process.env, HOME: TMP, CLAUDE_MURMUR_PORT: PORT },
    stdio: ["pipe", "ignore", "ignore"],
  });

const state = async () => {
  for (let i = 0; ; i++) {
    try {
      return await (await fetch(stateUrl, { signal: AbortSignal.timeout(1000) })).json();
    } catch (err) {
      if (i >= 3) throw err;
      await sleep(300);
    }
  }
};

// --- Run 1: create + complete two rows ---
feed('{"tool_name":"TaskCreate","tool_input":{"subject":"Alpha"},"tool_response":{"task":{"id":"1","subject":"Alpha"}}}');
feed('{"tool_name":"TaskCreate","tool_input":{"subject":"Beta"},"tool_response":{"task":{"id":"2","subject":"Beta"}}}');
feed('{"tool_name":"TaskUpdate","tool_input":{"taskId":"1","status":"completed"}}');
feed('{"tool_name":"TaskUpdate","tool_input":{"taskId":"2","status":"completed"}}');
let s = await state();
check("run1 both completed", 2, s.rows.filter((r) => r.status === "completed").length);

// --- The deleted sweep must NOT fail the completed run ---
feed('{"tool_name":"TaskUpdate","tool_input":{"taskId":"1","status":"deleted"}}');
feed('{"tool_name":"TaskUpdate","tool_input":{"taskId":"2","status":"deleted"}}');
s = await state();
check("deleted sweep leaves 0 failed", 0, s.rows.filter((r) => r.status === "failed").length);
check("deleted sweep keeps 2 completed", 2, s.rows.filter((r) => r.status === "completed").length);

// --- Run 2 named by the active skill (not "Run N") ---
feed('{"tool_name":"Skill","tool_input":{"skill":"pr-reviewer"}}');
feed('{"tool_name":"TaskCreate","tool_input":{"subject":"Gamma"},"tool_response":{"task":{"id":"3","subject":"Gamma"}}}');
s = await state();
check("two runs exist", 2, new Set(s.rows.map((r) => r.runId)).size);
const titled = s.rows.filter((r) => r.runTitle != null);
check("run2 titled by skill", "pr-reviewer", titled.length ? titled[titled.length - 1].runTitle : "");

console.log("");
if (fail === 0) {
  console.log(`mirror-hook smoke: all ${pass} checks pass.`);
  await shutdown(0);
} else {
  console.log(`mirror-hook smoke: ${fail} check(s) failed.`);
  await shutdown(1);
}
