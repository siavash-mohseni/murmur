// Routine notifications: a global, durable feed that lives OUTSIDE any single
// session. Unlike per-session activity, these are written by external jobs (cron
// routines via the notify helper or the POST /api/notify endpoint) and are shown
// in every dashboard pane regardless of which session opened it. The store reads
// this file at snapshot time (the same live-only injection pattern as
// readDailyActivity), so a notification posted while no pane is open is still
// there the next time one is. One shared file under STATE_DIR, never per-session.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Notification } from "./shared-types.js";

const STATE_DIR = join(homedir(), ".claude", "state", "murmur");
export const NOTIFICATIONS_FILE = join(STATE_DIR, "notifications.json");
const MAX_NOTIFICATIONS = 200;

export interface NotificationInput {
  title: string;
  body: string;
  link?: string;
  source?: string;
}

// The dashboard renders a notification `link` as an anchor href and the service
// worker feeds it to openWindow, so only http(s) is safe: a `javascript:` (or
// `data:`/`file:` etc.) scheme would execute in the dashboard origin on click.
// Vet the scheme with the URL parser — not a substring check — so obfuscations
// (leading whitespace, mixed case, embedded control chars) can't slip past. A
// non-absolute or non-http(s) value is dropped. This is the single ingest choke
// point (handleNotify and the notify helper both land here), so the unsafe
// value never reaches disk or a live snapshot.
function safeLink(link: string | undefined): string | undefined {
  if (!link) return undefined;
  const raw = String(link).trim();
  if (!raw) return undefined;
  let protocol: string;
  try {
    protocol = new URL(raw).protocol;
  } catch {
    return undefined;
  }
  return protocol === "http:" || protocol === "https:" ? raw : undefined;
}

// Read cache for the hot path: snapshot() calls readNotifications() on every
// broadcast (i.e. every mirrored tool/hook activity), so an unchanged file must
// not be re-read and re-parsed each time. Keyed by (mtimeMs, size) like
// readDailyActivity's cache; other processes writing the shared file bump those,
// so cross-process writes are still picked up.
let cachedMtimeMs = -1;
let cachedSize = -1;
let cachedList: Notification[] = [];

// Uncached read straight from disk, returning fresh (independent) objects. The
// mutators use this so their in-place edits never alias the read cache — if a
// write then fails, the cache still reflects the last good on-disk state.
function readFromDisk(): Notification[] {
  try {
    if (!existsSync(NOTIFICATIONS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(NOTIFICATIONS_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as Notification[]) : [];
  } catch {
    return [];
  }
}

function writeNotifications(list: Notification[]): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    // dir may already exist
  }
  const tmp = `${NOTIFICATIONS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(list));
  renameSync(tmp, NOTIFICATIONS_FILE);
  // Refresh the read cache from what we just wrote so the next readNotifications
  // is a stat-only hit. On any stat failure, invalidate so the next read
  // re-parses from disk rather than serving a stale cache.
  try {
    const s = statSync(NOTIFICATIONS_FILE);
    cachedMtimeMs = s.mtimeMs;
    cachedSize = s.size;
    cachedList = list;
  } catch {
    cachedMtimeMs = -1;
    cachedSize = -1;
  }
}

export function readNotifications(): Notification[] {
  let mtimeMs: number;
  let size: number;
  try {
    const s = statSync(NOTIFICATIONS_FILE);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    // Missing file or stat failure: nothing to read.
    cachedMtimeMs = -1;
    cachedSize = -1;
    cachedList = [];
    return cachedList;
  }
  if (mtimeMs === cachedMtimeMs && size === cachedSize) return cachedList;
  try {
    const parsed = JSON.parse(readFileSync(NOTIFICATIONS_FILE, "utf8"));
    cachedList = Array.isArray(parsed) ? (parsed as Notification[]) : [];
    cachedMtimeMs = mtimeMs;
    cachedSize = size;
  } catch {
    // Parse failure: keep the previous cache instead of flapping to empty.
    return cachedList;
  }
  return cachedList;
}

export function appendNotification(input: NotificationInput): Notification {
  const n: Notification = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    title: String(input.title),
    body: String(input.body),
    link: safeLink(input.link),
    source: input.source ? String(input.source) : undefined,
    read: false,
  };
  const list = readFromDisk();
  list.push(n);
  // Bounded ring: drop oldest once the cap is reached.
  while (list.length > MAX_NOTIFICATIONS) list.shift();
  writeNotifications(list);
  return n;
}

export function setNotificationRead(id: string, read: boolean): boolean {
  const list = readFromDisk();
  const n = list.find((x) => x.id === id);
  if (!n) return false;
  n.read = read;
  writeNotifications(list);
  return true;
}

export function dismissNotification(id: string): boolean {
  const list = readFromDisk();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeNotifications(list);
  return true;
}
