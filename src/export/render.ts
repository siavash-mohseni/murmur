// Server-side session rendering: the same documents the dashboard's Share
// buttons build, produced from the persisted state file so any session (live
// or past) can be exported by the session server, the hub, or the CLI, with
// transcript images inlined as data URIs. Import-safe for all three callers:
// depends on paths.ts and discovery.ts only, never state.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../paths.js";
import { titleFor } from "../discovery.js";
import type { ActivityImage, DashboardState, SessionSummary } from "../shared-types.js";
import type { ShareContext } from "./context.js";
import { buildSummaryHtml } from "./summary-html.js";
import { buildExportHtml } from "./export-html.js";

export type ExportKind = "summary" | "data";

const KEY_RE = /^[A-Za-z0-9_-]+$/;
// Image files are content-addressed hashes written by image-store.ts. The
// name pattern doubles as the traversal guard when we read them back here.
const IMAGE_FILE_RE = /^[A-Fa-f0-9]{16,64}\.(png|jpe?g|gif|webp)$/;
const MIME_FOR_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export function loadPersistedState(key: string): DashboardState | null {
  if (!KEY_RE.test(key)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(join(SESSIONS_DIR, `${key}.json`), "utf8")
    ) as DashboardState;
    return parsed && Array.isArray(parsed.activities) ? parsed : null;
  } catch {
    return null;
  }
}

/** Resolver that inlines images from the on-disk image store as data URIs,
 * making the rendered document fully self-contained. Missing or evicted
 * files resolve to null and the image is skipped. */
export function diskImageResolver(): (img: ActivityImage) => string | null {
  return (img) => {
    const name = (img.url ?? "").split("/").pop() ?? "";
    if (!IMAGE_FILE_RE.test(name)) return null;
    const ext = name.split(".").pop()!.toLowerCase();
    try {
      const bytes = readFileSync(join(SESSIONS_DIR, "images", name));
      return `data:${MIME_FOR_EXT[ext]};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  };
}

/** Render one state object (already in hand, e.g. a live snapshot). */
export function renderStateHtml(
  state: DashboardState,
  key: string,
  kind: ExportKind
): string {
  const summary: SessionSummary = {
    key,
    port: state.port ?? 0,
    url: "",
    current: true,
    alive: false,
    branch: state.sessionInfo?.branch,
    cwd: state.sessionInfo?.cwd,
    cwdBasename: state.sessionInfo?.cwdBasename,
    startedAt: state.startedAt,
    claudeSessionId: state.sessionInfo?.claudeSessionId,
    title: titleFor(key, {
      claudeSessionId: state.sessionInfo?.claudeSessionId,
      cwd: state.sessionInfo?.cwd,
    }),
  };
  const ctx: ShareContext = {
    state,
    sessions: [summary],
    resolveImage: diskImageResolver(),
  };
  return kind === "data" ? buildExportHtml(ctx) : buildSummaryHtml(ctx);
}

/** Render a session by key from its persisted state file. Null when the key
 * is invalid or no state exists on disk. */
export function renderSessionHtml(key: string, kind: ExportKind): string | null {
  const state = loadPersistedState(key);
  if (!state) return null;
  return renderStateHtml(state, key, kind);
}
