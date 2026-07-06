#!/usr/bin/env node
// uninstall.ts: reverse everything setup.ts wired into ~/.claude. Also
// compiled by tsdown to dist/uninstall.js so it runs under plain Node.
//
//   1. Removes the Murmur hook from ~/.claude/hooks (and any legacy bash
//      hooks plus their lib helpers from pre-rewrite installs).
//   2. Strips every Murmur hook registration from ~/.claude/settings.json
//      (backed up first), dropping groups and events that end up empty.
//   3. Removes the managed Murmur block from ~/.claude/CLAUDE.md (backed up).
//   4. Unregisters the MCP server (`claude mcp remove --scope user murmur`).
//   5. Removes the two bundled skills from ~/.claude/skills.
//   6. With --purge, also deletes the runtime state dir ~/.claude/state/murmur
//      (session traces, task maps, warnings.log, native-alert.pref).
//
// Idempotent and tolerant of partial installs: anything already absent is a
// no-op, never an error. The repo clone itself is yours to delete afterwards.

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  HOOKS_DST,
  SKILLS_DST,
  SETTINGS,
  CLAUDE_MD,
  STATE_DIR,
  BEGIN_MARKER,
  END_MARKER,
  HOOK_FILE,
  HOOK_SUBCOMMANDS,
  HOOK_CMD,
  LEGACY_HOOKS,
  LEGACY_LIB,
  LEGACY_HOOK_CMDS,
  SKILL_NAMES,
  stripHookCommands,
  type Settings,
} from "./install-shared.ts";

const purge = process.argv.includes("--purge");
const log = (msg: string): void => console.log(`==> ${msg}`);

// --- 1. hook files ------------------------------------------------------------
log("removing hook from ~/.claude/hooks");
rmSync(join(HOOKS_DST, HOOK_FILE), { force: true });
for (const name of LEGACY_HOOKS) rmSync(join(HOOKS_DST, name), { force: true });
const libDir = join(HOOKS_DST, "lib");
for (const name of LEGACY_LIB) rmSync(join(libDir, name), { force: true });
if (existsSync(libDir) && readdirSync(libDir).length === 0) {
  rmSync(libDir, { recursive: true, force: true });
}

// --- 2. settings.json registrations -------------------------------------------
if (existsSync(SETTINGS)) {
  let settings: Settings | null = null;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as Settings;
  } catch {
    console.error(`settings.json is not valid JSON; leaving it untouched. Remove the murmur hook entries from ${SETTINGS} by hand.`);
  }
  if (settings) {
    writeFileSync(`${SETTINGS}.bak`, readFileSync(SETTINGS, "utf8"));
    const murmurCmds = new Set([...HOOK_SUBCOMMANDS.map(HOOK_CMD), ...LEGACY_HOOK_CMDS]);
    const removed = stripHookCommands(settings, (command) => murmurCmds.has(command));
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
    log(removed === 0 ? "no hook registrations found in settings.json" : `removed ${removed} hook registration(s) from settings.json`);
  }
} else {
  log("no settings.json found (skipping)");
}

// --- 3. CLAUDE.md managed block ------------------------------------------------
if (existsSync(CLAUDE_MD)) {
  const original = readFileSync(CLAUDE_MD, "utf8");
  const beginIdx = original.indexOf(BEGIN_MARKER);
  const endIdx = original.indexOf(END_MARKER);
  if (beginIdx !== -1 && endIdx !== -1) {
    writeFileSync(`${CLAUDE_MD}.bak`, original);
    const stripped =
      original.slice(0, beginIdx) + original.slice(endIdx + END_MARKER.length);
    writeFileSync(CLAUDE_MD, `${stripped.replace(/\n{3,}/g, "\n\n").trim()}\n`);
    log("removed the managed Murmur block from CLAUDE.md");
  } else {
    log("no managed Murmur block in CLAUDE.md (skipping)");
  }
} else {
  log("no CLAUDE.md found (skipping)");
}

// --- 4. MCP registration --------------------------------------------------------
log("unregistering the MCP server (user scope)");
try {
  execFileSync("claude", ["mcp", "remove", "--scope", "user", "murmur"], { stdio: "ignore" });
} catch {
  console.log("    could not run `claude mcp remove` (not registered, or the CLI is not on PATH)");
}

// --- 5. skills -------------------------------------------------------------------
for (const skill of SKILL_NAMES) {
  const dir = join(SKILLS_DST, skill);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    log(`removed skill ${skill}`);
  }
}

// --- 6. runtime state (opt-in) ----------------------------------------------------
if (purge) {
  rmSync(STATE_DIR, { recursive: true, force: true });
  log("purged runtime state (~/.claude/state/murmur)");
} else if (existsSync(STATE_DIR)) {
  log(`runtime state kept at ${STATE_DIR} (re-run with --purge to delete session traces)`);
}

console.log("");
console.log("Murmur uninstalled. Restart Claude Code to drop the loaded hooks and MCP server.");
console.log("The repo clone itself can now be deleted.");
