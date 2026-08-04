// Plain-language summaries for the owner view's Claude bubbles.
//
// The owner view shows Claude's running narration, which is full of jargon and
// not understandable at a glance. This module turns one assistant message into a
// single short, plain-language line by shelling out to the local `claude` CLI in
// headless print mode. That reuses the user's existing Claude Code auth, so it
// needs no API key, and runs a cheap model (Haiku).
//
// Isolation: the nested CLI is spawned with an empty SESSIONS_DIR and with the
// Murmur/session env stripped, so every Murmur hook resolves no port and exits
// silently (no pollution of the live session). MCP is forced empty so the nested
// process never loads Murmur again.
//
// Delivery is on demand and cached: the dashboard requests a summary for each
// visible beat, the server returns the cached line or "pending" and a small
// worker pool fills the cache. Nothing is summarized unless someone is looking.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = "haiku";
const SPAWN_TIMEOUT_MS = 25_000;
const MAX_CONCURRENT = 2;
// Cap the input we send. Owner beats are short; this is just a cost guard.
const MAX_INPUT_CHARS = 1400;
// Text at or below this length is already glanceable, so we skip the model and
// use it verbatim (saves a spawn for lines like "Drafting the PR summary").
const SHORT_CIRCUIT_CHARS = 64;
const MAX_OUTPUT_CHARS = 140;
// A failed beat is retried after this long rather than being written off for the
// life of the process. Nested-CLI failures are usually transient and shared
// (an expired credential, a timeout, a rate limit), so caching them forever
// meant one bad minute disabled summaries until the server restarted. The
// override exists so a test can observe the retry without waiting a minute.
const FAILURE_RETRY_MS = Number(process.env["MURMUR_SUMMARY_RETRY_MS"]) || 60_000;

const PROMPT_PREFIX =
  "Rewrite this status update from an AI coding assistant as ONE short, " +
  "plain-language sentence (max 12 words) that a non-programmer can understand " +
  "at a glance. No jargon, no file names, no code identifiers, no markdown, no " +
  "quotes. Output only the sentence.\n\nStatus update:\n";

export type SummaryStatus = "ready" | "pending" | "unavailable";

export interface SummaryResult {
  status: SummaryStatus;
  summary?: string;
  /** Why summaries are unavailable, when the nested CLI said something useful.
   * Surfaced so the owner view can distinguish "not configured" from a fixable
   * failure like an expired login. */
  reason?: string;
}

interface CacheEntry {
  summary?: string;
  failedAt?: number;
}

const cache = new Map<string, CacheEntry>();
const queued = new Set<string>();
const work: Array<{ id: string; text: string }> = [];
let active = 0;

// Resolved once: the claude binary path, and an empty sessions dir that makes
// every Murmur hook in the nested process a no-op. null bin means "unavailable".
let binResolved = false;
let binPath: string | null = null;
let isolatedDir: string | null = null;

function resolveBin(): string | null {
  if (binResolved) return binPath;
  binResolved = true;
  if (process.env["MURMUR_DISABLE_SUMMARIES"]) {
    binPath = null;
    return null;
  }
  const candidates = [
    process.env["MURMUR_CLAUDE_BIN"],
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) {
      binPath = c;
      break;
    }
  }
  // Fall back to PATH resolution by name; spawn surfaces ENOENT if it is absent.
  if (!binPath) binPath = "claude";
  try {
    isolatedDir = mkdtempSync(join(tmpdir(), "murmur-sum-"));
  } catch {
    isolatedDir = tmpdir();
  }
  return binPath;
}

function cleanInput(text: string): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s;
}

function cleanOutput(raw: string): string {
  // Take the first non-empty line and strip wrapping quotes / trailing space.
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  let out = line.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS).trimEnd() + "…";
  return out;
}

// The nested CLI's own words on its last failure. The CLI reports actionable
// problems (an expired OAuth token, an unknown model) on stderr and exits
// non-zero, so dropping stderr turned every one of those into a silent dead
// feature with nothing in the log to act on.
let lastFailure: string | null = null;

/** First line of the nested CLI's last failure, or null if it has not failed. */
export function lastSummaryFailure(): string | null {
  return lastFailure;
}

// Spawn the nested CLI for one message, resolving to the summary or null.
function spawnSummary(bin: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Strip everything a Murmur hook keys off, so the nested process cannot find
    // a port for any session and every hook exits silently.
    delete env["CLAUDE_CODE_SESSION_ID"];
    delete env["CLAUDE_CODE_CHILD_SESSION"];
    delete env["CLAUDE_MURMUR_PORT"];
    delete env["CLAUDE_PROJECT_DIR"];
    for (const k of Object.keys(env)) {
      if (k.startsWith("MURMUR_")) delete env[k];
    }
    env["SESSIONS_DIR"] = isolatedDir ?? tmpdir();
    // Belt-and-suspenders sentinel for any future hook guard.
    env["MURMUR_SUMMARIZER"] = "1";

    const args = [
      "-p",
      PROMPT_PREFIX + text,
      "--model",
      MODEL,
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--session-id",
      randomUUID(),
    ];

    let child;
    try {
      child = spawn(bin, args, {
        env,
        cwd: isolatedDir ?? tmpdir(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(null);
      return;
    }

    let out = "";
    let err = "";
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(null);
    }, SPAWN_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      if (err.length < 500) err += String(chunk);
    });
    child.on("error", (e) => {
      lastFailure = e instanceof Error ? e.message : String(e);
      finish(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        // The CLI prints its diagnosis on either stream depending on the
        // failure, so fall back to stdout before reporting a bare exit code.
        lastFailure =
          firstLine(err) || firstLine(out) || `claude exited with code ${code}`;
        finish(null);
        return;
      }
      const summary = cleanOutput(out);
      finish(summary.length > 0 ? summary : null);
    });
  });
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

function pump(): void {
  const bin = resolveBin();
  if (!bin) return;
  while (active < MAX_CONCURRENT && work.length > 0) {
    const item = work.shift();
    if (!item) break;
    active++;
    void spawnSummary(bin, item.text)
      .then((summary) => {
        cache.set(item.id, summary ? { summary } : { failedAt: Date.now() });
      })
      .catch(() => {
        cache.set(item.id, { failedAt: Date.now() });
      })
      .finally(() => {
        queued.delete(item.id);
        active--;
        pump();
      });
  }
}

/**
 * Request a plain-language summary for one beat. Returns the cached line when
 * ready, "pending" while it is being generated, or "unavailable" when summaries
 * are off, the input is unusable, or the last attempt failed inside the retry
 * cooldown. Idempotent per id: repeated calls for a pending id do not enqueue
 * duplicate work.
 */
export function requestOwnerSummary(id: string, text: string): SummaryResult {
  const bin = resolveBin();
  if (!bin) return { status: "unavailable" };

  const cached = cache.get(id);
  if (cached?.summary) return { status: "ready", summary: cached.summary };
  if (cached?.failedAt !== undefined) {
    // Hold the beat back only until the cooldown lapses, so summaries resume
    // on their own once whatever broke the nested CLI is fixed.
    if (Date.now() - cached.failedAt < FAILURE_RETRY_MS) {
      return { status: "unavailable", reason: lastFailure ?? undefined };
    }
    cache.delete(id);
  }

  const cleaned = cleanInput(text);
  if (!cleaned) return { status: "unavailable" };
  // Already glanceable: use verbatim, no model call.
  if (cleaned.length <= SHORT_CIRCUIT_CHARS) {
    cache.set(id, { summary: cleaned });
    return { status: "ready", summary: cleaned };
  }

  if (!queued.has(id)) {
    queued.add(id);
    work.push({ id, text: cleaned });
    pump();
  }
  return { status: "pending" };
}
