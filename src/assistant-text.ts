import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * Per-path scan cursor for each transcript. `lineCount` is the number of
 * complete (newline-terminated) records already consumed. `byteLen` is the byte
 * offset just past the last newline seen — i.e. the boundary after the last
 * complete record — so the next call reads only the bytes appended since then
 * instead of re-reading the whole file.
 *
 * Anchoring `byteLen` to a line boundary (not raw end-of-file) is what makes the
 * incremental read correct: the suffix always begins at the start of a fresh
 * record, so its first split element is a real new line rather than the empty
 * remainder of a `\n`-terminated file. On first sight of a path we prime the
 * cursor to the current last-line boundary without emitting, so a Murmur restart
 * doesn't re-flood the activity feed with every prior reply.
 *
 * The map is a long-lived module-level cache in a persistent server, so it is
 * bounded by a soft LRU cap (see `rememberCursor`): evicting a stale path only
 * causes it to re-prime on next sight, which is the same no-emit behavior as a
 * never-before-seen path.
 */
interface ScanCursor {
  lineCount: number;
  byteLen: number;
}

// Count the complete (newline-terminated) lines in decoded text and the byte
// length up to and including its final newline. Text with no newline has no
// complete lines and a zero-byte complete span, so the caller leaves its cursor
// where it is until a record is finished. `lastNl` is the char index of that
// final newline (-1 when none), used to slice the completed records out.
function completeSpan(text: string): { lines: number; bytes: number; lastNl: number } {
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { lines: 0, bytes: 0, lastNl: -1 };
  let lines = 0;
  for (let k = 0; k <= lastNl; k++) {
    if (text.charCodeAt(k) === 10) lines++;
  }
  return { lines, bytes: Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"), lastNl };
}

const cursors = new Map<string, ScanCursor>();

// Soft cap on tracked paths. A single machine observes far fewer concurrent
// transcripts than this, so eviction only ever trims paths long gone idle.
const MAX_CURSORS = 2000;

// Insertion-order Maps give us cheap LRU: delete-then-set moves a key to the
// most-recent end, and the oldest key is always the first iterator entry.
function rememberCursor(path: string, cursor: ScanCursor): void {
  if (cursors.has(path)) cursors.delete(path);
  cursors.set(path, cursor);
  while (cursors.size > MAX_CURSORS) {
    const oldest = cursors.keys().next().value;
    if (oldest === undefined) break;
    cursors.delete(oldest);
  }
}

// Whole-file read used only when priming a never-before-seen path, where we
// need the full line count. Returns null on any read error (the original
// readFileSync was wrapped in a try/catch that returned []).
function readWholeText(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const stat = statSync(path);
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// Read only the bytes in [from, to) and decode as UTF-8. `to` is the size from
// the caller's statSync. A `from` beyond EOF (file shrank) yields "". `from` is
// always a line boundary (just past a "\n"), so decoding starts on a codepoint
// boundary; a partial multibyte char can only land at the `to` end, inside the
// still-incomplete trailing record the caller does not emit yet.
function readSuffixText(path: string, from: number, to: number): string | null {
  const len = to - from;
  if (len <= 0) return "";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

interface ImageBlockSource {
  type?: string; // "base64"
  media_type?: string;
  data?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
  // Present on image blocks (the inline base64 the user attached, or a tool
  // returned).
  source?: ImageBlockSource;
  // Present on tool_result blocks: their own list of blocks (text and/or
  // image), which is where a tool's captured image lives.
  content?: ContentBlock[] | string;
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  // Present on `queue-operation` lines: a message the user typed while the
  // model was mid-turn. These never become a `type:"user"` line, so they are
  // the form the UserPromptSubmit hook and a plain user-line scan both miss.
  operation?: string;
  content?: string;
  message?: {
    role?: string;
    content?: ContentBlock[] | string;
  };
}

// Raw image found in the transcript: the inline base64 plus where it came from.
// The orchestration layer (http.ts) writes these to the image store and turns
// them into the light ActivityImage references the dashboard renders.
export interface ScannedImage {
  data: string; // raw base64 (no data: prefix)
  mediaType: string;
  source: "prompt" | "tool";
}

export interface TranscriptTextEntry {
  uuid: string;
  role: "user" | "assistant";
  summary: string;
  // Assistant only: a newline-preserved, code-stripped capture of the whole
  // reply, set only when the reply has structure beyond its first paragraph
  // (sections, bullet lists, numbered decisions). The owner view parses this
  // into semantic groups. `summary` (the first paragraph) stays the single-line
  // form every other surface uses.
  outline?: string;
  // Images carried by this turn: attachments on a user prompt (source "prompt")
  // or a tool's captured image (source "tool"). Absent when the turn had none.
  images?: ScannedImage[];
}

// Cap how many images one turn contributes, so a pathological message can't
// flood the feed or the image store.
const MAX_IMAGES_PER_TURN = 12;

function collectImage(
  out: ScannedImage[],
  block: ContentBlock | undefined,
  source: "prompt" | "tool"
): void {
  if (!block || block.type !== "image" || out.length >= MAX_IMAGES_PER_TURN) return;
  const src = block.source;
  if (!src || typeof src.data !== "string" || !src.data) return;
  const mediaType = typeof src.media_type === "string" ? src.media_type : "";
  if (!mediaType) return;
  out.push({ data: src.data, mediaType, source });
}

/**
 * Extract image blocks from a user message: top-level image blocks (attached to
 * the prompt, source "prompt") and image blocks nested inside tool_result
 * blocks (a tool handed an image back to Claude, source "tool"). Assistant
 * turns never carry image blocks in the transcript, so callers only run this
 * for user turns.
 */
function extractImages(content: ContentBlock[] | string | undefined): ScannedImage[] {
  if (!Array.isArray(content)) return [];
  const out: ScannedImage[] = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === "image") {
      collectImage(out, b, "prompt");
    } else if (b.type === "tool_result" && Array.isArray(b.content)) {
      for (const inner of b.content) collectImage(out, inner, "tool");
    }
  }
  return out;
}

// Slash-command and `!`-bang turns land in the transcript as user messages
// wrapped in these tags. They are tooling noise, not typed prompts, so skip them.
const COMMAND_WRAPPER =
  /^<(command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|local-command-stdout)/;

function extractText(content: ContentBlock[] | string | undefined): string {
  // User prompts can arrive as a bare string.
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  // A user turn carrying any tool_result block is a tool response, not a typed
  // message — drop it wholesale so the feed shows only real prompts/replies.
  if (content.some((b) => b && b.type === "tool_result")) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      parts.push(b.text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * First-paragraph summariser. Strips fenced code blocks and leading markdown
 * headers, then returns everything up to the first blank line. Internal
 * single newlines collapse to spaces so the result flows as one line in the
 * activity feed. Capped at 1000 chars as a safety bound so a paragraph-less
 * wall of text can't blow up the row.
 */
export function firstParagraph(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#+\s*/gm, "")
    .trim();
  if (!cleaned) return "";
  const paragraph = cleaned.split(/\n\s*\n/)[0] ?? cleaned;
  const flowed = paragraph.replace(/\s+/g, " ").trim();
  if (flowed.length > 1000) return flowed.slice(0, 1000) + "…";
  return flowed;
}

// Soft cap on the captured outline. Long enough to hold a multi-section reply
// with several decisions, short enough that a runaway wall of text can't bloat
// the feed payload.
const OUTLINE_MAX = 4000;

/**
 * Newline-preserving capture of a whole assistant reply, for the owner view's
 * semantic milestone cards. Unlike firstParagraph (which collapses to a single
 * line), this keeps the line and bullet structure so the client can parse out
 * sections, bullet lists, and numbered decisions. Fenced code blocks are
 * replaced by a marker line (their content is noise for a non-programmer), and
 * inline code backticks are unwrapped to their text. Returns "" when the reply
 * has no structure beyond one paragraph, so the caller can leave the field
 * unset and fall back to the single-line summary.
 */
export function messageOutline(text: string): string {
  const cleaned = text
    // Fenced code blocks: keep a placeholder so adjacent sections don't merge,
    // but drop the code itself.
    .replace(/```[\s\S]*?```/g, "\n(code)\n")
    // Inline code: unwrap `foo` to foo.
    .replace(/`([^`]+)`/g, "$1")
    // Leading markdown header hashes, keep the heading text.
    .replace(/^#+\s*/gm, "")
    // Collapse runs of 3+ newlines (with optional inner whitespace) to one
    // blank line so section spacing stays uniform.
    .replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, "\n\n")
    .trim();
  if (!cleaned) return "";
  // Only worth capturing when there is more than a single paragraph: a one-line
  // reply is already fully covered by `summary`.
  if (!/\n/.test(cleaned)) return "";
  if (cleaned.length > OUTLINE_MAX) return cleaned.slice(0, OUTLINE_MAX).trimEnd() + "…";
  return cleaned;
}

/**
 * Scan a transcript for user prompts and assistant replies appended since the
 * last call for this path. Returns a (possibly empty) list of summarised
 * entries, each tagged with its role and a stable id drawn from the
 * transcript's own line uuid (or a synthetic "<path>:<line>" key when the uuid
 * is absent), so callers can dedupe.
 *
 * Capturing user prompts here — not just via the UserPromptSubmit hook — is
 * what keeps queued/interrupt messages (which don't reliably fire that hook)
 * from being dropped from the feed. The caller dedupes the hook-recorded copy
 * against this one.
 *
 * First call for a previously-unseen path primes the cursor to the current
 * end-of-file and emits nothing — see the note above `cursors`.
 */
export function readNewTranscriptMessages(path: string): TranscriptTextEntry[] {
  if (!path || !existsSync(path)) return [];
  // statSync first so an unchanged file (the overwhelmingly common poll result)
  // costs one stat and no read. A growing file is read only from the stored
  // byte offset, so cost scales with appended bytes, not total file size.
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const prev = cursors.get(path);
  if (prev === undefined) {
    // First sight: prime the cursor to the last complete-line boundary and emit
    // nothing, so a Murmur restart doesn't re-flood the feed with prior replies.
    // We read the whole file once here to find that boundary and the record
    // count.
    const primed = readWholeText(path);
    if (primed === null) return [];
    const span = completeSpan(primed);
    rememberCursor(path, { lineCount: span.lines, byteLen: span.bytes });
    return [];
  }
  // Size unchanged since the last complete-line boundary means nothing has been
  // appended past the last full record, so there is nothing to emit.
  if (size === prev.byteLen) return [];
  // Read only the bytes appended since that boundary. Because the boundary sits
  // right after a "\n" (or at 0), the suffix begins at the start of a fresh
  // record and its first split element is a genuine new line — never a partial
  // remainder — so no leading element is dropped. A shrunk file yields "".
  const suffix = readSuffixText(path, prev.byteLen, size);
  if (suffix === null) return [];
  const span = completeSpan(suffix);
  // No complete line appended yet (a record is still being written): leave the
  // cursor where it is and wait for its terminating newline.
  if (span.lines === 0) return [];
  const cursor = prev.lineCount;
  const fresh = suffix.slice(0, span.lastNl).split("\n");
  rememberCursor(path, {
    lineCount: cursor + span.lines,
    byteLen: prev.byteLen + span.bytes,
  });
  const out: TranscriptTextEntry[] = [];
  for (let i = 0; i < fresh.length; i++) {
    const line = fresh[i];
    if (!line || !line.trim()) continue;
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    // A queued (typed-while-busy) message: the user's words live in `content`,
    // and it's only ever recorded as this op, so capture it as a user prompt.
    if (parsed.type === "queue-operation") {
      if (parsed.operation !== "enqueue") continue;
      const queued = (parsed.content ?? "").trim();
      if (!queued || COMMAND_WRAPPER.test(queued)) continue;
      const summary = firstParagraph(queued);
      if (!summary) continue;
      out.push({
        uuid: parsed.uuid ?? `${path}:${cursor + i}:q`,
        role: "user",
        summary,
      });
      continue;
    }
    const role =
      parsed.type === "assistant"
        ? "assistant"
        : parsed.type === "user"
          ? "user"
          : null;
    if (!role) continue;
    // Sidechain = subagent turns; meta/compact = harness-injected bookkeeping.
    if (parsed.isSidechain || parsed.isMeta || parsed.isCompactSummary) continue;
    const content = parsed.message?.content;
    const text = extractText(content);
    const baseId = parsed.uuid ?? `${path}:${cursor + i}`;

    if (role === "assistant") {
      // Assistant replies are text-only here (tool_use blocks carry no prose
      // and image blocks never appear on this side).
      if (!text) continue;
      const summary = firstParagraph(text);
      if (!summary) continue;
      const outline = messageOutline(text);
      out.push({ uuid: baseId, role, summary, ...(outline ? { outline } : {}) });
      continue;
    }

    // role === "user": either a typed prompt (optionally with attached images)
    // or a tool_result turn (extractText returns "" for those) that handed an
    // image back to Claude. Both forms can carry images worth surfacing.
    if (text && COMMAND_WRAPPER.test(text)) continue;
    const images = extractImages(content);
    const promptImages = images.filter((im) => im.source === "prompt");
    const toolImages = images.filter((im) => im.source === "tool");

    if (text || promptImages.length > 0) {
      // A typed prompt. First paragraph as before; fall back to a count-only
      // placeholder when the user sent images with no words.
      const para = firstParagraph(text);
      const summary =
        para ||
        (promptImages.length > 0
          ? `(${promptImages.length} image${promptImages.length === 1 ? "" : "s"})`
          : "");
      if (!summary) continue;
      out.push({
        uuid: baseId,
        role: "user",
        summary,
        ...(promptImages.length > 0 ? { images: promptImages } : {}),
      });
      continue;
    }

    if (toolImages.length > 0) {
      // A tool returned image(s) to Claude. Surface it as a Claude-side beat
      // carrying the capture, not as a user prompt. The ":cap" suffix keeps its
      // id distinct from any text reply on the same line.
      out.push({
        uuid: `${baseId}:cap`,
        role: "assistant",
        summary: `Captured ${toolImages.length} image${toolImages.length === 1 ? "" : "s"}`,
        images: toolImages,
      });
    }
    // else: a plain tool_result with no images — emit nothing, as before.
  }
  return out;
}
