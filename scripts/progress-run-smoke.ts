// Smoke test for multi-run progress grouping in the Store.
//
// Verifies that murmur_init (initRows) starts a NEW run instead of clobbering,
// that addRow opens a new run only once every prior row is terminal, and that
// updateRow targets the newest matching row so same-named phases across runs do
// not collide.
//
// Each scenario runs in its OWN process with an isolated HOME (STATE_DIR is
// derived from homedir() at import, so a fresh HOME per process means a fresh
// state file and zero contact with the live session). With no argument this
// file orchestrates the per-scenario subprocesses itself.
//
// Run: bun run scripts/progress-run-smoke.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type Row } from "../src/state.ts";

const SCENARIOS = ["init", "addrow"] as const;
const thisFile = fileURLToPath(import.meta.url);

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, got?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`OK  ${name}`);
  } else {
    fail += 1;
    console.log(`!!  ${name}`);
    if (got !== undefined) console.log(`      got: ${JSON.stringify(got)}`);
  }
}

const runIds = (rows: Row[]): string[] => [...new Set(rows.map((r) => r.runId ?? "none"))];

// ---- murmur_init path: two named runs coexist ----
function scenarioInit(): void {
  const s = new Store();
  s.initRows(["Plan", "Build", "Verify"], "Feature A");
  const afterFirst = s.snapshot().rows;
  check("init seeds 3 rows", afterFirst.length === 3, afterFirst.length);
  check("first run shares one runId", runIds(afterFirst).length === 1, runIds(afterFirst));
  check("title lands on the first row", afterFirst[0]!.runTitle === "Feature A", afterFirst[0]!.runTitle);
  check("title not repeated on later rows", afterFirst[1]!.runTitle === undefined, afterFirst[1]!.runTitle);

  s.updateRow("Plan", "completed");
  s.updateRow("Build", "completed");
  s.updateRow("Verify", "completed");

  // A second init APPENDS rather than replacing.
  s.initRows(["Plan", "Ship"], "Feature B");
  const rows = s.snapshot().rows;
  check("second init appends (5 rows total)", rows.length === 5, rows.length);
  check("two distinct runs exist", runIds(rows).length === 2, runIds(rows));
  check("second run titled Feature B", rows[3]!.runTitle === "Feature B", rows[3]!.runTitle);

  // updateRow must hit the NEWEST "Plan" (run B), not run A's completed one.
  s.updateRow("Plan", "in_progress");
  const planA = rows.find((r) => r.label === "Plan" && r.runId === rows[0]!.runId)!;
  const planB = rows.find((r) => r.label === "Plan" && r.runId === rows[3]!.runId)!;
  check("run A Plan stays completed", planA.status === "completed", planA.status);
  check("run B Plan went in_progress", planB.status === "in_progress", planB.status);
}

// ---- addRow path (harness TaskCreate via /sync): new run once all prior done ----
function scenarioAddRow(): void {
  const s = new Store();
  s.addRow("A");
  s.addRow("B"); // A still pending, so B joins the same run
  let rows = s.snapshot().rows;
  check("addRow groups while run active", runIds(rows).length === 1, runIds(rows));

  s.updateRow("A", "completed");
  s.updateRow("B", "completed");
  s.addRow("C"); // every prior row terminal, so C opens a new run
  rows = s.snapshot().rows;
  check("addRow opens new run when all prior terminal", runIds(rows).length === 2, runIds(rows));
  check("C is alone in run 2", rows.filter((r) => r.runId === rows[2]!.runId).length === 1);

  // Same label can recur across runs (dedup is per-run only).
  s.addRow("A"); // A already exists in run 1, but run 2 is active, so this is allowed
  rows = s.snapshot().rows;
  check("same label allowed in a different run", rows.filter((r) => r.label === "A").length === 2, rows.map((r) => r.label));
}

const mode = process.argv[2];

if (mode === "init") {
  scenarioInit();
  process.exit(fail > 0 ? 1 : 0);
} else if (mode === "addrow") {
  scenarioAddRow();
  process.exit(fail > 0 ? 1 : 0);
} else {
  // Orchestrator: run each scenario in its own process with a fresh HOME.
  let failed = 0;
  for (const scn of SCENARIOS) {
    const home = mkdtempSync(join(tmpdir(), "murmur-smoke-"));
    const res = spawnSync("bun", ["run", thisFile, scn], {
      stdio: "inherit",
      env: { ...process.env, HOME: home },
    });
    if (res.status !== 0) failed += 1;
  }
  console.log("");
  console.log(failed === 0 ? "Progress-run smoke: all scenarios pass." : `Progress-run smoke: ${failed} scenario(s) failed.`);
  process.exit(failed > 0 ? 1 : 0);
}
