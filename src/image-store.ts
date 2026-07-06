/**
 * On-disk store for images surfaced from transcripts (prompt attachments and
 * tool-result captures). Images arrive as inline base64 in the transcript
 * JSONL; we write each one once, content-addressed by hash, so the broadcast
 * state can carry a tiny `{id,url}` reference instead of a half-megabyte data
 * URL on every SSE frame.
 *
 * The transcript stays the durable source of truth, so these files are a cache:
 * the store is bounded by total bytes and evicts the oldest when over cap. A
 * re-scan would simply rewrite an evicted image.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  statSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join, basename } from "node:path";
import { SESSIONS_PATH } from "./state.js";
import type { ActivityImage } from "./shared-types.js";

const IMAGE_DIR = join(SESSIONS_PATH, "images");

// media_type -> on-disk file extension. Anything not listed is rejected (we
// only surface raster formats a browser <img> renders inline).
const EXT_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MIME_FOR_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// Bound the cache. 200 MB holds a few hundred screenshots; well past it we
// evict the oldest by mtime. Eviction is safe because the transcript can
// always re-produce an image on the next scan.
const MAX_STORE_BYTES = 200 * 1024 * 1024;

// Skip individual blobs above this decoded size. A genuine UI screenshot is
// well under a megabyte; anything larger is almost certainly not worth holding
// and risks a single line dominating the cache.
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

let ensured = false;
function ensureDir(): void {
  if (ensured) return;
  try {
    mkdirSync(IMAGE_DIR, { recursive: true });
  } catch {
    // best-effort: a failed mkdir surfaces as a write failure below
  }
  ensured = true;
}

/**
 * Write a base64 image to the store (if not already present) and return a light
 * reference for the dashboard. Returns null when the media type is unsupported,
 * the data is empty/oversized, or the write fails — the caller drops the image
 * from the activity rather than surfacing a broken reference.
 */
export function saveImage(
  data: string,
  mediaType: string,
  source: ActivityImage["source"],
  alt?: string
): ActivityImage | null {
  if (!data) return null;
  const ext = EXT_FOR_MIME[mediaType.toLowerCase()];
  if (!ext) return null;
  // Estimate decoded size from base64 length (3 bytes per 4 chars) before
  // decoding, so an oversized blob is rejected without allocating it.
  if ((data.length * 3) / 4 > MAX_IMAGE_BYTES) return null;

  // Content hash over the base64 string: same bytes -> same id, so a screenshot
  // captured twice collapses to one file. 32 hex chars is ample to avoid
  // collisions across a session's images.
  const id = createHash("sha256").update(data).digest("hex").slice(0, 32);
  const fileName = `${id}.${ext}`;
  const filePath = join(IMAGE_DIR, fileName);
  const ref: ActivityImage = {
    id,
    url: `/api/image/${fileName}`,
    mediaType,
    source,
    ...(alt ? { alt } : {}),
  };

  if (existsSync(filePath)) return ref;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;

  ensureDir();
  try {
    writeFileSync(filePath, bytes);
  } catch {
    return null;
  }
  evictIfOverCap();
  return ref;
}

/**
 * Resolve a request path segment (e.g. "ab12….png") to an on-disk file and its
 * MIME type, or null if the name is malformed or absent. The name is reduced to
 * its basename and matched against a strict hash.ext pattern, so it can never
 * traverse out of IMAGE_DIR.
 */
export function resolveImageFile(name: string): { path: string; mime: string } | null {
  const safe = basename(name);
  const m = /^([0-9a-f]{8,64})\.(png|jpe?g|gif|webp)$/.exec(safe);
  if (!m) return null;
  const path = join(IMAGE_DIR, safe);
  if (!path.startsWith(IMAGE_DIR)) return null;
  if (!existsSync(path)) return null;
  const mime = MIME_FOR_EXT[m[2]!] ?? "application/octet-stream";
  return { path, mime };
}

// Trim the store to MAX_STORE_BYTES by deleting oldest-mtime files first. Runs
// after a write, so the cache stays bounded without a separate sweep timer.
function evictIfOverCap(): void {
  let entries: { name: string; size: number; mtime: number }[];
  try {
    entries = readdirSync(IMAGE_DIR).map((name) => {
      const st = statSync(join(IMAGE_DIR, name));
      return { name, size: st.size, mtime: st.mtimeMs };
    });
  } catch {
    return;
  }
  let total = 0;
  for (const e of entries) total += e.size;
  if (total <= MAX_STORE_BYTES) return;
  entries.sort((a, b) => a.mtime - b.mtime); // oldest first
  for (const e of entries) {
    if (total <= MAX_STORE_BYTES) break;
    try {
      unlinkSync(join(IMAGE_DIR, e.name));
      total -= e.size;
    } catch {
      // skip files we can't remove
    }
  }
}
