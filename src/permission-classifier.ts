/**
 * Heuristic classifier for permission requests. Looks at the shell command
 * being asked about and returns three labels (kind, scope, risk) plus matching
 * emoji icons. macOS `display alert` does not support colored text in the
 * message body, so emoji do double duty as both icon and color signal:
 *   📖 read · ✏️ write · 🔨 execute · 🗑 delete · 🌐 network · 📡 remote
 *   📂 project · 💻 machine · 🌍 web · 🔗 remote
 *   🟢 low · 🟡 medium · 🟠 high · 🔴 critical
 */

// The Perm* unions + PermClassification live in the browser-safe shared-types
// module (the web dashboard imports the same shapes). Re-export them here so
// every existing server importer keeps resolving them from
// "./permission-classifier.js" unchanged.
export type {
  PermKind,
  PermScope,
  PermRisk,
  PermClassification,
} from "./shared-types.js";
import type {
  PermKind,
  PermScope,
  PermRisk,
  PermClassification,
} from "./shared-types.js";

const KIND_META: Record<PermKind, { label: string; icon: string }> = {
  read: { label: "Read", icon: "📖" },
  write: { label: "Write", icon: "✏️" },
  execute: { label: "Run script", icon: "🔨" },
  delete: { label: "Destructive", icon: "🗑" },
  network: { label: "Network", icon: "🌐" },
  remote: { label: "Remote", icon: "📡" },
};

const SCOPE_META: Record<PermScope, { label: string; icon: string }> = {
  project: { label: "this project", icon: "📂" },
  machine: { label: "this machine", icon: "💻" },
  web: { label: "web", icon: "🌍" },
  remote: { label: "remote machine", icon: "🔗" },
};

const RISK_META: Record<PermRisk, { label: string; icon: string }> = {
  low: { label: "Low", icon: "🟢" },
  medium: { label: "Medium", icon: "🟡" },
  high: { label: "High", icon: "🟠" },
  critical: { label: "Critical", icon: "🔴" },
};

function build(
  kind: PermKind,
  scope: PermScope,
  risk: PermRisk
): PermClassification {
  return {
    kind,
    scope,
    risk,
    kindLabel: KIND_META[kind].label,
    scopeLabel: SCOPE_META[scope].label,
    riskLabel: RISK_META[risk].label,
    kindIcon: KIND_META[kind].icon,
    scopeIcon: SCOPE_META[scope].icon,
    riskIcon: RISK_META[risk].icon,
  };
}

// Heuristic regex set. Ordered: more specific first.
const REMOTE_RE = /\b(ssh|scp|rsync|sftp)\b|\b[\w.-]+@[\w.-]+:/;
const DESTRUCTIVE_RE =
  /\brm\b\s+(-[a-zA-Z]*[rf]|--recursive|--force)|\bsudo\b|\bgit\s+reset\b.*--hard|\bgit\s+push\b.*(--force|-f\b)|--no-verify|\btruncate\b|\bdd\b\s+if=|\bmkfs\b|\bshred\b|\bchmod\b\s+-R\s+\d|>\s*\/(?!tmp\/|dev\/null)/;
// Piping fetched or arbitrary content into a shell interpreter (or eval'ing a
// command substitution) is remote/arbitrary code execution. NETWORK_RE and
// READ_RE below anchor on the FIRST verb of the command, so a chain like
// `curl … | sh` would otherwise be scored on the benign `curl` stage and hide
// the dangerous later stage. Checked before them so the risk is not understated.
const PIPE_EXEC_RE =
  /\|\s*(sudo\s+)?(sh|bash|zsh|fish|dash|ksh|python[0-9.]*|perl|ruby|node)\b|\beval\b|\b(sh|bash|zsh|dash|ksh)\s+-c\b/;
const NETWORK_RE =
  /^\s*(curl|wget|gh\b|aws\b|gcloud\b|kubectl\b|terraform\b|docker\s+(push|pull|login)|npm\s+(install|publish|i\b)|pnpm\s+(install|add|i\b)|yarn\s+(add|install)|pip\s+install|brew\s+(install|upgrade|update)|git\s+(push|fetch|pull|clone))/;
const READ_RE =
  /^\s*(ls|cat|head|tail|less|more|grep|rg|fd|find|wc|stat|file|du|df|pwd|which|whoami|whereis|date|echo|printf|test|true|false|jq|yq|tree|column|sort|uniq|cut|awk|sed\s+-n|git\s+(status|log|diff|show|branch|remote\s+-?v|config\s+--get|rev-parse|describe|blame)|gh\s+(pr\s+view|issue\s+view|repo\s+view|api\s+\w[^\s]*$))\b/;
const PROJECT_WRITE_RE =
  /^\s*(touch|mkdir|cp|mv|ln|tee|git\s+(add|commit|stash|tag|switch|checkout|merge|rebase|cherry-pick|restore)|sed\s+-i|>>?\s*[^/\s])/;

export function classifyPermission(input: {
  tool: string;
  command: string;
  cwd?: string;
}): PermClassification {
  const cmd = input.command.trim();
  // Tools other than Bash don't reach this flow today (PreToolUse gates only
  // Bash), but keep a safe default.
  if (input.tool !== "Bash") {
    return build("execute", "project", "medium");
  }

  if (REMOTE_RE.test(cmd)) {
    return build("remote", "remote", "high");
  }

  if (DESTRUCTIVE_RE.test(cmd)) {
    // Reclassify scope: sudo / outside-cwd writes count as "machine".
    const machineScope = /\bsudo\b|>\s*\/(?!tmp\/|dev\/null)|\bmkfs\b|\bdd\b/.test(
      cmd
    );
    return build("delete", machineScope ? "machine" : "project", "critical");
  }

  if (PIPE_EXEC_RE.test(cmd)) {
    // Running downloaded/arbitrary code on this machine (e.g. `curl … | sh`).
    // Surface it as a critical execute so it is never softened to a routine
    // network fetch by the first-verb match below.
    return build("execute", "machine", "critical");
  }

  if (NETWORK_RE.test(cmd)) {
    const isInstall =
      /\b(install|publish|push|upgrade|add)\b/.test(cmd) && !/--dry-run/.test(cmd);
    return build("network", "web", isInstall ? "high" : "medium");
  }

  if (READ_RE.test(cmd)) {
    return build("read", "project", "low");
  }

  if (PROJECT_WRITE_RE.test(cmd)) {
    return build("write", "project", "medium");
  }

  // Unknown shell command. Treat as moderate-risk script execution.
  return build("execute", "project", "medium");
}

