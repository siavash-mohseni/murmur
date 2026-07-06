// Pure semantic-intent helpers shared by the server-side mac-alert,
// the web-side browser notification, and the web Summary HTML renderer.
//
// No Activity / React / DOM dependencies — only string input, string output.
// The Activity-aware dispatcher (eventIntent / toolIntent) lives in
// web/src/lib/event-intent.ts and re-exports the helpers below.

// Per-event semantic intent for the Summary HTML.
//
// Goal: each event in the recap reads as a human intent ("Searched for X",
// "Edited App.tsx", "Built the web app") instead of the raw tool name. The
// raw command/target lives in the expandable body underneath.
//
// Pure heuristic, no model calls. The intent is the headline; the body
// carries everything else (full command, file paths, durations, ok/err).

export interface EventIntent {
  /** Short, human, present-tense headline. Goes in the <summary>. */
  headline: string;
  /** Optional verb category for icon/colour. */
  verb:
    | "read"
    | "write"
    | "search"
    | "exec"
    | "build"
    | "test"
    | "git"
    | "web"
    | "agent"
    | "plan"
    | "task"
    | "permission"
    | "question"
    | "murmur-ask"
    | "hook"
    | "log"
    | "warn"
    | "shell";
}

// How "substantive" each verb is, used to pick the headline command out of a
// multi-stage chain. A diagnostic batch often probes/inspects (read/search/
// shell) before doing the real thing (build/test/git/web/exec/write), so the
// highest-weight stage is the one worth surfacing. Verbs that bashIntent never
// emits are absent and score 0 via the `?? 0` lookup.
const STAGE_WEIGHT: Record<string, number> = {
  build: 6,
  test: 6,
  git: 6,
  web: 6,
  write: 5,
  exec: 5,
  search: 3,
  read: 2,
  shell: 1,
};

export const basename = (s: string | undefined): string => {
  if (!s) return "";
  // Strip a leading quote before the slash-strip and a trailing quote after, so
  // a quoted path like `"$HOME/.../foo.sh"` basenames to `foo.sh`, not `foo.sh"`.
  const trimmed = (s.split(/\s+/)[0] ?? s).replace(/^['"]+/, "");
  return trimmed.replace(/^.*\//, "").replace(/['"]+$/, "");
};

export const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
};

export const firstQuoted = (s: string): string | null => {
  // Match a run delimited by matching quotes, allowing the OTHER quote type to
  // appear inside. The old class `[^"']+` halted at the first apostrophe, so
  // `rg "don't crash"` captured only `don`; the backreference keeps the whole
  // `don't crash`.
  const m = s.match(/(["'])([\s\S]+?)\1/);
  return m ? (m[2] ?? null) : null;
};

// Pull a likely-target path or filename from a shell command. Last token that
// looks like a path or filename; falls back to last token of any kind.
export const lastPathArg = (cmd: string): string | null => {
  const tokens = cmd
    .replace(/[;&|]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !t.startsWith("-"));
  // Only consider arguments, never the command word itself (`rm` alone has no
  // path; it should read "Removed file(s)", not "Removed rm").
  const args = tokens.slice(1);
  const dq = (x: string): string => x.replace(/^['"]+|['"]+$/g, "");
  for (let i = args.length - 1; i >= 0; i--) {
    const t = args[i]!;
    if (t.includes("/") || /\.[A-Za-z]{1,8}$/.test(t)) return dq(t);
  }
  const last = args[args.length - 1];
  return last !== undefined ? dq(last) : null;
};

// Split a shell command on the given separators, but only at the top level —
// separators inside single or double quotes are ignored. This keeps inline
// scripts like `python3 -c "a && b"` intact while still breaking a real
// `cd app && npm run build` chain into its stages.
export const splitTopLevel = (cmd: string, seps: string[]): string[] => {
  const parts: string[] = [];
  let buf = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const sep = seps.find((s) => cmd.startsWith(s, i));
    if (sep) {
      parts.push(buf);
      buf = "";
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
};

/**
 * Inspect inline-code commands like `python3 -c "..."`, `node -e "..."`, or
 * heredocs (`python3 << 'EOF' ... EOF`) and derive intent from what the script
 * actually does (read a file, edit lines, regex, print, fetch HTTP, etc.)
 * rather than collapsing every inline runtime call to "Ran Python".
 *
 * Returns null when the command isn't an inline-code form, letting the caller
 * fall back to the generic file-runner / unknown-script branches.
 */
function inlineCodeIntent(
  cmd: string,
  runtimeLabel: string
): EventIntent | null {
  // Pull the script body out of: `<runtime> -c "body"`  or  `<runtime> -e 'body'`
  // or a heredoc:  `<runtime> << 'DELIM' body DELIM`.
  let body = "";
  const flagMatch = cmd.match(/\s-[ce]\s+(['"])([\s\S]*?)\1/);
  if (flagMatch) {
    body = flagMatch[2] ?? "";
  } else {
    const heredoc = cmd.match(/<<-?\s*['"]?(\w+)['"]?\s*([\s\S]*?)(?:\s+\1|$)/);
    if (heredoc) body = heredoc[2] ?? "";
  }
  body = body.trim();
  if (body.length === 0) return null;

  // Extract a quoted file path the script is operating on (Path('...'),
  // open('...'), fs.readFileSync('...'), with open('...') as f).
  const pathHit =
    body.match(/Path\s*\(\s*['"]([^'"]+)['"]\s*\)/) ??
    body.match(/open\s*\(\s*['"]([^'"]+)['"]/) ??
    body.match(/readFileSync\s*\(\s*['"]([^'"]+)['"]/) ??
    body.match(/writeFileSync\s*\(\s*['"]([^'"]+)['"]/) ??
    body.match(/['"]\.{0,2}\/[^'"]+\.[A-Za-z]{1,8}['"]/);
  const file = pathHit ? basename(pathHit[1] ?? pathHit[0] ?? "") : "";
  const withFile = (verb: string): string => (file ? `${verb} ${file}` : verb);

  // Read-then-mutate pattern → "Edited <file> via <runtime>"
  const hasRead = /\b(read_text|readlines|readFileSync|\.read\(\))\b/.test(body) ||
    /\bopen\s*\([^)]*['"]r['"]/.test(body);
  const hasWrite =
    /\b(write_text|writelines|writeFileSync|\.write\s*\()\b/.test(body) ||
    /\bopen\s*\([^)]*['"]w['"]/.test(body);

  if (hasRead && hasWrite) {
    return { headline: withFile("Edited") + ` via ${runtimeLabel}`, verb: "write" };
  }
  if (hasWrite) {
    return { headline: withFile("Wrote") + ` via ${runtimeLabel}`, verb: "write" };
  }
  if (hasRead) {
    return { headline: withFile("Read") + ` via ${runtimeLabel}`, verb: "read" };
  }

  // Regex / search
  if (/\bre\.(sub|search|findall|match|finditer)\b/.test(body) || /\.match\s*\(\s*\//.test(body) || /\.replace\s*\(\s*\//.test(body)) {
    return { headline: file ? `Ran a regex on ${file} via ${runtimeLabel}` : `Ran a regex via ${runtimeLabel}`, verb: "search" };
  }

  // JSON
  if (/\bjson\.(loads?|dumps?)\b/.test(body) || /\bJSON\.(parse|stringify)\b/.test(body)) {
    return { headline: file ? `Processed ${file} JSON via ${runtimeLabel}` : `Processed JSON via ${runtimeLabel}`, verb: "exec" };
  }

  // Network
  if (/\b(fetch|axios|requests\.|urllib\.|http\.get)\b/.test(body)) {
    return { headline: `Fetched the web via ${runtimeLabel}`, verb: "web" };
  }

  // Pure print / log
  if (/^\s*(print\s*\(|console\.log\s*\()/.test(body) && !/\b(import|require|fetch|read|write|open)\b/.test(body)) {
    return { headline: `Printed text via ${runtimeLabel}`, verb: "shell" };
  }

  // Fallback: name the first import or call, so we still say something useful.
  const firstImport = body.match(/^\s*(?:from\s+(\S+)\s+import|import\s+(\S+)|const\s+\S+\s*=\s*require\s*\(\s*['"]([^'"]+)['"])/);
  const importedModule = firstImport ? (firstImport[1] ?? firstImport[2] ?? firstImport[3] ?? "").replace(/[;,]$/, "") : "";
  if (importedModule) {
    return { headline: `Ran ${runtimeLabel} (${importedModule})`, verb: "exec" };
  }
  return { headline: `Ran a ${runtimeLabel} snippet`, verb: "exec" };
}

/**
 * Recognise the project / skill CLIs this user actually runs, so a command
 * reads as its real intent ("Read Jira issue DEMO-123", "Posted a PR comment")
 * instead of `Ran \`secure_curl.sh\``. Matched on the dequoted basename of the
 * command word. Returns null for anything unknown so bashIntent falls through
 * to its generic default. Keep this list aligned with the bundled skills
 * (jira, ado-pr, pr-summary, dart-deslop) and the user's local toolchain.
 */
function projectToolIntent(t: string): EventIntent | null {
  const word = (t.split(/\s+/)[0] ?? "").replace(/^['"]+|['"]+$/g, "");
  const base = word.includes("/") ? basename(word) : word;
  const jiraKey = t.match(/\b([A-Z][A-Z0-9]+-\d+)\b/)?.[1];

  // secure_curl.sh — the Jira/ADO REST wrapper (args after `--` are plain
  // curl). Parse the URL + method and name the service + resource.
  if (base === "secure_curl.sh" || base === "secure_curl") {
    const url = t.match(/https?:\/\/\S+/)?.[0]?.replace(/["'\\]+$/, "") ?? "";
    const method = (t.match(/-X\s+([A-Za-z]+)/)?.[1] ?? "GET").toUpperCase();
    const isWrite = method !== "GET" && method !== "HEAD";
    const host = url ? hostnameOf(url) : "";
    if (/atlassian\.net/.test(host) || /\/rest\/api\//.test(url)) {
      if (jiraKey && /\/comment/.test(url))
        return { headline: isWrite ? `Commented on ${jiraKey}` : `Read ${jiraKey} comments`, verb: isWrite ? "write" : "web" };
      if (jiraKey)
        return { headline: isWrite ? `Updated Jira issue ${jiraKey}` : `Read Jira issue ${jiraKey}`, verb: isWrite ? "write" : "web" };
      return { headline: isWrite ? `Updated the Jira API (${method})` : "Queried the Jira API", verb: isWrite ? "write" : "web" };
    }
    if (/dev\.azure\.com|visualstudio\.com/.test(host))
      return { headline: isWrite ? `Called the Azure DevOps API (${method})` : "Queried the Azure DevOps API", verb: "web" };
    return { headline: host ? `Called ${host} (${method})` : `Made an HTTP request (${method})`, verb: "web" };
  }

  // acli — Atlassian CLI: `acli jira <resource> <verb> [KEY]`.
  if (base === "acli") {
    const parts = t.split(/\s+/).slice(1).filter((p) => !p.startsWith("-"));
    const resource = parts[1] ?? "";
    const verb = parts[2] ?? "";
    if (resource === "auth") return { headline: "Checked Jira auth", verb: "read" };
    if (resource === "workitem" || resource === "issue") {
      if (verb === "view" || verb === "show") return { headline: jiraKey ? `Viewed Jira ${jiraKey}` : "Viewed a Jira work item", verb: "web" };
      if (verb === "comment") return { headline: jiraKey ? `Read ${jiraKey} comments` : "Read Jira comments", verb: "web" };
      if (verb === "create") return { headline: "Created a Jira work item", verb: "write" };
      if (verb === "edit" || verb === "update") return { headline: jiraKey ? `Updated Jira ${jiraKey}` : "Updated a Jira work item", verb: "write" };
      if (verb === "transition") return { headline: jiraKey ? `Transitioned Jira ${jiraKey}` : "Transitioned a Jira work item", verb: "write" };
      return { headline: jiraKey ? `Worked with Jira ${jiraKey}` : "Worked with a Jira work item", verb: "web" };
    }
    return { headline: (parts[0] ?? "") === "jira" ? "Worked with Jira" : "Ran an Atlassian CLI command", verb: "web" };
  }

  // ADO PR helper scripts (the ado-pr skill).
  const ado: Record<string, EventIntent> = {
    "get_pr_info.sh": { headline: "Read PR info", verb: "web" },
    "get_pr_comments.sh": { headline: "Read PR comments", verb: "web" },
    "post_comment.sh": { headline: "Posted a PR comment", verb: "write" },
    "resolve_thread.sh": { headline: "Resolved a PR thread", verb: "write" },
  };
  if (ado[base]) return ado[base]!;

  // very_good — the Very Good Ventures Flutter CLI.
  if (base === "very_good") {
    const sub = t.split(/\s+/)[1] ?? "";
    if (sub === "test") return { headline: "Ran the test suite", verb: "test" };
    if (sub === "create") return { headline: "Created a project from a template", verb: "build" };
    if (sub === "packages") return { headline: "Managed packages", verb: "build" };
    return { headline: "Ran a Very Good command", verb: "exec" };
  }

  // keeper — secrets manager.
  if (base === "keeper") {
    const sub = t.split(/\s+/)[1] ?? "";
    if (sub === "whoami" || sub === "status" || sub === "login") return { headline: "Checked Keeper auth", verb: "read" };
    return { headline: "Managed secrets with Keeper", verb: "exec" };
  }

  // pr-summary skill context collector.
  if (base === "collect-context.sh") return { headline: "Collected PR context", verb: "read" };
  // lefthook — git hook runner.
  if (base === "lefthook") return { headline: "Ran git hooks", verb: "test" };
  // dart-deslop skill.
  if (base === "deslop.sh") return { headline: "Ran dart-deslop", verb: "write" };

  return null;
}

// ---- bashIntent regex bank (hoisted to module scope, compiled once) --------
// bashIntent and its matcher table run on every Bash tool event and recurse on
// chains / pipes / wrappers, so the patterns live here as module-level consts
// rather than being recompiled on each call. None carry the global flag, so
// they hold no lastIndex state and are safe to share across calls.

// Output redirected INTO a file is a write. The lookbehind skips fd redirects
// (`2>`, `1>`) AND the `=`/`-` of JS/arrow operators (`c=>d`, `a->b`) so an
// arrow never reads as "Wrote <token>". REDIR matches the producer's own
// segment, REDIR_TO_FILE_HEREDOC the `> file << 'EOF'` heredoc-to-file form.
const REDIR = /(?<![0-9&=-])>>?\s*("?)([^\s"'<>|&)]+)\1/;
const REDIR_TO_FILE_HEREDOC = /(?<![0-9&=-])>>?\s*("?)([^\s"'<>|&)]+)\1\s*<<-?\s*['"]?\w+/;
const PRODUCER_RE = /^(?:cat|echo|printf|tee)\b/;

// A matcher takes the preprocessed command string and returns an EventIntent,
// or null to fall through to the next matcher (used by the wrapper branches
// that only recurse when they actually unwrap something).
type BashMatcher = (t: string) => EventIntent | null;

// The per-command matcher ladder, in priority order. First test that matches
// and yields a non-null result wins. Order is significant and preserved
// verbatim from the original if-ladder: earlier, more-specific commands shadow
// later, broader ones. Constant matchers (no argument parsing) return a fixed
// EventIntent, the rest parse their arguments.
const BASH_MATCHERS: Array<[RegExp, BashMatcher]> = [
  // ---- build / test / lint ----
  [/^(bun|npm|pnpm|yarn)\s+(install|i|add|ci)\b/, () => ({ headline: "Installed dependencies", verb: "build" })],
  [/^(bun|npm|pnpm|yarn)\s+(run\s+)?build\b/, () => ({ headline: "Built the project", verb: "build" })],
  [/^(bun|npm|pnpm|yarn)\s+(run\s+)?dev\b/, () => ({ headline: "Started the dev server", verb: "build" })],
  [/^(bun|npm|pnpm|yarn)\s+(run\s+)?(test|jest|vitest)\b/, () => ({ headline: "Ran the test suite", verb: "test" })],
  [/^(bun|npm|pnpm|yarn)\s+(run\s+)?(lint|typecheck|check|tsc)\b/, () => ({ headline: "Type-checked / linted the project", verb: "test" })],
  [/^tsc\b/, () => ({ headline: "Ran the TypeScript compiler", verb: "test" })],

  // ---- azure cli (az) ----
  [/^az\b/, (t) => {
    const parts = t.replace(/^az\s+/, "").split(/\s+/);
    const group = parts[0] ?? "";
    const action = parts[1] ?? "";
    if (group === "--version" || group === "version")
      return { headline: "Checked the az version", verb: "read" };
    if (group === "login" || group === "logout" || group === "account")
      return { headline: "Managed Azure CLI auth", verb: "web" };
    if (group === "extension") {
      const name = t.match(/--name\s+["']?([^"'\s]+)/)?.[1];
      return {
        headline: name ? `Inspected the ${name} extension` : "Inspected an az extension",
        verb: "read",
      };
    }
    if (group === "pipelines") {
      const map: Record<string, string> = {
        list: "Listed Azure DevOps pipelines",
        show: "Inspected an Azure DevOps pipeline",
        run: "Triggered an Azure DevOps pipeline",
        create: "Created an Azure DevOps pipeline",
      };
      return { headline: map[action] ?? "Worked with Azure DevOps pipelines", verb: action === "run" ? "exec" : "web" };
    }
    if (group === "repos") return { headline: "Worked with Azure DevOps repos", verb: "web" };
    if (group === "boards") return { headline: "Worked with Azure DevOps boards", verb: "web" };
    if (group === "devops") return { headline: "Ran an Azure DevOps command", verb: "web" };
    return { headline: group ? `Ran az ${group}` : "Ran az", verb: "exec" };
  }],

  // ---- git ----
  [/^git(?:\s|$)/, (t) => {
    // Skip leading global options before the subcommand so `git -c k=v merge`,
    // `git --no-pager show`, and `git -C <dir> log` read as their verb, not as
    // a bare `Ran \`git\``. The value-taking options consume the next token too.
    const tokens = t.split(/\s+/).slice(1);
    const takesValue = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
    let i = 0;
    while (i < tokens.length && tokens[i]!.startsWith("-")) {
      const tok = tokens[i]!;
      i++;
      if (takesValue.has(tok) && !tok.includes("=")) i++;
    }
    const gitVerb = tokens[i];
    const map: Record<string, string> = {
      status: "Checked git status",
      log: "Read git history",
      diff: "Read the git diff",
      add: "Staged changes",
      commit: "Created a git commit",
      push: "Pushed to the remote",
      pull: "Pulled from the remote",
      fetch: "Fetched from the remote",
      checkout: "Switched git refs",
      switch: "Switched git branches",
      branch: "Inspected git branches",
      stash: "Stashed working changes",
      merge: "Merged branches",
      rebase: "Rebased the branch",
      show: "Inspected a git object",
      restore: "Restored files from git",
      reset: "Reset the index",
      blame: "Read git blame",
      tag: "Worked with git tags",
      remote: "Inspected git remotes",
      worktree: "Used git worktrees",
    };
    if (!gitVerb) return { headline: "Used git", verb: "git" };
    return { headline: map[gitVerb] ?? `Ran git ${gitVerb}`, verb: "git" };
  }],

  // ---- search ----
  [/^(grep|rg|ag|ack)\b/, (t) => {
    const q = firstQuoted(t);
    return q
      ? { headline: `Searched for "${q.slice(0, 40)}"`, verb: "search" }
      : { headline: "Searched the codebase", verb: "search" };
  }],
  [/^find\b/, (t) => {
    const name = t.match(/-name\s+["']?([^"'\s]+)/)?.[1];
    return name
      ? { headline: `Searched for files matching ${name}`, verb: "search" }
      : { headline: "Searched the filesystem", verb: "search" };
  }],
  [/^which\b/, (t) => {
    const what = t.split(/\s+/)[1];
    return { headline: what ? `Located the ${what} binary` : "Located a binary", verb: "search" };
  }],

  // ---- navigation ----
  [/^cd\b/, (t) => {
    const dir = t.split(/\s+/)[1];
    return dir && dir !== "-" && dir !== "~"
      ? { headline: `Switched to the ${basename(dir)} directory`, verb: "shell" }
      : { headline: "Changed directory", verb: "shell" };
  }],
  [/^(pwd|dirs)\b/, () => ({ headline: "Checked the current directory", verb: "read" })],
  [/^(pushd|popd)\b/, () => ({ headline: "Changed directory", verb: "shell" })],

  // ---- listing / inspection ----
  [/^ls\b/, (t) => {
    const target = lastPathArg(t);
    return target && target !== "ls"
      ? { headline: `Listed ${target}`, verb: "read" }
      : { headline: "Listed the current directory", verb: "read" };
  }],
  [/^(cat|head|tail|less|more)\b/, (t) => {
    const f = lastPathArg(t);
    return f ? { headline: `Read ${basename(f)}`, verb: "read" } : { headline: "Read a file", verb: "read" };
  }],
  [/^wc\b/, (t) => {
    const f = lastPathArg(t);
    return f ? { headline: `Counted lines in ${basename(f)}`, verb: "read" } : { headline: "Counted lines", verb: "read" };
  }],
  [/^stat\b/, () => ({ headline: "Inspected file metadata", verb: "read" })],
  [/^file\b/, () => ({ headline: "Inspected file metadata", verb: "read" })],
  [/^du\b/, () => ({ headline: "Checked disk usage", verb: "read" })],
  [/^df\b/, () => ({ headline: "Checked free disk space", verb: "read" })],

  // ---- data / text processing ----
  [/^jq\b/, (t) => {
    const f = lastPathArg(t);
    return f && /\.json$/i.test(f)
      ? { headline: `Read data from ${basename(f)}`, verb: "read" }
      : { headline: "Processed JSON data", verb: "exec" };
  }],
  [/^sed\b/, (t) => {
    // `sed -i` rewrites a file in place; otherwise it just transforms a stream.
    if (/\s-i\b/.test(t)) {
      const f = lastPathArg(t);
      return { headline: f ? `Edited ${basename(f)}` : "Edited a file", verb: "write" };
    }
    return { headline: "Transformed text", verb: "search" };
  }],
  [/^awk\b/, () => ({ headline: "Processed text", verb: "search" })],
  [/^sort\b/, () => ({ headline: "Sorted lines", verb: "shell" })],
  [/^uniq\b/, () => ({ headline: "Filtered duplicate lines", verb: "shell" })],
  [/^cut\b/, () => ({ headline: "Extracted columns", verb: "shell" })],
  [/^(tr|fold|fmt|column)\b/, () => ({ headline: "Transformed text", verb: "shell" })],
  [/^diff\b/, () => ({ headline: "Compared files", verb: "read" })],
  [/^cmp\b/, () => ({ headline: "Compared files", verb: "read" })],
  [/^xargs\b/, () => ({ headline: "Ran a command over a list", verb: "exec" })],

  // ---- archives ----
  [/^tar\b/, (t) => {
    if (/\s-?[a-z]*x/.test(t)) return { headline: "Extracted an archive", verb: "write" };
    if (/\s-?[a-z]*c/.test(t)) return { headline: "Created an archive", verb: "write" };
    return { headline: "Worked with a tar archive", verb: "shell" };
  }],
  [/^unzip\b/, () => ({ headline: "Extracted an archive", verb: "write" })],
  [/^gunzip\b/, () => ({ headline: "Extracted an archive", verb: "write" })],
  [/^zip\b/, () => ({ headline: "Created an archive", verb: "write" })],
  [/^gzip\b/, () => ({ headline: "Created an archive", verb: "write" })],

  // ---- file mutation ----
  [/^mkdir\b/, (t) => {
    const d = lastPathArg(t);
    return { headline: d ? `Created directory ${basename(d)}` : "Created a directory", verb: "write" };
  }],
  [/^touch\b/, (t) => {
    const f = lastPathArg(t);
    return { headline: f ? `Touched ${basename(f)}` : "Touched a file", verb: "write" };
  }],
  [/^rm\b/, (t) => {
    const f = lastPathArg(t);
    return { headline: f ? `Removed ${basename(f)}` : "Removed file(s)", verb: "write" };
  }],
  [/^mv\b/, () => ({ headline: "Moved file(s)", verb: "write" })],
  [/^cp\b/, () => ({ headline: "Copied file(s)", verb: "write" })],
  [/^chmod\b/, () => ({ headline: "Changed file permissions", verb: "write" })],
  [/^chown\b/, () => ({ headline: "Changed file ownership", verb: "write" })],
  [/^ln\b/, () => ({ headline: "Created a link", verb: "write" })],

  // ---- network ----
  [/^curl\b/, (t) => {
    const url = t.match(/https?:\/\/\S+/)?.[0];
    return url
      ? { headline: `Fetched ${hostnameOf(url)}`, verb: "web" }
      : { headline: "Made an HTTP request", verb: "web" };
  }],
  [/^wget\b/, () => ({ headline: "Downloaded a file", verb: "web" })],
  [/^ssh\b/, () => ({ headline: "Opened an SSH session", verb: "web" })],
  [/^scp\b/, () => ({ headline: "Copied a file over SSH", verb: "web" })],

  // ---- scripting / runtime ----
  [/^python3?\b/, (t) => {
    const inline = inlineCodeIntent(t, "Python");
    if (inline) return inline;
    const py = lastPathArg(t);
    return { headline: py?.endsWith(".py") ? `Ran ${basename(py)}` : "Ran Python", verb: "exec" };
  }],
  [/^node\b/, (t) => {
    const inline = inlineCodeIntent(t, "Node");
    if (inline) return inline;
    const js = lastPathArg(t);
    return { headline: js ? `Ran ${basename(js)} with node` : "Ran a Node script", verb: "exec" };
  }],
  [/^bun\b/, (t) => {
    const inline = inlineCodeIntent(t, "Bun");
    if (inline) return inline;
    const after = t.split(/\s+/).slice(1).join(" ");
    // basename keeps a path arg short (`.ai/scripts/sync.ts` → `sync.ts`) and
    // is a no-op on a plain script name (`build` stays `build`).
    if (after.startsWith("run ")) return { headline: `Ran bun ${basename(after.slice(4))}`, verb: "exec" };
    if (after.endsWith(".ts") || after.endsWith(".js")) return { headline: `Ran ${basename(after)} with bun`, verb: "exec" };
    return { headline: `Ran bun ${after.split(/\s+/)[0] ?? ""}`.trim(), verb: "exec" };
  }],
  [/^deno\b/, () => ({ headline: "Ran a Deno script", verb: "exec" })],

  // Shell wrappers: `bash -c "X"` / `sh -c 'X'` run X; `bash script.sh …` runs a
  // script. Describe the wrapped work, not the wrapper word. (ssh/scp matched
  // above; the optional `/bin/`-style path prefix lets `/bin/bash -c …` through.)
  // Returns null (falls through) when there is nothing to unwrap.
  [/^(?:\/[\w./-]*\/)?(?:ba|z|fi)?sh\b/, (t) => {
    const inlineC = t.match(/\s-c\s+(['"])([\s\S]*?)\1/);
    if (inlineC?.[2]) return bashIntent(inlineC[2]);
    const inner = t.replace(/^\S+\s+/, "").replace(/^(?:-\S+\s+)*/, "").trim();
    if (inner && inner !== t) return bashIntent(inner);
    return null;
  }],
  // Package-runner wrappers: `npx tsc`, `bunx vitest`, `pnpm dlx …` → describe
  // the command they run (`bunx tsc --noEmit` → "Ran the TypeScript compiler").
  [/^(?:npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx)\b/, (t) => {
    const inner = t
      .replace(/^(?:npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx)\s+/, "")
      .replace(/^(?:(?:-\S+|--package=\S+|-p\s+\S+)\s+)*/, "")
      .trim();
    if (inner && inner !== t) return bashIntent(inner);
    return null;
  }],

  // ---- compilers / build tools / package managers ----
  [/^make\b/, (t) => {
    const target = t.split(/\s+/).find((w, i) => i > 0 && !w.startsWith("-"));
    return { headline: target ? `Built the ${target} target` : "Ran the build", verb: "build" };
  }],
  [/^cmake\b/, () => ({ headline: "Configured the build", verb: "build" })],
  [/^flutter\b/, (t) => {
    const sub = t.split(/\s+/)[1] ?? "";
    if (sub === "analyze") return { headline: "Analyzed the Flutter project", verb: "test" };
    if (sub === "test") return { headline: "Ran the test suite", verb: "test" };
    if (sub === "build") return { headline: "Built the app", verb: "build" };
    if (sub === "run") return { headline: "Ran the app", verb: "exec" };
    if (sub === "pub") return { headline: "Managed Flutter packages", verb: "build" };
    if (sub === "format") return { headline: "Formatted the code", verb: "write" };
    if (sub === "doctor") return { headline: "Checked the Flutter setup", verb: "read" };
    if (sub === "clean") return { headline: "Cleaned the build", verb: "build" };
    if (sub === "gen-l10n") return { headline: "Generated localizations", verb: "build" };
    if (sub === "gen") return { headline: "Ran a Flutter code generator", verb: "build" };
    if (sub === "widget-preview") return { headline: "Ran the Flutter widget preview", verb: "exec" };
    if (sub === "--version" || sub === "version") return { headline: "Checked the Flutter version", verb: "read" };
    if (sub === "devices" || sub === "emulators") return { headline: "Listed Flutter devices", verb: "read" };
    if (sub === "config") return { headline: "Configured Flutter", verb: "shell" };
    if (sub === "precache" || sub === "upgrade" || sub === "channel") return { headline: "Managed the Flutter SDK", verb: "build" };
    return { headline: "Ran a Flutter command", verb: "exec" };
  }],
  [/^dart\b/, (t) => {
    const sub = t.split(/\s+/)[1] ?? "";
    if (sub === "analyze") return { headline: "Analyzed the Dart code", verb: "test" };
    if (sub === "test") return { headline: "Ran the test suite", verb: "test" };
    if (sub === "format") return { headline: "Formatted the code", verb: "write" };
    if (sub === "run") return { headline: "Ran a Dart program", verb: "exec" };
    if (sub === "pub") return { headline: "Managed Dart packages", verb: "build" };
    return { headline: "Ran a Dart command", verb: "exec" };
  }],
  [/^(cargo|go|mvn|gradle|\.\/gradlew|dotnet)\b/, (t) => {
    const verb = t.split(/\s+/)[1] ?? "";
    if (/build|compile|install/.test(verb)) return { headline: "Built the project", verb: "build" };
    if (/test|check/.test(verb)) return { headline: "Ran the test suite", verb: "test" };
    if (/run/.test(verb)) return { headline: "Ran the project", verb: "exec" };
    return { headline: "Ran a build command", verb: "build" };
  }],
  [/^pip3?\b|^poetry\b|^pipenv\b/, (t) => {
    return /\binstall\b/.test(t)
      ? { headline: "Installed Python packages", verb: "build" }
      : { headline: "Managed Python packages", verb: "exec" };
  }],
  [/^brew\b/, (t) => {
    return /\binstall\b/.test(t)
      ? { headline: "Installed a Homebrew package", verb: "build" }
      : { headline: "Used Homebrew", verb: "exec" };
  }],

  // ---- containers / infra ----
  [/^docker\b/, (t) => {
    if (/^docker\s+(compose|stack)\b/.test(t)) return { headline: "Ran Docker Compose", verb: "exec" };
    if (/^docker\s+build\b/.test(t)) return { headline: "Built a Docker image", verb: "build" };
    if (/^docker\s+run\b/.test(t)) return { headline: "Ran a Docker container", verb: "exec" };
    if (/^docker\s+(ps|images)\b/.test(t)) return { headline: "Listed Docker resources", verb: "read" };
    return { headline: "Ran a Docker command", verb: "exec" };
  }],
  [/^kubectl\b/, () => ({ headline: "Ran a Kubernetes command", verb: "exec" })],
  [/^(terraform|tofu)\b/, () => ({ headline: "Ran a Terraform command", verb: "exec" })],
  [/^gh\b/, (t) => {
    const sub = t.split(/\s+/)[1] ?? "";
    if (sub === "pr") return { headline: "Worked with a GitHub PR", verb: "git" };
    if (sub === "issue") return { headline: "Worked with a GitHub issue", verb: "git" };
    return { headline: "Used the GitHub CLI", verb: "git" };
  }],

  // ---- process / system ----
  [/^ps\b/, () => ({ headline: "Inspected running processes", verb: "exec" })],
  [/^kill\b/, () => ({ headline: "Killed a process", verb: "exec" })],
  [/^lsof\b/, () => ({ headline: "Inspected open file handles", verb: "exec" })],
  [/^netstat\b|^ss\b/, () => ({ headline: "Inspected network sockets", verb: "exec" })],
  [/^env\b/, () => ({ headline: "Inspected environment variables", verb: "exec" })],
  [/^(export|set|unset)\b/, () => ({ headline: "Set an environment variable", verb: "shell" })],
  [/^(source|\.)\s/, () => ({ headline: "Loaded a shell script", verb: "shell" })],
  [/^(echo|printf)\b/, () => ({ headline: "Printed text", verb: "shell" })],
  [/^sleep\b/, () => ({ headline: "Waited a moment", verb: "shell" })],
  [/^date\b/, () => ({ headline: "Checked the date", verb: "read" })],
  [/^(whoami|id|hostname|uname)\b/, () => ({ headline: "Checked system info", verb: "read" })],
  [/^(sudo|nohup|time|timeout|xvfb-run)\b/, (t) => {
    // These just wrap another command; describe what they wrap. Drop the
    // wrapper word plus any of its own leading flags and a duration arg
    // (e.g. `timeout 5 npm test` → `npm test`). Falls through when nothing
    // is left to unwrap.
    const inner = t
      .replace(/^\S+\s+/, "")
      .replace(/^(?:-\S+\s+|[\d.]+[smhd]?\s+)+/, "")
      .trim();
    if (inner && inner !== t) return bashIntent(inner);
    return null;
  }],

  // ---- editors / macOS / open ----
  [/^code\b/, (t) => {
    const arg = t.split(/\s+/)[1];
    return arg ? { headline: `Opened ${basename(arg)} in the editor`, verb: "shell" } : { headline: "Opened the editor", verb: "shell" };
  }],
  [/^open\b/, (t) => {
    const arg = t.split(/\s+/)[1];
    return arg ? { headline: `Opened ${basename(arg)}`, verb: "shell" } : { headline: "Opened a file", verb: "shell" };
  }],
  [/^pbcopy\b|^pbpaste\b/, () => ({ headline: "Used the clipboard", verb: "shell" })],
];

/**
 * Map a Bash command to a human intent. Covers the common idioms agents
 * actually use: build/test, git, search, file I/O, network, scripting.
 * Falls back to "Ran <first word>" so anything unrecognised still reads.
 */
export function bashIntent(cmd: string): EventIntent {
  let t = cmd.trim();

  // Unwrap subshell `(…)` and group `{ …; }` wrappers (possibly nested) so a
  // command like `(cd app && npm run build)` reads as the work inside, not as
  // a literal `(cd`. A leading `(`/`{` only ever opens a group in shell, so
  // stripping it is safe.
  let prevT = "";
  while (t !== prevT) {
    prevT = t;
    // Only strip the trailing bracket when there is a matching leading one, so
    // a command substitution at the end (`code=$(…)`) keeps its closing `)`.
    if (/^[({]/.test(t)) {
      t = t.replace(/^[({]\s*/, "").replace(/\s*;?\s*[)}]\s*$/, "").trim();
    }
  }

  // Command-substitution assignment: `VAR=$(real command)` (or backticks). The
  // assignment is bookkeeping — the work is the substituted command — so
  // describe that. This is what turns a loop body like
  // `code=$(secure_curl.sh … -X PUT …)` into the script it runs, not a bare `--`.
  const cmdSub = t.match(/^[A-Za-z_][A-Za-z0-9_]*=(?:\$\(([\s\S]+)\)|`([\s\S]+)`)\s*$/);
  if (cmdSub) {
    const inner = (cmdSub[1] ?? cmdSub[2] ?? "").trim();
    if (inner) return bashIntent(inner);
  }

  // Strip leading environment-variable assignments (`FOO=bar BAZ=1 <cmd>`).
  // These are setup noise; the real intent is the command that follows them.
  // (A collapsed multi-line script like `f=… served=0 for i in …` reduces to
  // the `for` loop once the leading assignments are stripped.) A value that
  // opens a command substitution (`VAR=$(…)`) is real work, not noise — the
  // negative lookahead leaves it for the matchers above.
  t = t.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|(?!\$\()\S*)\s+)+/, "").trim();

  // Stripping the leading assignment(s) above can leave a dangling chain
  // operator at the front (`SCRIPTS_DIR="…" && ls …` → `&& ls …`). Drop it so
  // the real command is matched, not surfaced as `Ran \`&&\``.
  t = t.replace(/^(?:&&|\|\||;|\|)\s*/, "").trim();

  // A chain stage can begin with a shell keyword that belongs to an enclosing
  // loop/conditional that got split apart (`… ; do CMD ; done` leaves `do CMD`;
  // `… ; else CMD ; fi` leaves `else CMD`). Drop the leading keyword so the real
  // command is described, not surfaced as `Ran \`do\`` / `Ran \`else\``. The
  // loop/conditional openers (for/while/if/…) are handled below, not here.
  t = t.replace(/^(?:do|then|else|elif)\s+/, "").trim();

  // Output redirected INTO a file is a write, not whatever the left side would
  // otherwise read: a heredoc written to a file (`cat > /tmp/x.txt << 'EOF' …`),
  // or a content producer redirected to one (`cat`/`echo`/`printf`/`tee > f`).
  // The lookbehind skips fd redirects (`2>`, `1>`) AND the `=`/`-` of JS/arrow
  // operators (`c=>d`, `a->b`) that appear in inline `node -e '…'` scripts, so an
  // arrow never reads as "Wrote <token>". A redirect only belongs to the
  // producer's own segment (before the first pipe/newline), so a `>` deep in a
  // downstream piped script isn't pinned on a leading echo/cat.
  const firstSeg = t.split(/\n|\|/)[0] ?? t;
  const heredocToFile = t.match(REDIR_TO_FILE_HEREDOC);
  const producerToFile = PRODUCER_RE.test(t)
    ? firstSeg.match(REDIR)
    : null;
  const redirTarget = (heredocToFile ?? producerToFile)?.[2];
  if (redirTarget && redirTarget !== "/dev/null" && !/^&?\d+$/.test(redirTarget)) {
    return { headline: `Wrote ${basename(redirTarget)}`, verb: "write" };
  }

  // Strip redirect noise so it can't be mistaken for a path argument: any
  // redirect to /dev/null (`2>/dev/null`, `&>/dev/null`, `>/dev/null`) and fd
  // duplications (`2>&1`, `1>&2`). Without this, `ls x 2>/dev/null` reads as
  // "Listed 2>/dev/null" because the redirect token wins lastPathArg's scan.
  t = t
    .replace(/[0-9&]*>>?\s*\/dev\/null/g, " ")
    .replace(/[0-9]*>&[0-9]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Shell control flow (loops / conditionals). The `;` inside `for … do … done`
  // is structural, not a command chain, so detect these BEFORE chain-splitting.
  // Describe the body (the command after `do` / `then`) when we can find it.
  const cf = t.match(/^(for|while|until|select|if|case|function)\b/)?.[1];
  if (cf) {
    if (cf === "case") return { headline: "Ran a conditional", verb: "exec" };
    if (cf === "function") return { headline: "Defined a shell function", verb: "shell" };
    const isLoop = cf !== "if";
    const marker = isLoop ? "do" : "then";
    const closer = isLoop ? "done" : "fi";
    const body = t
      .match(new RegExp(`\\b${marker}\\b([\\s\\S]+?)(?:;?\\s*${closer}\\b|$)`))?.[1]
      ?.trim();
    if (body) {
      const inner = bashIntent(body);
      return {
        headline: `${inner.headline} (${isLoop ? "in a loop" : "conditionally"})`,
        verb: inner.verb,
      };
    }
    return { headline: isLoop ? "Ran a loop" : "Ran a conditional", verb: "exec" };
  }

  // Command chains and multi-line scripts (`a && b`, `a; b`, or a newline
  // between statements). Navigation/setup stages such as `cd`, `export`, or
  // `source` are scaffolding around the real work, so we describe the first
  // stage that actually does something. That makes "cd app && npm run build"
  // (or the same across two lines) read as "Built the project", not the `cd`.
  // Skip newline-splitting when a heredoc is present: its body is unquoted
  // lines that must stay intact for the inline-code detector below.
  const chainSeps = t.includes("<<") ? ["&&", "||", ";"] : ["&&", "||", ";", "\n"];
  const stages = splitTopLevel(t, chainSeps);
  if (stages.length > 1) {
    // Scaffold stages are setup/narration, never the headline:
    //   - navigation/setup verbs (`cd`, `export`, `source`, …)
    //   - `echo`/`printf` section-headers like `echo "=== run sync ==="`
    //   - `tool --version` / `tool --help` environment probes
    // The `--` is required so a real flag like `ls -h` is not mistaken for help.
    const isScaffold = (s: string): boolean =>
      /^(cd|export|set|unset|source|\.|pushd|popd|clear|true|:|wait|echo|printf)\b/.test(s) ||
      /^\S+\s+--(version|help)\b/.test(s);
    const real = stages.filter((s) => !isScaffold(s));
    // Of the substantive stages, surface the highest-value one (a batch often
    // inspects before it acts, e.g. `az --version … && az pipelines list …`),
    // ties keeping source order. Falling back to stages[0] keeps a pure-scaffold
    // chain (all echoes, say) reading as "Printed text".
    const candidates = real.length ? real : [stages[0]!];
    let best = candidates[0]!;
    let bestIntent = bashIntent(best);
    let bestWeight = STAGE_WEIGHT[bestIntent.verb] ?? 0;
    for (let i = 1; i < candidates.length; i++) {
      const intent = bashIntent(candidates[i]!);
      const weight = STAGE_WEIGHT[intent.verb] ?? 0;
      if (weight > bestWeight) {
        best = candidates[i]!;
        bestIntent = intent;
        bestWeight = weight;
      }
    }
    if (best !== t) return bestIntent;
  }

  // ---- pipelines: infer the whole pipeline from its source + final stage ----
  // Detect here (before the per-command matchers) so `ps aux | grep node` reads
  // as a search, not as "Inspected processes". `|` inside quotes is ignored.
  const pipeStages = splitTopLevel(t, ["|"]);
  if (pipeStages.length > 1) return pipelineIntent(pipeStages);

  // ---- per-command matcher ladder (data-driven, see BASH_MATCHERS) ----
  // First matcher whose regex matches and yields a non-null result wins. A null
  // result means the matcher chose not to handle this command (the wrapper
  // branches that only recurse when they actually unwrap something), so we keep
  // scanning. Order is significant and matches the original if-ladder exactly.
  for (const [re, matcher] of BASH_MATCHERS) {
    if (re.test(t)) {
      const hit = matcher(t);
      if (hit) return hit;
    }
  }

  // ---- project / skill CLIs (this user's actual toolchain) ----
  const project = projectToolIntent(t);
  if (project) return project;

  // ---- default ----
  // Dequote the command word first: a quoted path like `"$HOME/.../foo.sh"`
  // otherwise basenames to `foo.sh"` with a stray trailing quote.
  const first = (t.split(/\s+/)[0] ?? "").replace(/^['"]+|['"]+$/g, "");
  if (!first) return { headline: "Ran a shell command", verb: "shell" };
  // A path to a script reads better as its basename
  // (`~/.claude/.../secure_curl.sh` → `secure_curl.sh`).
  const label = first.includes("/") ? basename(first) : first;
  return { headline: `Ran \`${label}\``, verb: "shell" };
}

// A short noun for what a pipeline's source stage produces, used to phrase the
// combined headline ("Searched <the process list> for X").
function pipeSourceNoun(stage: string): string {
  const t = stage.trim();
  if (/^ls\b/.test(t)) return "the file listing";
  if (/^(cat|head|tail|less|more)\b/.test(t)) {
    const f = lastPathArg(t);
    return f ? basename(f) : "the file";
  }
  if (/^ps\b/.test(t)) return "the process list";
  if (/^find\b/.test(t)) return "the matched files";
  if (/^(grep|rg|ag|ack)\b/.test(t)) return "the matches";
  if (/^git\s+log\b/.test(t)) return "the git history";
  if (/^(curl|wget)\b/.test(t)) return "the response";
  if (/^env\b/.test(t)) return "the environment";
  if (/^(echo|printf)\b/.test(t)) return "the text";
  if (/^(docker|kubectl)\b/.test(t)) return "the output";
  return "the output";
}

// The search term of a grep-like stage: prefer a quoted pattern, else the first
// non-flag argument (`grep node` -> "node").
function grepPattern(stage: string): string | null {
  const q = firstQuoted(stage);
  if (q) return q;
  const tok = stage
    .split(/\s+/)
    .slice(1)
    .find((x) => x.length > 0 && !x.startsWith("-"));
  return tok ?? null;
}

/**
 * Infer a pipeline's intent from its source (first stage) and consumer (last
 * stage). The consumer usually carries the goal: `| grep X` is a search, `| wc`
 * is a count, `| jq` is an extraction, `| xargs CMD` runs CMD. When the consumer
 * is just a viewer/limiter (head/tail/less/cat), the source command is the point.
 */
function pipelineIntent(stages: string[]): EventIntent {
  const first = (stages[0] ?? "").trim();
  const last = (stages[stages.length - 1] ?? "").trim();
  const source = bashIntent(first);
  const noun = pipeSourceNoun(first);

  // search: `… | grep X`
  if (/^(grep|rg|ag|ack)\b/.test(last)) {
    const q = grepPattern(last);
    return q
      ? { headline: `Searched ${noun} for "${q.slice(0, 40)}"`, verb: "search" }
      : { headline: `Filtered ${noun}`, verb: "search" };
  }
  // count: `… | wc -l`
  if (/^wc\b/.test(last)) {
    if (/^ls\b/.test(first)) return { headline: "Counted files", verb: "read" };
    if (/^find\b/.test(first)) return { headline: "Counted matching files", verb: "read" };
    if (/^(grep|rg|ag|ack)\b/.test(first)) return { headline: "Counted matches", verb: "read" };
    if (/^(cat|head|tail)\b/.test(first)) {
      const f = lastPathArg(first);
      return { headline: f ? `Counted lines in ${basename(f)}` : "Counted lines", verb: "read" };
    }
    return { headline: "Counted the results", verb: "read" };
  }
  // JSON extraction: `… | jq`
  if (/^jq\b/.test(last)) {
    if (source.verb === "web") return { headline: `${source.headline} (parsed JSON)`, verb: "web" };
    return { headline: `Extracted data from ${noun}`, verb: "read" };
  }
  // run a command per result: `… | xargs CMD`
  if (/^xargs\b/.test(last)) {
    const cmd = last.replace(/^xargs\s+(?:-\S+\s+)*/, "").trim();
    if (cmd) return bashIntent(cmd);
  }
  // save: `… | tee FILE`
  if (/^tee\b/.test(last)) {
    const f = lastPathArg(last);
    return { headline: f ? `Saved output to ${basename(f)}` : "Saved the output", verb: "write" };
  }
  // clipboard: `… | pbcopy`
  if (/^pbcopy\b/.test(last)) return { headline: "Copied output to the clipboard", verb: "shell" };
  // order / dedupe / transform consumers (`… | sort|uniq|awk|sed|cut|tr`) are
  // usually just reformatting the output of a substantive source. When the
  // source is real work (build/test/git/web/exec/write — weight ≥ 5), keep the
  // source as the intent: `very_good test … | tr` is a test run, not a "transform".
  if (/^(uniq|sort|awk|sed|cut|tr)\b/.test(last)) {
    if ((STAGE_WEIGHT[source.verb] ?? 0) >= 5) return source;
    if (/^uniq\b/.test(last)) return { headline: `Deduplicated ${noun}`, verb: "shell" };
    if (/^sort\b/.test(last)) return { headline: `Sorted ${noun}`, verb: "shell" };
    return { headline: `Transformed ${noun}`, verb: "shell" };
  }

  // Viewer/limiter consumers (head/tail/less/more/cat) or anything else: the
  // source command is the most descriptive thing about the pipeline.
  return source;
}

// Past → present mapping for leading verbs in bashIntent / inlineCodeIntent
// output. Used by toPresent() to convert a recap-style headline into a
// permission-prompt-style headline ("Built the project" → "Build the project").
//
// Scope: toPresent() only ever runs on bashIntent / mcpIntent output (the two
// permissionIntent call sites), so this table only needs the leading verbs
// those two producers actually emit. Verbs that exist solely in
// toolIntent / eventIntent headlines (Approved, Denied, Patched, Globbed,
// Multi-edited, Initialised, Dispatched, Logged, Asked, Invoked, Scheduled,
// Closed, Hit, Found, Stopped) never reach toPresent and have been dropped.
const PAST_TO_PRESENT: Record<string, string> = {
  // Irregular
  Built: "Build",
  Ran: "Run",
  Wrote: "Write",
  Made: "Make",
  Read: "Read",
  Reset: "Reset",
  // Regular -ed
  Searched: "Search",
  Listed: "List",
  Created: "Create",
  Removed: "Remove",
  Moved: "Move",
  Copied: "Copy",
  Checked: "Check",
  Inspected: "Inspect",
  Fetched: "Fetch",
  Pushed: "Push",
  Pulled: "Pull",
  Stashed: "Stash",
  Merged: "Merge",
  Rebased: "Rebase",
  Switched: "Switch",
  Started: "Start",
  Killed: "Kill",
  Located: "Locate",
  Counted: "Count",
  Touched: "Touch",
  Changed: "Change",
  Downloaded: "Download",
  Opened: "Open",
  Used: "Use",
  Restored: "Restore",
  Worked: "Work",
  Edited: "Edit",
  Printed: "Print",
  Updated: "Update",
  Called: "Call",
  Staged: "Stage",
  Processed: "Process",
  Transformed: "Transform",
  Sorted: "Sort",
  Filtered: "Filter",
  Extracted: "Extract",
  Compared: "Compare",
  Installed: "Install",
  Configured: "Configure",
  Managed: "Manage",
  Loaded: "Load",
  Waited: "Wait",
  Defined: "Define",
  Analyzed: "Analyze",
  Formatted: "Format",
  Cleaned: "Clean",
  Set: "Set",
  "Type-checked": "Type-check",
};

/**
 * Convert a past-tense intent headline to present tense. Used for permission
 * prompts where the action has not happened yet (the user is being asked to
 * approve it). The Summary HTML keeps past tense because those events did
 * happen.
 *
 *   "Built the project"   → "Build the project"
 *   "Searched for foo"    → "Search for foo"
 *   "Read App.tsx"        → "Read App.tsx"   (unchanged)
 *   "Ran git status"      → "Run git status"
 */
export function toPresent(headline: string): string {
  // Match the leading verb token. Allow hyphenated verbs like "Type-checked".
  const m = headline.match(/^([A-Z][A-Za-z-]*)/);
  if (!m) return headline;
  const first = m[1] ?? "";
  const replacement = PAST_TO_PRESENT[first];
  if (!replacement) return headline;
  return replacement + headline.slice(first.length);
}


/**
 * Map a permission request (tool + command) to a present-tense human headline,
 * matching the semantics of the activity feed's `eventIntent()`. Used by both
 * the macOS native alert and the browser desktop notification so they read the
 * same as the in-app Recent activity rows.
 *
 * `command` is whatever the caller asked permission to run: a shell command for
 * Bash, a file path for Read/Edit/Write, a query for Grep/WebSearch, a URL for
 * WebFetch, etc. Empty string is tolerated.
 */
export function permissionIntent(tool: string, command: string): EventIntent {
  // A missing target can arrive stringified as "null"/"undefined" (e.g. a Read
  // whose file_path was absent). Treat those as no target so we never render
  // "Read null".
  let target = (command ?? "").trim();
  if (target === "null" || target === "undefined") target = "";
  const file = basename(target);

  if (tool === "Bash") {
    const i = bashIntent(target);
    return { headline: toPresent(i.headline), verb: i.verb };
  }
  if (tool === "Read" || tool === "NotebookRead") {
    return { headline: file ? `Read ${file}` : "Read a file", verb: "read" };
  }
  if (tool === "Write") {
    return { headline: file ? `Create ${file}` : "Create a file", verb: "write" };
  }
  if (tool === "Edit" || tool === "MultiEdit") {
    return { headline: file ? `Edit ${file}` : "Edit a file", verb: "write" };
  }
  if (tool === "NotebookEdit") {
    return { headline: file ? `Edit notebook ${file}` : "Edit a notebook", verb: "write" };
  }
  if (tool === "Glob") {
    return { headline: target ? `Glob ${target}` : "Glob files", verb: "search" };
  }
  if (tool === "Grep") {
    const q = firstQuoted(target) ?? target.slice(0, 40);
    return { headline: q ? `Search code for "${q}"` : "Search the codebase", verb: "search" };
  }
  if (tool === "WebFetch") {
    const url = target.match(/https?:\/\/\S+/)?.[0];
    return { headline: url ? `Fetch ${hostnameOf(url)}` : "Fetch the web", verb: "web" };
  }
  if (tool === "WebSearch") {
    return { headline: target ? `Search the web for ${target.slice(0, 40)}` : "Search the web", verb: "web" };
  }
  if (tool === "Task" || tool === "Agent" || /agent/i.test(tool)) {
    return { headline: target ? `Dispatch ${target.slice(0, 40)}` : "Dispatch a subagent", verb: "agent" };
  }
  if (tool.startsWith("mcp__")) {
    const i = mcpIntent(tool, target);
    return { headline: toPresent(i.headline), verb: i.verb };
  }
  return { headline: target ? `${tool} · ${target.slice(0, 60)}` : `${tool} call`, verb: "shell" };
}

/**
 * Map an MCP tool call (`mcp__<server>__<tool>`) to a human intent. Two reasons
 * this is its own helper:
 *   1. The old `mcp__([^_]+)__(.+)` parse breaks on real server names, which
 *      contain underscores (`claude_ai_Atlassian`, `Google_Drive`). MCP uses a
 *      DOUBLE-underscore delimiter, so we split on the first `__` after the
 *      `mcp__` prefix instead.
 *   2. "Called search on the Atlassian MCP" is weak. We name the service
 *      (Jira/Slack/Notion/Gmail/…) and the action ("Searched Jira", "Sent a
 *      Slack message") from the tool-name shape.
 * `target` is the salient arg the mirror hook extracted (a query, key, channel,
 * title); used to enrich a few headlines but optional.
 */
export function mcpIntent(tool: string, target: string = ""): EventIntent {
  const rest = tool.replace(/^mcp__/, "");
  const sep = rest.indexOf("__");
  const rawServer = sep >= 0 ? rest.slice(0, sep) : rest;
  const name = sep >= 0 ? rest.slice(sep + 2) : "";
  const s = rawServer.toLowerCase();
  // Friendly service label: known services get a clean name, otherwise strip
  // the `claude_ai_` prefix and turn underscores into spaces.
  let service = rawServer.replace(/^claude_ai_/i, "").replace(/_/g, " ").trim();
  if (/atlassian|jira/.test(s)) service = "Jira";
  else if (/confluence/.test(s)) service = "Confluence";
  else if (/slack/.test(s)) service = "Slack";
  else if (/gmail/.test(s)) service = "Gmail";
  else if (/calendar/.test(s)) service = "Calendar";
  else if (/drive/.test(s)) service = "Drive";
  else if (/notion/.test(s)) service = "Notion";
  else if (/miro/.test(s)) service = "Miro";

  const n = name.toLowerCase();
  const isWrite = /^(create|add|send|post|update|edit|delete|remove|set|move|comment|write|upload|append|put|patch|archive|transition)/.test(n);
  const isRead = /^(get|list|read|search|fetch|find|view|query|describe|lookup|retrieve|download|export)/.test(n);

  if (/authenticate|authentication|^auth/.test(n)) return { headline: `Authenticated with ${service}`, verb: "web" };
  if (service === "Slack") {
    if (/search|find/.test(n)) return { headline: "Searched Slack", verb: "web" };
    if (/^(send|post|reply)|send_message|post_message/.test(n)) return { headline: "Sent a Slack message", verb: "write" };
    if (/history|list|read|get|conversation|message/.test(n)) return { headline: "Read Slack", verb: "web" };
  } else if (service === "Jira") {
    if (/search|jql/.test(n)) return { headline: "Searched Jira", verb: "web" };
    if (/comment/.test(n)) return { headline: isWrite ? "Commented on a Jira issue" : "Read Jira comments", verb: isWrite ? "write" : "web" };
    if (/create/.test(n)) return { headline: "Created a Jira issue", verb: "write" };
    if (/transition/.test(n)) return { headline: "Transitioned a Jira issue", verb: "write" };
    if (/update|edit/.test(n)) return { headline: "Updated a Jira issue", verb: "write" };
    if (/issue|get|read|view/.test(n)) return { headline: target ? `Read Jira ${target.slice(0, 24)}` : "Read a Jira issue", verb: "web" };
  } else if (service === "Notion") {
    if (/search/.test(n)) return { headline: "Searched Notion", verb: "web" };
    if (/create/.test(n)) return { headline: "Created a Notion page", verb: "write" };
    if (/update|append|edit/.test(n)) return { headline: "Updated a Notion page", verb: "write" };
    if (/fetch|get|read|retrieve/.test(n)) return { headline: "Read a Notion page", verb: "web" };
  } else if (service === "Gmail") {
    if (/send/.test(n)) return { headline: "Sent an email", verb: "write" };
    if (/search|list/.test(n)) return { headline: "Searched email", verb: "web" };
    if (/read|get/.test(n)) return { headline: "Read an email", verb: "web" };
  } else if (service === "Calendar") {
    if (/create|add/.test(n)) return { headline: "Created a calendar event", verb: "write" };
    if (/list|search|get|find/.test(n)) return { headline: "Checked the calendar", verb: "web" };
  } else if (service === "Drive") {
    if (/search|list|find/.test(n)) return { headline: "Searched Drive", verb: "web" };
    if (/upload|create/.test(n)) return { headline: "Uploaded to Drive", verb: "write" };
    if (/read|get|fetch|download/.test(n)) return { headline: "Read a Drive file", verb: "web" };
  }

  // Generic but still names the action: humanize the tool verb
  // (`searchPages` → "search pages") and lead with the service.
  const pretty = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().trim();
  if (!pretty) return { headline: `Called ${service}`, verb: "exec" };
  return { headline: `${service}: ${pretty}`, verb: isWrite ? "write" : isRead ? "web" : "exec" };
}
