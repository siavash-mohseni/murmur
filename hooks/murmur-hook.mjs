#!/usr/bin/env node
// murmur-hook.mjs: the single Node entry point for every Murmur hook. Replaces
// the previous six bash+jq+curl scripts with one dependency-free ESM file, so
// the install needs no jq or curl and the hot path (the PostToolUse mirror,
// which used to spawn ~15 jq processes per tool call) runs as one process.
//
// Dispatch is by argv: `node murmur-hook.mjs <mirror|permission|question|
// user-prompt|precompact|stop>`. Each subcommand preserves the exact behavior
// of the bash hook it replaces:
//
//   mirror       PostToolUse   mirrors tool calls into Activity/Progress
//   permission   PermissionRequest   routes Bash permission prompts (blocks)
//   question     PreToolUse(AskUserQuestion)   redirects to murmur_ask (exit 2)
//   user-prompt  UserPromptSubmit   records the prompt, injects the reminder
//   precompact   PreCompact    re-primes the transcript scanner
//   stop         Stop          turn-end transcript pings (5x, cursor dedupes)
//
// Fail-open everywhere: any parse error, missing field, or unreachable server
// exits 0 so a hook can never break a Claude session. The only deliberate
// non-zero exits are the two blocking paths (question redirect, permission
// deny), which exit 2 by contract with the harness.

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const STATE_DIR = join(HOME, ".claude", "state", "murmur");
const SESSIONS_DIR = process.env.SESSIONS_DIR || join(STATE_DIR, "sessions");
const WARN_LOG = process.env.WARN_LOG || join(STATE_DIR, "warnings.log");
const TASK_MAPS_DIR = join(STATE_DIR, "task-maps");

// scripts/setup.ts rewrites this placeholder to the cloned repo's absolute
// path when copying the hook into ~/.claude/hooks. The glob-matched fallback
// keeps a sane default if that rewrite never ran (e.g. the raw source hook).
let MURMUR_ROOT = "__MURMUR_ROOT__";
if (MURMUR_ROOT.startsWith("__MURMUR")) MURMUR_ROOT = join(HOME, ".claude", "mcp-servers", "murmur");

// --- tiny stdlib -------------------------------------------------------------

const readStdin = () =>
  new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });

const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

// jq's `tostring`: strings pass through, everything else serializes.
const jqToString = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v));

// Walk the PPID chain up to 10 levels looking for a parent `claude` binary,
// excluding the Murmur server itself and the notify helper.
function findClaudePid() {
  let pid = process.ppid;
  for (let i = 0; i < 10; i++) {
    if (!pid || pid <= 1) break;
    let cmd = "";
    try {
      cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
    if (/(^|\/)claude( |$)/.test(cmd) && !cmd.includes("murmur/dist") && !cmd.includes("murmur-notify")) {
      return String(pid);
    }
    try {
      pid = parseInt(execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8" }).trim(), 10);
    } catch {
      return "";
    }
  }
  return "";
}

// The 4-step per-session port lookup, in priority order:
//   1. sessions/<session_id>.port   2. sessions/claude-<ppid>.port
//   3. sessions/default.port        4. $CLAUDE_MURMUR_PORT
function resolveMurmurPort(sid) {
  const readPort = (name) => {
    try {
      return readFileSync(join(SESSIONS_DIR, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  let port = "";
  if (sid) port = readPort(`${sid}.port`);
  if (!port) {
    const claudePid = findClaudePid();
    if (claudePid) port = readPort(`claude-${claudePid}.port`);
  }
  if (!port) port = readPort("default.port");
  if (!port && process.env.CLAUDE_MURMUR_PORT) port = process.env.CLAUDE_MURMUR_PORT;
  return port;
}

// Probes GET /watchers. Returns "1" (someone is watching), "0" (alive but
// nobody watching), "legacy" (alive but predates /watchers), "" (unreachable:
// down or stale port file).
async function murmurWatching(port) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/watchers`, { signal: AbortSignal.timeout(400) });
  } catch {
    return "";
  }
  if (res.status !== 200) return "legacy";
  try {
    const body = await res.json();
    if (body.watching === true) return "1";
    if (body.watching === false) return "0";
    return "legacy";
  } catch {
    return "legacy";
  }
}

// Fire-and-log POST to /sync. Connection failures are the normal Murmur-off
// case and stay silent; a non-200 from a live server is appended to
// warnings.log (unless quiet: the prompt-capture posts never logged failures).
async function postSync(port, body, { quiet = false } = {}) {
  const url = `http://127.0.0.1:${port}/sync`;
  const payload = JSON.stringify(body);
  let status = 0;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(1000),
    });
    status = res.status;
  } catch {
    return; // server down: silent no-op
  }
  if (!quiet && status !== 200) {
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    try {
      appendFileSync(WARN_LOG, `${ts} mirror POST failed: ${status} url=${url} body=${payload}\n`);
    } catch {
      // warn log unwritable: stay silent, never break the session
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Murmur-source self-exclusion shared by question and user-prompt: while
// editing Murmur itself, murmur_ask would route through the stale in-memory
// bundle, so CLI questions are intentional there.
const isMurmurRepo = (input) => {
  const proj = process.env.CLAUDE_PROJECT_DIR || str(input.cwd);
  return proj === MURMUR_ROOT || proj.startsWith(`${MURMUR_ROOT}/`);
};

// --- subcommands --------------------------------------------------------------

// PostToolUse mirror: one `tool`/`agent`/`task-*`/`prompt` activity per fire,
// plus a `session` payload (branch, cwd, effort, modifiedFiles) and a
// `transcript` ping.
async function runMirror(input) {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const toolName = str(input.tool_name);
  if (!toolName) return;

  const toolInput = input.tool_input ?? {};
  const toolResponse = input.tool_response ?? {};
  const cwd = process.env.CLAUDE_PROJECT_DIR || str(input.cwd);
  const effort = str(input.effort?.level);
  const durationMs = typeof input.duration_ms === "number" ? input.duration_ms : 0;
  const transcriptPath = str(input.transcript_path);
  const sid = str(input.session_id);
  // jq's `//` treats false as absent, so is_error=false falls through to isError.
  const isError = toolResponse?.is_error === true || toolResponse?.isError === true;
  const ok = !isError;

  const port = resolveMurmurPort(sid);
  if (!port) return;

  // Per-session task-id -> subject map. The harness numbers task ids 1,2,3…
  // per session, so a shared map would collide across concurrent sessions.
  const tmKey = (sid || port || "default").replace(/[^A-Za-z0-9_.-]/g, "_");
  const taskMapPath = join(TASK_MAPS_DIR, `${tmKey}.json`);
  const readTaskMap = () => {
    try {
      return JSON.parse(readFileSync(taskMapPath, "utf8"));
    } catch {
      return {};
    }
  };
  const writeTaskMap = (map) => {
    mkdirSync(TASK_MAPS_DIR, { recursive: true });
    const tmp = join(tmpdir(), `murmur-tm-${process.pid}-${Date.now()}.json`);
    try {
      writeFileSync(tmp, JSON.stringify(map));
      renameSync(tmp, taskMapPath);
    } catch {
      // rename across devices or a write failure: drop the update, never throw
    }
  };

  const emitTool = (target, runInBackground) =>
    postSync(port, {
      type: "tool",
      tool: toolName,
      target: target ? target : null,
      durationMs: durationMs === 0 ? null : durationMs,
      ok,
      ...(runInBackground === undefined ? {} : { runInBackground }),
    });

  // --- session info (cheap; covers branch, cwd, effort, modifiedFiles) ---
  if (cwd) {
    let branch = "";
    let modified = 0;
    try {
      branch = execFileSync("git", ["-C", cwd, "--no-optional-locks", "branch", "--show-current"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      branch = "";
    }
    try {
      const porcelain = execFileSync("git", ["-C", cwd, "--no-optional-locks", "status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      modified = porcelain.split("\n").filter(Boolean).length;
    } catch {
      modified = 0;
    }
    const info = { modifiedFiles: modified };
    if (branch) info.branch = branch;
    if (cwd) info.cwd = cwd;
    const cwdBase = basename(cwd);
    if (cwdBase) info.cwdBasename = cwdBase;
    if (effort) info.effort = effort;
    if (sid) info.claudeSessionId = sid;
    await postSync(port, { type: "session", info });
  }

  // --- transcript path (server reads the file, mtime-cached) ---
  if (transcriptPath) {
    await postSync(port, { type: "transcript", path: transcriptPath });
  }

  // --- permission-denied detection ---
  const errText = jqToString(toolResponse?.error ?? toolResponse?.message);
  if (isError && /permission|denied|rejected|not allowed/i.test(errText)) {
    const cmdShort = str(toolInput.command || toolInput.file_path || toolInput.url).slice(0, 100);
    if (cmdShort) {
      await postSync(port, { type: "prompt", source: "permission", question: `${toolName} · ${cmdShort}`, ok: false });
    }
  }

  // --- per-tool dispatch ---
  switch (true) {
    case toolName === "AskUserQuestion": {
      const q = str(toolInput.questions?.[0]?.question || toolInput.questions?.[0]?.header);
      const ans = str(
        toolResponse?.responses?.[0]?.answer ??
          (Array.isArray(toolResponse) ? toolResponse[0]?.answer : undefined) ??
          toolResponse?.answer
      );
      if (q) {
        await postSync(port, { type: "prompt", source: "ask", question: q, answer: ans ? ans : null, ok });
      }
      break;
    }
    case toolName === "TaskCreate": {
      const subject = str(toolInput.subject || toolResponse?.task?.subject);
      const taskId = str(toolResponse?.task?.id ?? toolResponse?.taskId ?? toolResponse?.id);
      if (subject && taskId) {
        const map = readTaskMap();
        map[taskId] = subject;
        writeTaskMap(map);
      }
      if (subject) {
        // Optional run title: an orchestrator names the dashboard run via
        // metadata.murmurRun on its first TaskCreate. The server only applies
        // it when this row starts a NEW run.
        const runTitle = str(toolInput.metadata?.murmurRun);
        await postSync(port, { type: "task-create", label: subject, ...(runTitle ? { title: runTitle } : {}) });
      }
      break;
    }
    case toolName === "TaskUpdate": {
      const taskId = str(toolInput.taskId);
      const status = str(toolInput.status);
      if (!status) return;
      let label = str(toolInput.subject) || str(toolResponse?.task?.subject ?? toolResponse?.subject);
      if (!label && taskId) label = str(readTaskMap()[taskId]);
      // Map ONLY the harness's known statuses. `deleted` (the sweep a new run
      // performs) and anything unknown are skipped so a completed prior run is
      // never flipped red. Genuine failures come through murmur_update.
      const known = ["pending", "in_progress", "completed"];
      if (label && known.includes(status)) {
        await postSync(port, { type: "task-update", label, status });
      }
      break;
    }
    case toolName === "Agent" || toolName === "Task": {
      const sub = str(toolInput.subagent_type);
      const desc = str(toolInput.description);
      if (desc) {
        await postSync(port, {
          type: "agent",
          subagentType: sub ? sub : null,
          description: desc,
          durationMs: durationMs === 0 ? null : durationMs,
          ok,
        });
      }
      break;
    }
    case ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName):
      await emitTool(str(toolInput.file_path || toolInput.notebook_path));
      break;
    case toolName === "Read":
      await emitTool(str(toolInput.file_path));
      break;
    case toolName === "Bash": {
      // Keep newlines intact so the intent classifier can split multi-line
      // chains. Cap at 2000 chars to bound pathological heredocs.
      const cmd = str(toolInput.command).slice(0, 2000);
      await emitTool(cmd, Boolean(toolInput.run_in_background));
      break;
    }
    case toolName === "Skill": {
      const skill = str(toolInput.skill);
      const args = str(toolInput.args).slice(0, 120);
      await emitTool(args ? `${skill} ${args}` : skill);
      break;
    }
    case toolName === "Glob" || toolName === "Grep":
      await emitTool(str(toolInput.pattern));
      break;
    case toolName === "WebFetch":
      await emitTool(str(toolInput.url));
      break;
    case toolName === "WebSearch":
      await emitTool(str(toolInput.query));
      break;
    case toolName.startsWith("mcp__murmur__"):
      // The Murmur MCP server records its own activities; mirroring here too
      // would double every row.
      break;
    case toolName.startsWith("mcp__"): {
      // External MCP tools: pull a salient argument, known keys first, else the
      // first string-valued field. The dashboard's mcpIntent maps the tool name
      // to a human headline.
      const i = toolInput ?? {};
      const known =
        i.query ?? i.jql ?? i.text ?? i.message ?? i.summary ?? i.title ?? i.name ?? i.url ??
        i.channel ?? i.channel_id ?? i.channel_name ?? i.issueIdOrKey ?? i.issue_key ??
        i.issueKey ?? i.pageId ?? i.page_id ?? i.id;
      let arg = typeof known === "string" || typeof known === "number" ? String(known) : "";
      if (!arg) {
        for (const v of Object.values(i)) {
          if (typeof v === "string") {
            arg = v;
            break;
          }
        }
      }
      await emitTool(arg.slice(0, 120));
      break;
    }
    default:
      break; // unknown / uninteresting tool, silent skip
  }
}

// PermissionRequest: route Bash permission prompts to the Murmur modal.
// Registered on PermissionRequest (not PreToolUse) so it only fires when the
// CLI would actually show a dialog. Returns the process exit code.
async function runPermission(input) {
  if (str(input.tool_name) !== "Bash") return 0;

  // Belt-and-braces: these modes never show a dialog.
  const mode = str(input.permission_mode);
  if (mode === "bypassPermissions" || mode === "dontAsk") return 0;

  const cmd = str(input.tool_input?.command);
  if (!cmd) return 0;

  const port = resolveMurmurPort(str(input.session_id));
  if (!port) return 0;

  // Watcher gate: only route when someone can actually see the prompt in
  // Murmur. "legacy" keeps the old reachability behavior on a pre-gate server.
  const watching = await murmurWatching(port);
  if (watching === "" || watching === "0") return 0;

  let decision = "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "Bash", command: cmd, cwd: str(input.cwd), timeoutMs: 120000 }),
      signal: AbortSignal.timeout(130000),
    });
    const body = await res.json();
    decision = str(body?.decision);
  } catch {
    decision = "";
  }

  if (decision === "allow" || decision === "always") {
    // PermissionRequest decision: allow with the unmodified tool input, so the
    // harness skips its dialog and runs the command as-is.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow", updatedInput: input.tool_input ?? {} },
        },
      })
    );
    return 0;
  }
  if (decision === "deny") {
    process.stderr.write("Bash command denied via Murmur.\n");
    return 2;
  }
  return 0; // timeout, error, or unknown: fall back to the CLI prompt
}

const QUESTION_REDIRECT = `Murmur is active for this session, so questions must render in the user's browser pane, not the CLI. Do not use the built-in AskUserQuestion tool. Re-issue this question by calling the mcp__murmur__murmur_ask tool, which takes the same shape (question, header, options, multiSelect) and returns the user's answer. If you had multiple questions in one AskUserQuestion call, ask them one murmur_ask call at a time. Only if a murmur_ask call itself returns ok:false may you use AskUserQuestion for that single question.`;

// PreToolUse on AskUserQuestion: when Murmur is live and watched, block the
// CLI-only question and redirect the model to murmur_ask. Fail-open in every
// uncertain case. Returns the process exit code.
async function runQuestion(input) {
  if (str(input.tool_name) !== "AskUserQuestion") return 0;
  if (isMurmurRepo(input)) return 0;

  const port = resolveMurmurPort(str(input.session_id));
  if (!port) return 0;

  const watching = await murmurWatching(port);
  if (watching === "" || watching === "0") return 0;

  process.stderr.write(`${QUESTION_REDIRECT}\n`);
  return 2;
}

const PROMPT_REMINDER = `Murmur is active for this session. When you need a decision from the user, call the mcp__murmur__murmur_ask tool instead of the built-in AskUserQuestion, so the question renders in the user's Murmur browser pane. It takes the same shape (question, header, options, multiSelect) and returns the chosen answer. If a murmur_ask call returns ok:false, you may fall back to AskUserQuestion for that single question.`;

// UserPromptSubmit: record the prompt as an activity, prime the transcript
// scanner's cursor, trigger the MURMUR_AUTO one-shot open, and inject the
// murmur_ask routing reminder when a routed question would reach a human.
async function runUserPrompt(input) {
  const port = resolveMurmurPort(str(input.session_id));
  if (!port) return;

  const text = str(input.prompt || input.text);
  if (text) {
    const preview = text.replace(/\n/g, " ").slice(0, 400);
    await postSync(port, { type: "prompt", source: "user", question: preview, ok: true }, { quiet: true });
  }

  // Prime the transcript scanner at prompt-submit time so the turn's opening
  // assistant narration lands above the cursor and is captured on the next
  // scan (first sight at first-tool-call time would lose it).
  const transcriptPath = str(input.transcript_path);
  if (transcriptPath) {
    await postSync(port, { type: "transcript", path: transcriptPath }, { quiet: true });
  }

  // Don't steer toward murmur tools while editing the Murmur source tree.
  if (isMurmurRepo(input)) return;

  // MURMUR_AUTO=1: ask the server to open the dashboard (server-side dedupe:
  // at most one launch per server lifetime, never when a tab is connected).
  const auto = process.env.MURMUR_AUTO === "1";
  if (auto) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/autoopen`, { method: "POST", signal: AbortSignal.timeout(600) });
    } catch {
      // fire-and-forget
    }
  }

  // Watcher gate. In MURMUR_AUTO mode a reachable server counts as watching:
  // the tab was just asked to open and may not have connected yet, and
  // murmur_ask fails fast if it never does.
  let watching = await murmurWatching(port);
  if (auto && watching !== "") watching = "1";
  if (watching === "" || watching === "0") return;

  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: PROMPT_REMINDER } })
  );
}

// PreCompact: nudge the server to re-read the transcript so the Context tile
// reflects the compaction immediately instead of at the next tool call.
async function runPrecompact(input) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const transcriptPath = str(input.transcript_path);
  if (!transcriptPath) return;
  const port = resolveMurmurPort(str(input.session_id));
  if (!port) return;
  await postSync(port, { type: "transcript", path: transcriptPath });
}

// Stop: turn-end transcript pings so the final assistant message (which can
// land after the last tool call) is summarised. Poll a few times because Stop
// can fire a beat before the final JSONL write; the server's cursor dedupes.
async function runStop(input) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const transcriptPath = str(input.transcript_path);
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  const port = resolveMurmurPort(str(input.session_id));
  if (!port) return;
  for (let i = 0; i < 5; i++) {
    await postSync(port, { type: "transcript", path: transcriptPath });
    await sleep(200);
  }
}

// --- entry --------------------------------------------------------------------

const COMMANDS = {
  mirror: { run: runMirror },
  permission: { run: runPermission, blocking: true },
  question: { run: runQuestion, blocking: true },
  "user-prompt": { run: runUserPrompt },
  precompact: { run: runPrecompact },
  stop: { run: runStop },
};

async function main() {
  const cmd = COMMANDS[process.argv[2] ?? ""];
  if (!cmd) return 0;

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 0; // invalid JSON: silent no-op
  }
  if (input === null || typeof input !== "object") return 0;

  const code = await cmd.run(input);
  return typeof code === "number" ? code : 0;
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0)); // fail-open: a hook must never break a session
