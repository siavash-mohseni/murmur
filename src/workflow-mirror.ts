// workflow-mirror.ts: tails the Claude Code dynamic-workflow run files for the
// active session and projects them into the dashboard's live-only `workflows`
// slice (see state.ts WorkflowMirror). Read-only and self-contained in the
// long-lived parent MCP process — there is no Workflow tool_use to hook, so a
// cheap 5s poll is the mechanism (mirrors startSessionIdPolling).
//
// Two sources, because the run-level summary file only exists at completion:
//   - LIVE runs  -> subagents/workflows/<runId>/journal.jsonl (started/result
//                   lines, grouped by resume `key` so runtime retries of a dead
//                   agent collapse into one logical row with an attempt count)
//                   + each agent-<id>.jsonl transcript. The script's
//                   display label is in-memory only and never hits disk, so we
//                   reconstruct a label from the agent's prompt (the first user
//                   message), and read the model / token usage / tool_use blocks
//                   straight out of the transcript. Sibling agents in a fan-out
//                   share a long preamble, so we strip the common prefix and use
//                   the divergent tail as the label.
//   - DONE runs  -> workflows/<runId>.json (authoritative phases, labels,
//                   tokens, per-agent state, summary).
//
// Every read is best-effort: ENOENT/partial-JSON is treated as empty and the
// last good projection is kept. All preview text is truncated server-side and
// can be suppressed with MURMUR_WORKFLOW_PREVIEWS=0.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionScratchDir } from "./titles.js";
import { bashIntent, basename } from "./intent.js";
import type {
  RowStatus,
  Store,
  WorkflowAgentMirror,
  WorkflowMirror,
  WorkflowPhaseMirror,
  WorkflowRunStatus,
} from "./state.js";

const POLL_MS = 5_000;
// When no run is live (every run on disk is completed/terminal), back off the
// poll to this slower cadence so an idle session does not pay the full readdir/
// stat scan every 5s. Resets to POLL_MS on the first live run seen again.
const IDLE_POLL_MS = 20_000;
const STALE_MS = 4 * 60 * 1000; // a live run idle this long is badged "stale"
const PREVIEW_MAX = 180;
const MAX_AGENTS = 200;
const MAX_RUNS = 50;
const PREVIEWS_ON = process.env["MURMUR_WORKFLOW_PREVIEWS"] !== "0";

// Paths touched during the current tick. The per-path file caches are pruned at
// the end of each tick to the keys recorded here, so caches stay proportional to
// the runs/agents currently on disk instead of growing for the whole session.
const seenThisTick = new Set<string>();
function markSeen(path: string): void {
  seenThisTick.add(path);
}
function pruneCache<V>(cache: Map<string, V>): void {
  for (const key of cache.keys()) {
    if (!seenThisTick.has(key)) cache.delete(key);
  }
}

function clip(s: unknown): string | undefined {
  if (!PREVIEWS_ON || typeof s !== "string") return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX - 1) + "…" : t;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// Shared normalization for both status classifiers: coerce to a lowercased
// string and treat any "fail"/"error" substring as the failed case.
function toLower(raw: unknown): string {
  return String(raw ?? "").toLowerCase();
}
function isFailish(s: string): boolean {
  return s.includes("fail") || s.includes("error");
}

function normalizeAgentState(raw: unknown): RowStatus {
  const s = toLower(raw);
  if (s === "done" || s === "completed" || s === "complete" || s === "success")
    return "completed";
  if (isFailish(s)) return "failed";
  if (s === "queued" || s === "pending" || s === "waiting") return "pending";
  return "in_progress"; // running, or present-but-unrecognized
}

function normalizeRunStatus(raw: unknown): WorkflowRunStatus {
  const s = toLower(raw);
  if (isFailish(s)) return "failed";
  if (
    s.includes("stop") ||
    s.includes("abort") ||
    s.includes("cancel") ||
    s.includes("kill")
  )
    return "stopped";
  if (s === "running" || s === "in_progress") return "running";
  return "completed"; // a terminal file with an unknown status is treated as done
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeStatMs(path: string): { mtimeMs: number; birthMs: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, birthMs: st.birthtimeMs || st.ctimeMs };
  } catch {
    return null;
  }
}

// --- raw on-disk shapes ----------------------------------------------------

interface RawProgress {
  type?: string;
  index?: number;
  title?: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  agentType?: string;
  model?: string;
  state?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  resultPreview?: string;
}

interface RawWfJson {
  runId?: string;
  workflowName?: string;
  status?: string;
  startTime?: number;
  timestamp?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  summary?: string;
  phases?: { title?: string; detail?: string }[];
  workflowProgress?: RawProgress[];
}

// Completed wf_<id>.json never changes after the run ends, so cache the built
// mirror by path+mtime+size and skip re-parsing on every tick.
const completedCache = new Map<
  string,
  { mtimeMs: number; size: number; mirror: WorkflowMirror }
>();

function buildFromCompleted(
  jsonPath: string,
  runId: string
): WorkflowMirror | null {
  let size = 0;
  let mtimeMs = 0;
  try {
    const st = statSync(jsonPath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }
  markSeen(jsonPath);
  const cached = completedCache.get(jsonPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.mirror;
  }

  let json: RawWfJson;
  try {
    json = JSON.parse(readFileSync(jsonPath, "utf8")) as RawWfJson;
  } catch {
    return null;
  }

  const progress = Array.isArray(json.workflowProgress)
    ? json.workflowProgress
    : [];

  const agentsAll: WorkflowAgentMirror[] = progress
    .filter((p) => p.type === "workflow_agent" && p.agentId)
    .map((p) => ({
      agentId: String(p.agentId),
      label: p.label,
      agentType: p.agentType,
      model: p.model,
      state: normalizeAgentState(p.state),
      phaseIndex: num(p.phaseIndex),
      phaseTitle: p.phaseTitle,
      tokens: num(p.tokens),
      toolCalls: num(p.toolCalls),
      durationMs: num(p.durationMs),
      lastToolName: p.lastToolName,
      lastToolSummary: clip(p.lastToolSummary),
      resultPreview: clip(p.resultPreview),
    }));

  // Prefer the declared phases; otherwise reconstruct from the progress stream.
  let phases: WorkflowPhaseMirror[] = (json.phases ?? [])
    .filter((p) => p.title)
    .map((p, i) => ({ index: i + 1, title: String(p.title), detail: p.detail }));
  if (phases.length === 0) {
    phases = progress
      .filter((p) => p.type === "workflow_phase" && p.title)
      // Assign index deterministically here too (i + 1), matching the declared-
      // phases branch and parsePhaseObjects, so index is always a number on both
      // paths rather than undefined when the raw progress entry lacks one.
      .map((p, i) => ({ index: i + 1, title: String(p.title) }));
  }

  const doneCount = agentsAll.filter((a) => a.state === "completed").length;
  const agentCount = num(json.agentCount) ?? agentsAll.length;

  const mirror: WorkflowMirror = {
    runId,
    workflowName: json.workflowName || runId,
    status: normalizeRunStatus(json.status),
    agentCount,
    doneCount,
    phases: phases.length ? phases : undefined,
    agents: agentsAll.slice(0, MAX_AGENTS),
    totalTokens: num(json.totalTokens),
    // The completed run file only carries an output-token total, so cost for a
    // finished run is priced on output alone (input/cache aren't in the file).
    totalOutputTokens: num(json.totalTokens),
    totalToolCalls: num(json.totalToolCalls),
    durationMs: num(json.durationMs),
    startedAt: json.startTime
      ? new Date(json.startTime).toISOString()
      : undefined,
    updatedAt: json.timestamp || new Date(mtimeMs).toISOString(),
    summary: clip(json.summary),
  };

  completedCache.set(jsonPath, { mtimeMs, size, mirror });
  return mirror;
}

// Slice out the balanced [...] following a `phases:` key. String-literal aware:
// brackets inside quoted phase titles/details (e.g. `title: 'Fix [auth] bug'`)
// are data, not array nesting, so they must not move the bracket depth.
function extractPhasesArray(src: string): string | null {
  const m = src.match(/phases\s*:\s*\[/);
  if (!m || m.index === undefined) return null;
  const open = m.index + m[0].length - 1; // index of '['
  let depth = 0;
  let quote = ""; // active string delimiter, "" when outside a string literal
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      // Inside a string: skip the escaped char, and only the matching delimiter
      // closes the string. Everything else here (brackets included) is opaque.
      if (c === "\\") j++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  return null;
}

function parsePhaseObjects(arr: string): WorkflowPhaseMirror[] {
  const out: WorkflowPhaseMirror[] = [];
  // Matches each flat `{ title, detail }` phase object. A phase entry with a
  // nested object would be skipped — phase entries are flat in practice, and a
  // missed phase only degrades the live phase strip, never breaks the run.
  const objRe = /\{[^{}]*\}/g;
  let mm: RegExpExecArray | null;
  let idx = 0;
  while ((mm = objRe.exec(arr)) !== null) {
    const obj = mm[0];
    const tt = obj.match(/title\s*:\s*(['"`])([\s\S]*?)\1/);
    if (!tt) continue;
    const dd = obj.match(/detail\s*:\s*(['"`])([\s\S]*?)\1/);
    idx++;
    out.push({
      index: idx,
      title: tt[2]!.trim(),
      detail: dd ? dd[2]!.trim() || undefined : undefined,
    });
  }
  return out;
}

interface ScriptMeta {
  name?: string;
  phases: WorkflowPhaseMirror[];
}

// The persisted workflow script is write-once, so cache the parsed meta by
// path+mtime+size (same shape as completedCache / agentTxCache). Steady state
// then only stats the file each tick instead of re-reading + re-parsing it.
const scriptMetaCache = new Map<
  string,
  { mtimeMs: number; size: number; meta: ScriptMeta }
>();

// The dynamic-workflow script is persisted at scripts/<name>-<runId>.js with a
// `export const meta = { name, description, phases: [...] }` literal. The run
// name comes from the filename; the declared phases are parsed from meta.phases
// so a LIVE run can render its phase plan (the journal has no phase data).
function metaFromScript(workflowsDir: string, runId: string): ScriptMeta {
  const suffix = `-${runId}.js`;
  const scriptsDir = join(workflowsDir, "scripts");
  let file: string | undefined;
  for (const f of safeReaddir(scriptsDir)) {
    if (f.endsWith(suffix)) {
      file = f;
      break;
    }
  }
  if (!file) return { phases: [] };
  const name = file.slice(0, file.length - suffix.length);
  const path = join(scriptsDir, file);
  let mtimeMs = 0;
  let size = 0;
  try {
    const s = statSync(path);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    return { name, phases: [] };
  }
  markSeen(path);
  const cached = scriptMetaCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.meta;
  }
  let src = "";
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return { name, phases: [] };
  }
  const arr = extractPhasesArray(src);
  const meta: ScriptMeta = { name, phases: arr ? parsePhaseObjects(arr) : [] };
  scriptMetaCache.set(path, { mtimeMs, size, meta });
  return meta;
}

// agent-<id>.meta.json is written once at spawn, so cache by path. Only cache
// once the file parses cleanly. A not-yet-written meta (ENOENT) or one caught
// mid-write (partial JSON) returns undefined WITHOUT caching, so a later tick
// still picks up the agentType once the file is fully written.
const agentTypeCache = new Map<string, string | undefined>();
function agentTypeFromMeta(runDir: string, agentId: string): string | undefined {
  const path = join(runDir, `agent-${agentId}.meta.json`);
  markSeen(path);
  if (agentTypeCache.has(path)) return agentTypeCache.get(path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let agentType: string | undefined;
  try {
    agentType = (JSON.parse(raw) as { agentType?: string }).agentType;
  } catch {
    // Partial/invalid JSON (e.g. a meta caught mid-write): do not cache, retry
    // on the next tick once the file is complete.
    return undefined;
  }
  agentTypeCache.set(path, agentType);
  return agentType;
}

interface RawJournalLine {
  type?: string;
  agentId?: string;
  key?: string;
}

// One logical agent() call. The runtime retries a dead attempt under the same
// stable resume `key` with a fresh agentId, so all attempts of one call share
// the key. The last attempt is the live one; a `result` line marks the whole
// call done. Older journals without a key degrade to one agent per agentId.
interface JournalAgent {
  key: string;
  attempts: string[]; // agentIds in start order; last = current attempt
  doneAgentId?: string;
}

// The journal is append-only but is the one on-disk source that was re-read +
// re-parsed in full on every tick. Cache the parsed agents by path+mtime+size
// (same pattern as the other readers), so an unchanged journal (a stale run,
// or a tick where only a sibling run advanced) is a stat-only operation
// instead of a full read + per-line JSON.parse.
interface JournalParsed {
  agents: JournalAgent[];
}
const journalCache = new Map<
  string,
  { mtimeMs: number; size: number; parsed: JournalParsed }
>();

function parseJournal(journalPath: string): JournalParsed {
  let mtimeMs = 0;
  let size = 0;
  let statOk = false;
  try {
    const st = statSync(journalPath);
    mtimeMs = st.mtimeMs;
    size = st.size;
    statOk = true;
  } catch {
    // Missing journal: fall through with mtimeMs/size 0 and do not cache, so a
    // later tick re-checks once the file appears.
  }
  if (statOk) markSeen(journalPath);
  const cached = journalCache.get(journalPath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.parsed;
  }

  // Logical agents from the journal, grouped by resume key so retried
  // attempts collapse into one agent, preserving first-seen key order.
  const byKey = new Map<string, JournalAgent>();
  const agents: JournalAgent[] = [];
  let journalText = "";
  try {
    journalText = readFileSync(journalPath, "utf8");
  } catch {
    journalText = "";
  }
  for (const line of journalText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: RawJournalLine;
    try {
      parsed = JSON.parse(t) as RawJournalLine;
    } catch {
      continue;
    }
    const id = parsed.agentId;
    if (!id) continue;
    const key = parsed.key || id;
    let agent = byKey.get(key);
    if (!agent) {
      agent = { key, attempts: [] };
      byKey.set(key, agent);
      agents.push(agent);
    }
    if (!agent.attempts.includes(id)) agent.attempts.push(id);
    if (parsed.type === "result") agent.doneAgentId = id;
  }

  const result: JournalParsed = { agents };
  // Only cache once we have a real stat (a missing journal is not cached, so a
  // later tick re-checks once the file appears).
  if (statOk) journalCache.set(journalPath, { mtimeMs, size, parsed: result });
  return result;
}

// --- per-agent transcript parsing (live runs) ------------------------------
//
// Each subagent's full transcript lives at agent-<id>.jsonl. Mid-run it is the
// only place the model, token usage, tool calls and the original prompt exist
// on disk. We parse it once and cache by path+mtime+size, so steady-state only
// the actively-writing agents re-parse each tick.

interface AgentTx {
  prompt?: string;
  model?: string;
  outputTokens: number;
  // Full usage so the dashboard can price workflow agents with the same model
  // as the main session (input/cache/output), not just output.
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  toolCalls: number;
  lastToolName?: string;
  lastToolSummary?: string;
  lastText?: string;
  firstTsMs?: number;
  lastTsMs?: number;
}

const agentTxCache = new Map<
  string,
  { mtimeMs: number; size: number; tx: AgentTx }
>();

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (typeof b === "string") parts.push(b);
      else if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string")
        parts.push((b as { text: string }).text);
    }
    const joined = parts.join("\n").trim();
    return joined || undefined;
  }
  return undefined;
}

// A short, human "what this agent is doing" line from a tool_use block. Reuses
// the shared intent layer so a Bash step reads "Searched for X", not the raw cmd.
function toolSummary(name: unknown, input: unknown): string | undefined {
  const n = String(name ?? "");
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (n === "Bash" && typeof o["command"] === "string")
    return bashIntent(o["command"] as string).headline;
  if (
    (n === "Read" || n === "Edit" || n === "Write" || n === "MultiEdit" || n === "NotebookEdit") &&
    typeof o["file_path"] === "string"
  )
    return `${n} ${basename(o["file_path"] as string)}`;
  if (n === "Grep" && typeof o["pattern"] === "string")
    return `Searched for "${(o["pattern"] as string).slice(0, 40)}"`;
  if (n === "Glob" && typeof o["pattern"] === "string") return `Globbed ${o["pattern"]}`;
  if (n === "WebFetch" && typeof o["url"] === "string") return `Fetched ${o["url"]}`;
  if (n === "WebSearch" && typeof o["query"] === "string") return `Searched the web for ${o["query"]}`;
  if ((n === "Task" || /agent/i.test(n)) && typeof o["description"] === "string")
    return o["description"] as string;
  return n || undefined;
}

function tsMs(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseAgentTranscript(runDir: string, agentId: string): AgentTx | null {
  const path = join(runDir, `agent-${agentId}.jsonl`);
  let mtimeMs = 0;
  let size = 0;
  try {
    const st = statSync(path);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    return null;
  }
  markSeen(path);
  const cached = agentTxCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.tx;

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const tx: AgentTx = {
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: 0,
  };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let d: {
      type?: string;
      timestamp?: string;
      message?: {
        model?: unknown;
        content?: unknown;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        };
      };
    };
    try {
      d = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = tsMs(d.timestamp);
    if (ts !== undefined) {
      if (tx.firstTsMs === undefined) tx.firstTsMs = ts;
      tx.lastTsMs = ts;
    }
    const msg = d.message;
    if (!msg || typeof msg !== "object") continue;

    if (d.type === "user" && tx.prompt === undefined) {
      tx.prompt = textFromContent(msg.content);
      continue;
    }
    if (d.type === "assistant") {
      if (!tx.model && typeof msg.model === "string") tx.model = msg.model;
      const u = msg.usage;
      const addUsage = (v: unknown, key: "outputTokens" | "inputTokens" | "cacheReadTokens" | "cacheCreationTokens"): void => {
        if (typeof v === "number" && Number.isFinite(v)) tx[key] += v;
      };
      addUsage(u?.output_tokens, "outputTokens");
      addUsage(u?.input_tokens, "inputTokens");
      addUsage(u?.cache_read_input_tokens, "cacheReadTokens");
      addUsage(u?.cache_creation_input_tokens, "cacheCreationTokens");
      const c = msg.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || typeof b !== "object") continue;
          const block = b as { type?: string; name?: unknown; input?: unknown; text?: unknown };
          if (block.type === "tool_use") {
            tx.toolCalls += 1;
            if (typeof block.name === "string") tx.lastToolName = block.name;
            const sum = toolSummary(block.name, block.input);
            if (sum) tx.lastToolSummary = sum;
          } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            tx.lastText = block.text;
          }
        }
      }
    }
  }
  agentTxCache.set(path, { mtimeMs, size, tx });
  return tx;
}

// Longest common character prefix shared by all (defined) prompts in a run.
// Fan-out agents share a big preamble; the divergent tail is the real label.
function commonPrefixLen(strings: (string | undefined)[]): number {
  const valid = strings.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (valid.length < 2) return 0;
  const first = valid[0]!;
  let len = first.length;
  for (let i = 1; i < valid.length; i++) {
    const s = valid[i]!;
    const max = Math.min(len, s.length);
    let j = 0;
    while (j < max && first[j] === s[j]) j++;
    len = j;
    if (len === 0) break;
  }
  return len;
}

// Collapse absolute paths to their basename so labels stay readable: a path of
// two-or-more segments becomes its last segment ("/a/b/c.ts" -> "c.ts").
function shortenPaths(s: string): string {
  return s.replace(/(?:\/[\w.@-]+){2,}/g, (m) => m.slice(m.lastIndexOf("/") + 1));
}

function clipLabel(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

function deriveAgentLabel(prompt: string | undefined, lcpLen: number): string | undefined {
  if (!prompt) return undefined;
  let rest = prompt.slice(lcpLen).replace(/^[\s>*#)\]}.:–—-]+/, "");
  // If the divergent tail is empty (identical prompts), label off the full text.
  if (rest.trim().length < 4) rest = prompt;
  const firstLine = rest.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return undefined;
  const cleaned = shortenPaths(firstLine).replace(/\s+/g, " ").trim();
  return cleaned ? clipLabel(cleaned, 72) : undefined;
}

function buildFromLive(
  subagentsWfDir: string,
  workflowsDir: string,
  runId: string
): WorkflowMirror | null {
  const runDir = join(subagentsWfDir, runId);
  const journalPath = join(runDir, "journal.jsonl");
  const jstat = safeStatMs(journalPath);
  const dirStat = safeStatMs(runDir);

  // Logical agents from the journal: retried attempts share a resume key and
  // collapse into one agent (cached by mtime+size, so an unchanged journal is
  // a stat-only read).
  const { agents: logical } = parseJournal(journalPath);

  const shown = logical.slice(0, MAX_AGENTS);

  // Parse every attempt's transcript (cached): the run totals must count dead
  // retries' real token/tool consumption, while each row's label/model/state
  // come from the displayed attempt — the result attempt once done, else the
  // latest retry. Labels are derived by stripping the prompt prefix shared
  // across all siblings.
  const txById = new Map<string, AgentTx | null>();
  for (const la of shown) {
    for (const id of la.attempts) txById.set(id, parseAgentTranscript(runDir, id));
  }
  const displayIdOf = (la: JournalAgent): string =>
    la.doneAgentId ?? la.attempts[la.attempts.length - 1]!;
  // Cluster prompts by a short head before computing the common prefix: one
  // run mixes fan-out siblings (long shared preamble, divergent tail) with
  // unrelated agents (a synthesizer/judge), and a single run-wide prefix is
  // zeroed out by the first unrelated prompt, leaving every sibling labeled by
  // the same shared first line. Within a cluster the shared preamble strips
  // away; a singleton cluster keeps its full first line (lcp 0).
  const CLUSTER_HEAD = 40;
  const clusters = new Map<string, (string | undefined)[]>();
  for (const la of shown) {
    const p = txById.get(displayIdOf(la))?.prompt;
    if (!p) continue;
    const head = p.slice(0, CLUSTER_HEAD);
    const list = clusters.get(head);
    if (list) list.push(p);
    else clusters.set(head, [p]);
  }
  const lcpFor = (prompt: string | undefined): number => {
    if (!prompt) return 0;
    return commonPrefixLen(clusters.get(prompt.slice(0, CLUSTER_HEAD)) ?? []);
  };

  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let totalToolCalls = 0;
  const agents: WorkflowAgentMirror[] = shown.map((la) => {
    const displayId = displayIdOf(la);
    const tx = txById.get(displayId) ?? null;
    const isDone = la.doneAgentId !== undefined;
    // Tokens/tools sum across ALL attempts (retries burned them too); the
    // duration spans the first attempt's start to the newest timestamp seen.
    let tokens = 0;
    let toolCalls = 0;
    let firstTs: number | undefined;
    let lastTs: number | undefined;
    for (const id of la.attempts) {
      const t = txById.get(id);
      if (!t) continue;
      tokens += t.outputTokens;
      toolCalls += t.toolCalls;
      totalInputTokens += t.inputTokens;
      totalCacheReadTokens += t.cacheReadTokens;
      totalCacheCreationTokens += t.cacheCreationTokens;
      if (t.firstTsMs !== undefined && (firstTs === undefined || t.firstTsMs < firstTs))
        firstTs = t.firstTsMs;
      if (t.lastTsMs !== undefined && (lastTs === undefined || t.lastTsMs > lastTs))
        lastTs = t.lastTsMs;
    }
    totalTokens += tokens;
    totalToolCalls += toolCalls;
    const durationMs =
      firstTs !== undefined && lastTs !== undefined
        ? Math.max(0, lastTs - firstTs)
        : undefined;
    return {
      agentId: displayId,
      label: deriveAgentLabel(tx?.prompt, lcpFor(tx?.prompt)),
      agentType: agentTypeFromMeta(runDir, displayId),
      model: tx?.model,
      state: isDone ? "completed" : "in_progress",
      attempts: la.attempts.length > 1 ? la.attempts.length : undefined,
      tokens: tokens || undefined,
      toolCalls: toolCalls || undefined,
      durationMs,
      lastToolName: tx?.lastToolName,
      // While running, show the current action; once done, show the result text.
      lastToolSummary: isDone ? undefined : clip(tx?.lastToolSummary),
      resultPreview: isDone ? clip(tx?.lastText) : undefined,
    };
  });

  const idleMs = jstat ? Date.now() - jstat.mtimeMs : Infinity;
  const status: WorkflowRunStatus = idleMs > STALE_MS ? "stale" : "running";

  const updatedAt = jstat
    ? new Date(jstat.mtimeMs).toISOString()
    : new Date().toISOString();
  const startedAt = dirStat
    ? new Date(dirStat.birthMs || dirStat.mtimeMs).toISOString()
    : undefined;

  const { name: scriptName, phases } = metaFromScript(workflowsDir, runId);

  return {
    runId,
    workflowName: scriptName || runId,
    status,
    agentCount: logical.length,
    // doneCount is computed over the displayed (capped) agents so the count
    // never exceeds the rows actually rendered, even past MAX_AGENTS.
    doneCount: shown.reduce((n, la) => (la.doneAgentId !== undefined ? n + 1 : n), 0),
    phases: phases.length ? phases : undefined,
    agents,
    totalTokens: totalTokens || undefined,
    totalInputTokens: totalInputTokens || undefined,
    totalOutputTokens: totalTokens || undefined,
    totalCacheReadTokens: totalCacheReadTokens || undefined,
    totalCacheCreationTokens: totalCacheCreationTokens || undefined,
    totalToolCalls: totalToolCalls || undefined,
    startedAt,
    updatedAt,
  };
}

function collectRunIds(workflowsDir: string, subagentsWfDir: string): string[] {
  const ids = new Set<string>();
  for (const f of safeReaddir(workflowsDir)) {
    if (f.startsWith("wf_") && f.endsWith(".json")) {
      ids.add(f.slice(0, -".json".length));
    }
  }
  for (const d of safeReaddir(subagentsWfDir)) {
    if (d.startsWith("wf_")) ids.add(d);
  }
  return [...ids];
}

// Returns true when at least one run on disk is still live (built from the
// journal, i.e. not a terminal completed file), so the runner can poll at the
// base cadence while work is in flight and back off when everything is done.
function tick(store: Store): boolean {
  const { cwd, claudeSessionId } = store.sessionContext();
  if (!claudeSessionId) return false; // session not resolved yet, retry next tick
  const base = sessionScratchDir(cwd, claudeSessionId);
  if (!base) return false;

  seenThisTick.clear();

  const workflowsDir = join(base, "workflows");
  const subagentsWfDir = join(base, "subagents", "workflows");
  const runIds = collectRunIds(workflowsDir, subagentsWfDir);

  const mirrors: WorkflowMirror[] = [];
  let anyLive = false;
  for (const runId of runIds) {
    const completed = buildFromCompleted(
      join(workflowsDir, `${runId}.json`),
      runId
    );
    let mirror: WorkflowMirror | null = completed;
    if (!mirror) {
      mirror = buildFromLive(subagentsWfDir, workflowsDir, runId);
      if (mirror) anyLive = true;
    }
    if (mirror) mirrors.push(mirror);
  }

  // Most-recently-updated first; cap to keep the SSE payload bounded.
  mirrors.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  store.setWorkflowMirror(mirrors.slice(0, MAX_RUNS));

  // Prune any cache key not touched this tick, keeping the per-path caches
  // proportional to the runs/agents currently on disk.
  pruneCache(completedCache);
  pruneCache(scriptMetaCache);
  pruneCache(agentTypeCache);
  pruneCache(agentTxCache);
  pruneCache(journalCache);

  return anyLive;
}

/**
 * Start the workflow-mirror poll. Runs once immediately, then reschedules on an
 * unref'd timer (same effect as startSessionIdPolling). Polls at the base 5s
 * cadence while a run is live and backs off to IDLE_POLL_MS once every run on
 * disk is terminal. Any error keeps the last good projection rather than
 * clearing the panel.
 */
export function startWorkflowMirror(store: Store): void {
  const run = (): void => {
    let anyLive = false;
    try {
      anyLive = tick(store);
    } catch {
      // keep last good projection
    }
    const next = anyLive ? POLL_MS : IDLE_POLL_MS;
    const id = setTimeout(run, next);
    id.unref();
  };
  run();
}
