#!/usr/bin/env bun
// murmur notify helper. Posts a routine notification to Murmur from outside a
// Claude session (e.g. a cron routine). Tries every live Murmur server first so
// an open pane updates live; if none is running, writes the global feed file
// directly so it shows the next time a pane opens.
//
//   bun scripts/notify.ts --title "..." --body "..." [--link URL] [--source name]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendNotification } from "../src/notifications.ts";

const SESSIONS_DIR = join(homedir(), ".claude", "state", "murmur", "sessions");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const title = arg("title");
const body = arg("body");
const link = arg("link");
const source = arg("source");

if (!title || !body) {
  console.error('usage: notify.ts --title "..." --body "..." [--link URL] [--source name]');
  process.exit(1);
}

function livePorts(): number[] {
  let files: string[] = [];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".port"));
  } catch {
    return [];
  }
  const ports: number[] = [];
  for (const f of files) {
    try {
      const p = Number(readFileSync(join(SESSIONS_DIR, f), "utf8").trim());
      if (Number.isInteger(p) && p > 0) ports.push(p);
    } catch {
      // skip unreadable port file
    }
  }
  return [...new Set(ports)];
}

async function postTo(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body, link, source }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let delivered = false;
for (const port of livePorts()) {
  if (await postTo(port)) {
    delivered = true;
    console.log(`notified live Murmur on :${port}`);
    break;
  }
}

if (!delivered) {
  const n = appendNotification({ title, body, link, source });
  console.log(`queued to notifications feed (no live pane): ${n.id}`);
}
