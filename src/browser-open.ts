import { exec } from "node:child_process";

/**
 * True when this process was spawned by the Claude Code desktop app. There the
 * dashboard should land in the app's in-app Browser pane, which only the model
 * can drive (mcp__Claude_Browser__*), so server-side launchers must stand down
 * and hand the URL back instead of spawning a system-browser tab next to it.
 */
export function isDesktopApp(): boolean {
  return process.env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop";
}

/**
 * Best-effort platform launcher for a dashboard URL: macOS `open`, Windows
 * `start`, `xdg-open` everywhere else (covers Linux desktops and most BSDs).
 * Failures are swallowed: every caller also returns or prints the URL, so a
 * missing launcher only costs the auto-open convenience, never the feature.
 */
export function openInBrowser(url: string): void {
  const quoted = JSON.stringify(url);
  const cmd =
    process.platform === "darwin"
      ? `open ${quoted}`
      : process.platform === "win32"
        ? `start "" ${quoted}`
        : `xdg-open ${quoted}`;
  exec(cmd, () => {
    // best-effort, ignore failure
  });
}
