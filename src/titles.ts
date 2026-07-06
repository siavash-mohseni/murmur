import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Claude Code's per-project directory slug: the absolute cwd with every "/"
 * and "." replaced by "-". This is the single most load-bearing path
 * convention in the ingest subsystem (it must stay in lockstep with how
 * Claude Code names project dirs), so it lives in one place and every caller
 * (here and in memory.ts) imports it.
 */
export function cwdToSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

// Memoised reverse-lookup: sessionId -> project slug. Built lazily on miss
// and refreshed when no answer is found (so a session whose transcript shows
// up later still resolves on a later call without restarting the process).
const sessionToProject = new Map<string, string>();
let lastFullScanAt = 0;
const FULL_SCAN_THROTTLE_MS = 30_000;

/**
 * Find the project slug whose directory contains <sessionId>.jsonl. Used
 * when the murmur state's cwd has drifted from the transcript's actual
 * project (e.g. resuming a session from a different working directory).
 */
function findProjectForSession(sessionId: string): string | undefined {
  const cached = sessionToProject.get(sessionId);
  if (cached) return cached;
  const now = Date.now();
  if (now - lastFullScanAt < FULL_SCAN_THROTTLE_MS) return undefined;
  lastFullScanAt = now;
  if (!existsSync(PROJECTS_DIR)) return undefined;
  let projects: string[];
  try {
    projects = readdirSync(PROJECTS_DIR);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const candidate = join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      sessionToProject.set(sessionId, project);
      return project;
    }
  }
  return undefined;
}

/**
 * Resolve the per-session scratch directory under ~/.claude/projects, i.e.
 * <projectSlug>/<sessionId>/, which holds `workflows/` and `subagents/`. Tries
 * the cwd-derived slug first (validated by the presence of the session's
 * transcript .jsonl), then falls back to the throttled reverse scan when cwd
 * has drifted. Returns the base session dir even if the subfolders do not
 * exist yet (callers treat a missing dir as "no runs"). undefined when the
 * session cannot be located at all.
 */
export function sessionScratchDir(
  cwd: string | undefined,
  sessionId: string
): string | undefined {
  if (!sessionId) return undefined;
  if (cwd) {
    const slug = cwdToSlug(cwd);
    const base = join(PROJECTS_DIR, slug);
    if (
      existsSync(join(base, `${sessionId}.jsonl`)) ||
      existsSync(join(base, sessionId))
    ) {
      return join(base, sessionId);
    }
  }
  const project = findProjectForSession(sessionId);
  if (project) return join(PROJECTS_DIR, project, sessionId);
  return undefined;
}

interface IndexEntry {
  sessionId: string;
  summary?: string;
  firstPrompt?: string;
}

interface IndexFile {
  version?: number;
  entries?: IndexEntry[];
}

interface ResolveResult {
  title?: string;
  source?: "customTitle" | "agentName" | "summary" | "slug" | "firstPrompt";
}

// Memoise per (path, mtime) so we don't re-parse the index on every /sessions call.
const indexCache = new Map<string, { mtimeMs: number; map: Map<string, IndexEntry> }>();

function projectIndexPath(cwd: string): string {
  const slug = cwdToSlug(cwd);
  return join(homedir(), ".claude", "projects", slug, "sessions-index.json");
}

function loadIndex(path: string): Map<string, IndexEntry> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    // Missing index file or any stat failure: no entries.
    return new Map();
  }
  const cached = indexCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.map;
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as IndexFile;
    const map = new Map<string, IndexEntry>();
    for (const e of data.entries ?? []) {
      if (e.sessionId) map.set(e.sessionId, e);
    }
    indexCache.set(path, { mtimeMs: stat.mtimeMs, map });
    return map;
  } catch {
    return new Map();
  }
}

function transcriptPath(cwd: string, sessionId: string): string {
  const slug = cwdToSlug(cwd);
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

interface TranscriptHints {
  customTitle?: string;
  agentName?: string;
  slug?: string;
}

/**
 * Scan the tail of the transcript for any of the user-set or auto-set title
 * hints. The most recent `customTitle` (set by `/rename`) wins, then
 * `agentName`, then `slug`. We read the whole file into memory and then parse
 * only the last chunk, so the parse stays cheap for long transcripts (the read
 * itself is not bounded here).
 */
function readTranscriptHints(path: string): TranscriptHints {
  const TAIL_CHARS = 128 * 1024;
  let fd: string;
  try {
    fd = readFileSync(path, "utf8");
  } catch {
    // Missing transcript or any read failure: no hints.
    return {};
  }
  // Parse only the tail. Slice by the decoded string's length, NOT the file's
  // byte size: for multi-byte UTF-8, byte size overshoots the string length, so
  // slicing at `size - N` would cut past the newest lines and miss the very
  // hints we are scanning for. The leading partial line (if any) fails to parse
  // and is skipped, and the reverse walk reads the most-recent lines first.
  const tail = fd.length <= TAIL_CHARS ? fd : fd.slice(fd.length - TAIL_CHARS);
  const lines = tail.split("\n").reverse();
  const out: TranscriptHints = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: { customTitle?: string; agentName?: string; slug?: string; type?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!out.customTitle && typeof parsed.customTitle === "string" && parsed.customTitle.length > 0) {
      out.customTitle = parsed.customTitle;
    }
    if (!out.agentName && typeof parsed.agentName === "string" && parsed.agentName.length > 0) {
      out.agentName = parsed.agentName;
    }
    if (!out.slug && typeof parsed.slug === "string" && parsed.slug.length > 0) {
      out.slug = parsed.slug;
    }
    if (out.customTitle && out.slug) break;
  }
  return out;
}

function humanise(slug: string): string {
  // "i-want-something-similar-ethereal-nova" → "I Want Something Similar Ethereal Nova"
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function resolveSessionTitle(
  claudeSessionId: string | undefined,
  cwd: string | undefined
): ResolveResult {
  if (!claudeSessionId) return {};

  // Try the cwd-derived path first (fast happy path), otherwise scan the
  // projects dir for the session's transcript. cwd may be missing or stale
  // when the murmur state was started in a different directory than the
  // session originally lived in.
  let transcript = cwd ? transcriptPath(cwd, claudeSessionId) : "";
  // The value fed to projectIndexPath below. When cwd is set this is the cwd
  // (projectIndexPath re-slugs it). When we only recovered the project via the
  // reverse scan, this is already the project slug, which projectIndexPath
  // re-slugs to itself (it contains no "/" or "."), so the index path resolves
  // either way.
  let indexKey = cwd;
  if (!transcript || !existsSync(transcript)) {
    const project = findProjectForSession(claudeSessionId);
    if (project) {
      transcript = join(PROJECTS_DIR, project, `${claudeSessionId}.jsonl`);
      indexKey = indexKey ?? project;
    }
  }

  const hints = transcript ? readTranscriptHints(transcript) : {};

  // 1. /rename custom title (user-set, highest priority).
  if (hints.customTitle) {
    return { title: hints.customTitle, source: "customTitle" };
  }

  // 2. Agent name (also user-set via `/rename` agent path).
  if (hints.agentName) {
    return { title: hints.agentName, source: "agentName" };
  }

  // 3. sessions-index.json `summary`: Claude Code's curated auto-title.
  const idx = indexKey ? loadIndex(projectIndexPath(indexKey)) : new Map<string, IndexEntry>();
  const entry = idx.get(claudeSessionId);
  if (entry?.summary && entry.summary.trim().length > 0) {
    return { title: entry.summary.trim(), source: "summary" };
  }

  // 4. transcript tail `slug`: auto-generated, kebab-case.
  if (hints.slug) {
    return { title: humanise(hints.slug), source: "slug" };
  }

  // 5. firstPrompt from the index entry, shortened.
  if (entry?.firstPrompt && entry.firstPrompt.trim().length > 0) {
    const trimmed = entry.firstPrompt.trim().replace(/\s+/g, " ");
    const short = trimmed.length > 60 ? trimmed.slice(0, 60) + "…" : trimmed;
    return { title: short, source: "firstPrompt" };
  }

  return {};
}

/**
 * Maps a Claude Code PID (the key we store for harness-spawned sessions, e.g.
 * "claude-41186") to its sessionId by reading ~/.claude/sessions/<pid>.json.
 */
export function pidToSessionId(claudePid: number): { sessionId?: string; cwd?: string } {
  const path = join(homedir(), ".claude", "sessions", `${claudePid}.json`);
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { sessionId?: string; cwd?: string };
    return { sessionId: data.sessionId, cwd: data.cwd };
  } catch {
    return {};
  }
}
