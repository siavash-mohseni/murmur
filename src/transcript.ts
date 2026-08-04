import { readFileSync, statSync } from "node:fs";
import type { TokenStats } from "./state.js";
import { CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT } from "./model-caps.js";

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Per-TTL split of cache_creation_input_tokens. A 1-hour write bills at
  // twice base input against 1.25x for a 5-minute one, so the split is the
  // difference between a right and a materially low cache-write estimate.
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    usage?: Usage;
  };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  sinceMs: number;
  stats: TokenStats;
}

const cache = new Map<string, CacheEntry>();

export function readTranscriptStats(
  path: string,
  sinceMs: number = 0
): TokenStats | null {
  if (!path) return null;
  let stat;
  try {
    stat = statSync(path);
  } catch {
    // Missing file (ENOENT) or any other stat failure: treat as "no stats".
    return null;
  }
  const cached = cache.get(path);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.sinceMs === sinceMs
  ) {
    // Re-stamp updatedAt on every return so the field reflects when the stat
    // was last observed, not when the file last changed. The cached numbers
    // are unchanged, only the freshness timestamp is refreshed.
    return { ...cached.stats, updatedAt: new Date().toISOString() };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let cacheCreation1h = 0;
  let lastContext = 0;
  let messages = 0;
  let model: string | undefined;

  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    const msg = parsed.message;
    if (!msg || msg.role !== "assistant") continue;
    const u = msg.usage;
    if (!u) continue;
    // Filter messages older than the Murmur's reset baseline so a
    // freshly-reset Murmur starts at zero.
    if (sinceMs > 0 && parsed.timestamp) {
      const ts = Date.parse(parsed.timestamp);
      if (Number.isFinite(ts) && ts < sinceMs) continue;
    }
    messages += 1;
    const turnInput = u.input_tokens ?? 0;
    const turnOutput = u.output_tokens ?? 0;
    const turnCacheRead = u.cache_read_input_tokens ?? 0;
    const turnCacheCreation = u.cache_creation_input_tokens ?? 0;
    cacheCreation1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    input += turnInput;
    output += turnOutput;
    cacheRead += turnCacheRead;
    cacheCreation += turnCacheCreation;
    lastContext = turnInput + turnCacheCreation + turnCacheRead;
    if (msg.model) model = msg.model;
  }

  const baseLimit = model ? CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT : DEFAULT_CONTEXT_LIMIT;
  // If the observed context exceeds the declared limit, bump to the next
  // 100K boundary so the percentage display stays within 0-100.
  const contextLimit =
    lastContext > baseLimit ? Math.ceil(lastContext / 100_000) * 100_000 : baseLimit;

  const stats: TokenStats = {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    cacheCreation1hTokens: cacheCreation1h,
    totalTokens: input + output + cacheRead + cacheCreation,
    lastContextTokens: lastContext,
    contextLimit,
    messageCount: messages,
    model,
    updatedAt: new Date().toISOString(),
  };

  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, sinceMs, stats });
  return stats;
}
