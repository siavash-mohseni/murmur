// install-shared.ts: the single source of truth for everything setup writes
// into ~/.claude and uninstall must reverse. Both scripts import from here so
// the artifact list can never drift between install and removal.

import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const CLAUDE = join(HOME, ".claude");
export const HOOKS_DST = join(CLAUDE, "hooks");
export const SKILLS_DST = join(CLAUDE, "skills");
export const SETTINGS = join(CLAUDE, "settings.json");
export const CLAUDE_MD = join(CLAUDE, "CLAUDE.md");
export const STATE_DIR = join(CLAUDE, "state", "murmur");

// Managed CLAUDE.md block markers.
export const BEGIN_MARKER = "<!-- BEGIN MURMUR (managed by murmur setup) -->";
export const END_MARKER = "<!-- END MURMUR -->";

// The single Node hook entry and its per-event subcommands.
export const HOOK_FILE = "murmur-hook.mjs";
export const HOOK_CMD = (sub: string): string => `node ~/.claude/hooks/${HOOK_FILE} ${sub}`;
export const HOOK_SUBCOMMANDS = ["mirror", "permission", "question", "user-prompt", "precompact", "stop"];

// The six legacy bash hooks (plus their lib helpers) that the Node hook
// replaced. Setup removes them on upgrade; uninstall removes them too so a
// stale pre-rewrite install still cleans up fully.
export const LEGACY_HOOKS = [
  "murmur-mirror.sh",
  "murmur-permission.sh",
  "murmur-question.sh",
  "murmur-user-prompt.sh",
  "murmur-precompact.sh",
  "murmur-stop.sh",
];
export const LEGACY_LIB = ["resolve-port.sh", "find-claude-pid.sh", "murmur-notify-hook.sh"];
export const LEGACY_HOOK_CMDS = LEGACY_HOOKS.map((h) => `bash ~/.claude/hooks/${h}`);

export const SKILL_NAMES = ["murmur", "progress-dashboard"];

// settings.json hook-registration shape.
export interface HookCmd {
  type: string;
  command: string;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}
export interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

// Strip every registration whose command matches `predicate` from every event,
// dropping groups (and event keys) that end up empty. Shared by setup's
// REMOVALS migration and uninstall's full sweep.
export const stripHookCommands = (settings: Settings, predicate: (command: string) => boolean): number => {
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!Array.isArray(g.hooks)) continue;
      const before = g.hooks.length;
      g.hooks = g.hooks.filter((h) => !predicate(h.command));
      removed += before - g.hooks.length;
    }
    settings.hooks[event] = groups.filter((g) => Array.isArray(g.hooks) && g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  return removed;
};
