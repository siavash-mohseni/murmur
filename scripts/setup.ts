#!/usr/bin/env node
// setup.ts: one-command Murmur install. Run AFTER deps + build (the `setup`
// package script chains `bun install && bun run build` first). Also compiled
// by tsdown to dist/setup.js so `npx` installs run it under plain Node. This
// step wires the self-contained repo into ~/.claude:
//   1. Copies the bundled hook into ~/.claude/hooks (a single Node .mjs, no
//      jq/curl), rewriting the MURMUR_ROOT placeholder to this repo's path
//      (clone-anywhere), and removes the legacy bash hooks it replaces.
//   2. Copies the bundled skills into ~/.claude/skills.
//   3. Idempotently merges the hook registrations into ~/.claude/settings.json
//      (a re-run never duplicates an entry; settings.json is backed up first).
//   4. Injects the Murmur sections into ~/.claude/CLAUDE.md between managed
//      markers (idempotent; CLAUDE.md is backed up first).
//   5. Registers the MCP server with Claude Code (user scope).
//
// Everything Murmur needs now lives in this repo, so a clone + `bun run setup`
// is the whole install.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CLAUDE,
  HOOKS_DST,
  SKILLS_DST,
  SETTINGS,
  CLAUDE_MD,
  BEGIN_MARKER,
  END_MARKER,
  HOOK_FILE,
  HOOK_CMD,
  HOOK_SUBCOMMANDS,
  LEGACY_HOOKS,
  LEGACY_LIB,
  LEGACY_HOOK_CMDS,
  stripHookCommands,
  type HookGroup,
  type Settings,
} from "./install-shared.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_SRC = join(ROOT, "hooks");
const SKILLS_SRC = join(ROOT, "skills");
const CLAUDE_MD_SRC = join(ROOT, "claude-md", "murmur.md");
const DIST = join(ROOT, "dist", "index.js");

// Default MCP port. Single source for this script's `claude mcp add` argv and
// its manual-fallback message, so the two cannot drift apart. The canonical
// runtime default lives in src/index.ts (and src/constants.ts) -- keep this in
// sync with that if it ever changes.
const DEFAULT_PORT = 5173;

const log = (msg: string): void => console.log(`==> ${msg}`);

// True when `cmd` is runnable from PATH. The MCP server and the hook both run
// under node, so setup must prove it exists up front: the alternative is an
// install that reports success and then mirrors nothing.
const hasCommand = (cmd: string, probeArg = "--version"): boolean => {
  try {
    execFileSync(cmd, [probeArg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

// --- doctor mode: `bun scripts/setup.ts --doctor` -----------------------------
// Reports the live state of the whole pipeline (deps, build, hooks, skills,
// CLAUDE.md, MCP registration, per-session servers, warnings.log) without
// changing anything. This is the one place to look when Murmur "just doesn't
// work": every silent-fail in the hooks shows up here as a red line.
if (process.argv.includes("--doctor")) {
  await runDoctor();
}

async function runDoctor(): Promise<never> {
  let bad = 0;
  const ok = (label: string, detail = ""): void => {
    console.log(`OK  ${label}${detail ? `  (${detail})` : ""}`);
  };
  const fail = (label: string, fix: string): void => {
    bad++;
    console.log(`!!  ${label}\n      fix: ${fix}`);
  };

  console.log("murmur doctor\n--- dependencies");
  if (hasCommand("node")) ok("node");
  else fail("node not on PATH", "install Node.js (server and hook both run under node)");
  if (hasCommand("claude")) ok("claude CLI");
  else fail("claude CLI not on PATH", "install Claude Code, or register the MCP server manually");
  if (process.platform === "darwin") {
    if (hasCommand("swiftc")) ok("swiftc (native alert)");
    else console.log("--  swiftc missing: native alert channel unavailable (xcode-select --install)");
  }

  console.log("--- build");
  if (existsSync(DIST)) ok("dist/index.js");
  else fail("dist/index.js missing", "bun run build");

  console.log("--- install");
  if (existsSync(join(HOOKS_DST, HOOK_FILE))) ok("hook copied", HOOK_FILE);
  else fail(`hook missing: ${HOOK_FILE}`, "bun run setup");
  const staleLegacy = LEGACY_HOOKS.filter((h) => existsSync(join(HOOKS_DST, h)));
  if (staleLegacy.length > 0) {
    fail(`legacy bash hooks still present: ${staleLegacy.join(", ")}`, "bun run setup (removes them)");
  }
  let registered = 0;
  try {
    const s = readFileSync(SETTINGS, "utf8");
    registered = HOOK_SUBCOMMANDS.filter((sub) => s.includes(HOOK_CMD(sub))).length;
  } catch {
    // treated as zero registrations below
  }
  if (registered === HOOK_SUBCOMMANDS.length) ok("hook registrations in settings.json");
  else fail(`only ${registered}/${HOOK_SUBCOMMANDS.length} hook events registered in settings.json`, "bun run setup");
  for (const skill of ["murmur", "progress-dashboard"]) {
    if (existsSync(join(SKILLS_DST, skill, "SKILL.md"))) ok(`skill ${skill}`);
    else fail(`skill ${skill} missing`, "bun run setup");
  }
  if (existsSync(CLAUDE_MD) && readFileSync(CLAUDE_MD, "utf8").includes(BEGIN_MARKER)) {
    ok("CLAUDE.md managed block");
  } else {
    fail("CLAUDE.md managed block missing", "bun run setup");
  }
  try {
    const list = execFileSync("claude", ["mcp", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (/^murmur\b/m.test(list)) ok("MCP server registered (user scope)");
    else fail("MCP server not registered", `claude mcp add --scope user murmur -- node ${DIST} --port ${DEFAULT_PORT}`);
  } catch {
    console.log("--  could not run `claude mcp list` (skipping MCP check)");
  }

  console.log("--- sessions");
  const sessionsDir = join(CLAUDE, "state", "murmur", "sessions");
  const portFiles = existsSync(sessionsDir)
    ? readdirSync(sessionsDir).filter((f) => f.endsWith(".port"))
    : [];
  if (portFiles.length === 0) console.log("--  no live session port files");
  for (const f of portFiles) {
    const key = f.replace(/\.port$/, "");
    let port = 0;
    try {
      port = parseInt(readFileSync(join(sessionsDir, f), "utf8").trim(), 10);
    } catch {
      // unreadable port file falls through to the stale branch below
    }
    const probe = await probeJson(`http://127.0.0.1:${port}/watchers`);
    if (probe && typeof probe === "object" && "watching" in probe) {
      const w = probe as { clients?: number; native?: boolean; watching?: boolean };
      ok(`session ${key} on :${port}`, `${w.clients ?? 0} tab(s), native ${w.native ? "on" : "off"}`);
    } else if (await probeJson(`http://127.0.0.1:${port}/state`)) {
      ok(`session ${key} on :${port}`, "pre-/watchers build");
    } else {
      fail(`session ${key}: stale port file (:${port} not answering)`, `it is pruned on the next server start, or delete ${join(sessionsDir, f)}`);
    }
  }

  const warnLog = join(CLAUDE, "state", "murmur", "warnings.log");
  if (existsSync(warnLog)) {
    const lines = readFileSync(warnLog, "utf8").trim().split("\n");
    console.log(`--- warnings.log (${lines.length} lines, last 3)`);
    for (const line of lines.slice(-3)) console.log(`    ${line}`);
  }

  console.log("");
  console.log(bad === 0 ? "doctor: everything looks healthy." : `doctor: ${bad} problem(s) found.`);
  process.exit(bad === 0 ? 0 : 1);
}

async function probeJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- 0. sanity: build must have produced dist/index.js -----------------------
if (!existsSync(DIST)) {
  console.error(
    `dist/index.js not found at ${DIST}. Run \`bun run build\` first (or use \`bun run setup\`, which builds for you).`
  );
  process.exit(1);
}

// --- 0.5 sanity: runtime dependency ------------------------------------------
// The hook deliberately silent-fails at runtime (a hook must never break a
// Claude session), which makes a missing runtime the worst failure mode: setup
// "succeeds" and nothing ever mirrors. Node is the only requirement (the hook
// is a dependency-free .mjs and the MCP server runs via `node dist/index.js`).
if (!hasCommand("node")) {
  console.error(
    "node is not on PATH. The MCP server and the Murmur hook both run under Node.js.\n" +
      "Install Node.js, then re-run setup."
  );
  process.exit(1);
}

// --- 0.7 native alert helper (optional, macOS + swiftc only) ------------------
// The native modal is a pure enhancement: without the binary the alert channel
// falls back to osascript at runtime. Build it opportunistically when the
// toolchain is present instead of making swiftc an install requirement.
if (process.platform === "darwin") {
  if (hasCommand("swiftc")) {
    log("building native alert helper (swiftc found)");
    try {
      execFileSync("bash", [join(ROOT, "scripts", "build-native.sh")], { cwd: ROOT, stdio: "inherit" });
    } catch {
      console.error("native alert build failed; continuing (the channel falls back to osascript).");
    }
  } else {
    log("skipping native alert helper (swiftc not found; osascript fallback is used)");
  }
}

// --- 1. hooks ---------------------------------------------------------------
log("copying hook -> ~/.claude/hooks");
mkdirSync(HOOKS_DST, { recursive: true });
cpSync(HOOKS_SRC, HOOKS_DST, { recursive: true });
chmodSync(join(HOOKS_DST, HOOK_FILE), 0o755);

// Remove the legacy bash hooks the Node entry replaced (and their lib helpers,
// which nothing else sources). A fresh install is a no-op here; an upgrade
// leaves no orphaned scripts behind.
for (const name of LEGACY_HOOKS) {
  rmSync(join(HOOKS_DST, name), { force: true });
}
const legacyLibDir = join(HOOKS_DST, "lib");
for (const name of LEGACY_LIB) {
  rmSync(join(legacyLibDir, name), { force: true });
}
if (existsSync(legacyLibDir) && readdirSync(legacyLibDir).length === 0) {
  rmSync(legacyLibDir, { recursive: true, force: true });
}

// Rewrite the MURMUR_ROOT placeholder in the copied hook to this repo's
// absolute path, so the "skip while editing Murmur" self-exclude works no
// matter where the repo was cloned. Re-running setup re-copies the source
// (placeholder intact) then re-substitutes, so it stays idempotent.
{
  const p = join(HOOKS_DST, HOOK_FILE);
  const src = readFileSync(p, "utf8");
  const out = src.replaceAll("__MURMUR_ROOT__", ROOT);
  if (out !== src) writeFileSync(p, out);
}

// --- 2. skills --------------------------------------------------------------
log("copying skills -> ~/.claude/skills");
mkdirSync(SKILLS_DST, { recursive: true });
for (const skill of readdirSync(SKILLS_SRC)) {
  cpSync(join(SKILLS_SRC, skill), join(SKILLS_DST, skill), { recursive: true });
}

// --- 3. settings.json hook registration (idempotent) ------------------------
// Mirrors the established registration shape (matchers included). Every event
// dispatches through the single Node hook entry with a subcommand.
const REGISTRATIONS: { event: string; matcher: string | null; command: string }[] = [
  // PermissionRequest (not PreToolUse): the hook must only fire when the CLI
  // would actually show a permission dialog, so allowlisted / auto-approved /
  // bypassPermissions commands never get a Murmur modal.
  { event: "PermissionRequest", matcher: "Bash", command: HOOK_CMD("permission") },
  { event: "PreToolUse", matcher: "AskUserQuestion", command: HOOK_CMD("question") },
  {
    event: "PostToolUse",
    matcher:
      "TaskCreate|TaskUpdate|Edit|Write|MultiEdit|NotebookEdit|Read|Bash|Glob|Grep|WebFetch|WebSearch|Agent|Task|Skill|AskUserQuestion",
    command: HOOK_CMD("mirror"),
  },
  { event: "UserPromptSubmit", matcher: null, command: HOOK_CMD("user-prompt") },
  { event: "PreCompact", matcher: null, command: HOOK_CMD("precompact") },
  { event: "Stop", matcher: null, command: HOOK_CMD("stop") },
];

log("merging hook registrations into ~/.claude/settings.json");
let settings: Settings = {};
if (existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8")) as Settings;
  } catch {
    console.error(`settings.json is not valid JSON; leaving it untouched. Fix ${SETTINGS} and re-run.`);
    process.exit(1);
  }
  // Back up before we touch it.
  writeFileSync(`${SETTINGS}.bak`, readFileSync(SETTINGS, "utf8"));
}
// One-time migration: every registration pointing at a legacy bash hook is
// removed (whatever event it sits under) so an upgraded install never fires a
// hook twice. This also covers the old PreToolUse -> PermissionRequest move.
stripHookCommands(settings, (command) => LEGACY_HOOK_CMDS.includes(command));
settings.hooks ??= {};

let added = 0;
for (const { event, matcher, command } of REGISTRATIONS) {
  const groups = (settings.hooks[event] ??= []);
  const already = groups.some(
    (g) => Array.isArray(g.hooks) && g.hooks.some((h) => h.command === command)
  );
  if (already) continue;
  // Reuse an existing group with the same matcher when there is one, else add a
  // fresh group. (null matcher == an event-level group with no `matcher` key.)
  const target = groups.find((g) =>
    matcher === null ? g.matcher === undefined : g.matcher === matcher
  );
  if (target) {
    target.hooks.push({ type: "command", command });
  } else {
    const group: HookGroup = { hooks: [{ type: "command", command }] };
    if (matcher !== null) group.matcher = matcher;
    groups.push(group);
  }
  added++;
}
writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
log(added === 0 ? "hooks already registered (no changes)" : `registered ${added} hook(s)`);

// --- 4. CLAUDE.md Murmur sections (idempotent) ------------------------------
// The three Murmur sections (Murmur Mode, Artifact Design, Progress Dashboard)
// are the single source of truth in claude-md/murmur.md and get injected into
// ~/.claude/CLAUDE.md between managed markers. A re-run replaces the block in
// place, so a second run is byte-identical. A first run on a machine that still
// carries the sections inline (pre-marker) migrates them out so they are not
// duplicated. CLAUDE.md is backed up to CLAUDE.md.bak before any write.
const LEGACY_HEADINGS = [
  "Murmur Mode",
  "Artifact Design",
  "Progress Dashboard (multi-phase orchestrators)",
];

// Remove a "## <heading>" section and its body (up to the next level-1/2
// heading or EOF). Used once to migrate pre-marker inline copies out of the way.
const stripSection = (text: string, heading: string): string => {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].trim() === `## ${heading}`) {
      i++; // drop the heading line
      while (i < lines.length && !/^#{1,2} /.test(lines[i])) i++; // drop the body
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
};

log("injecting Murmur sections into ~/.claude/CLAUDE.md");
const murmurSections = readFileSync(CLAUDE_MD_SRC, "utf8").trim();
const block = `${BEGIN_MARKER}\n${murmurSections}\n${END_MARKER}`;

let claudeMd = existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, "utf8") : "";
if (existsSync(CLAUDE_MD)) writeFileSync(`${CLAUDE_MD}.bak`, claudeMd);

const beginIdx = claudeMd.indexOf(BEGIN_MARKER);
const endIdx = claudeMd.indexOf(END_MARKER);
if (beginIdx !== -1 && endIdx !== -1) {
  // Managed block already present: replace it in place (idempotent re-run).
  claudeMd = claudeMd.slice(0, beginIdx) + block + claudeMd.slice(endIdx + END_MARKER.length);
} else {
  // No markers yet: migrate away any legacy inline sections, then append.
  for (const h of LEGACY_HEADINGS) claudeMd = stripSection(claudeMd, h);
  const base = claudeMd.replace(/\n{3,}/g, "\n\n").trimEnd();
  claudeMd = base.length ? `${base}\n\n${block}\n` : `${block}\n`;
}
writeFileSync(CLAUDE_MD, claudeMd);

// --- 5. MCP registration ----------------------------------------------------
log("registering MCP server with Claude Code (user scope)");
try {
  try {
    const list = execFileSync("claude", ["mcp", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (/^murmur\b/m.test(list)) {
      execFileSync("claude", ["mcp", "remove", "--scope", "user", "murmur"], { stdio: "ignore" });
    }
  } catch {
    // `claude mcp list` may fail if nothing is registered yet, which is fine.
  }
  execFileSync("claude", ["mcp", "add", "--scope", "user", "murmur", "--", "node", DIST, "--port", String(DEFAULT_PORT)], {
    stdio: "inherit",
  });
} catch {
  console.error(
    "Could not run `claude mcp add` (is the Claude Code CLI on your PATH?). Register manually:\n" +
      `  claude mcp add --scope user murmur -- node ${DIST} --port ${DEFAULT_PORT}`
  );
}

// --- 6. end-to-end smoke ------------------------------------------------------
// Prove the installed pipeline actually works, not just that files landed: the
// mirror smoke boots the built server in an isolated temp HOME and drives the
// real PostToolUse hook through it. This is what catches a missing jq, a
// broken dist, or a hook regression at install time instead of as a silently
// dead dashboard later.
log("verifying the pipeline end-to-end (mirror smoke)");
let smokeOk = false;
try {
  execFileSync("node", [join(ROOT, "scripts", "mirror-hook-smoke.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  smokeOk = true;
  log("smoke passed: hook -> server -> state round-trip works");
} catch (err) {
  const e = err as { stdout?: string; stderr?: string };
  console.error("Smoke FAILED. The files are installed but the pipeline is not healthy:");
  if (e.stdout) console.error(e.stdout.trim());
  if (e.stderr) console.error(e.stderr.trim());
  console.error("Run `bun scripts/setup.ts --doctor` to diagnose.");
}

console.log("");
console.log("Murmur installed. Restart Claude Code to pick up the MCP server and hooks.");
console.log("Then any prompt containing --murmur activates Murmur mode.");
if (!smokeOk) process.exit(1);
