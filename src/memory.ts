import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cwdToSlug } from "./titles.js";

export interface MemoryEntry {
  name: string;
  description: string;
  type?: string;
  filePath: string;
  modifiedAt: string;
  originSessionId?: string;
  thisSession: boolean;
}

export function memoryDirFor(cwd: string): string {
  // Claude Code's per-project memory lives at:
  //   ~/.claude/projects/<slug>/memory/
  // where slug is the absolute cwd with every "/" and "." replaced by "-".
  // Example: "/Users/jane/dev/acme-app"
  //          becomes "-Users-jane-dev-acme-app".
  const slug = cwdToSlug(cwd);
  return join(homedir(), ".claude", "projects", slug, "memory");
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  originSessionId?: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---")) return {};
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = raw.slice(3, end);
  const out: ParsedFrontmatter = {};
  let inMetadata = false;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const indented = /^\s+/.test(line);
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valueRaw = (m[2] ?? "").trim();
    const value = valueRaw.replace(/^["'](.*)["']$/, "$1");
    if (!indented && key === "metadata") {
      inMetadata = true;
      continue;
    }
    if (!indented) inMetadata = false;
    // name/description are read only as top-level keys. type/originSessionId
    // are accepted either as top-level keys or indented under a `metadata:`
    // block (inMetadata).
    const underMetadata = inMetadata || !indented;
    if (!indented && key === "name") out.name = value;
    else if (!indented && key === "description") out.description = value;
    else if (underMetadata && key === "type") out.type = value;
    else if (underMetadata && key === "originSessionId") out.originSessionId = value;
  }
  return out;
}

export function scanMemoryDir(
  dir: string,
  currentSessionId: string | undefined,
  sessionStartMs: number
): MemoryEntry[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const collected: { mtimeMs: number; entry: MemoryEntry }[] = [];
  for (const fname of entries) {
    if (!fname.endsWith(".md")) continue;
    if (fname === "MEMORY.md") continue;
    const filePath = join(dir, fname);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    const modifiedAt = new Date(stat.mtimeMs).toISOString();
    const sessionMatch =
      !!currentSessionId &&
      !!fm.originSessionId &&
      fm.originSessionId === currentSessionId;
    const fallbackMatch =
      !fm.originSessionId && stat.mtimeMs >= sessionStartMs;
    collected.push({
      mtimeMs: stat.mtimeMs,
      entry: {
        name: fm.name ?? fname.replace(/\.md$/, ""),
        description: fm.description ?? "",
        type: fm.type,
        filePath,
        modifiedAt,
        originSessionId: fm.originSessionId,
        thisSession: sessionMatch || fallbackMatch,
      },
    });
  }
  // Sort newest first by numeric mtime (proper 0 for ties), then drop the key.
  collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return collected.map((c) => c.entry);
}
