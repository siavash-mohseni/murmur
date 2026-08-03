# Murmur

Murmur is a local pager and live dashboard for Claude Code. It shows questions and permission prompts in your browser, sends optional background or macOS alerts, and lets you answer without finding the blocked terminal.

<p align="center">
  <img src="docs/screenshots/question-modal.png" alt="A Murmur question with three answer choices and a custom response field">
</p>
<p align="center"><em>Answer a Claude Code question from the Murmur dashboard.</em></p>

Use Murmur when you:

- leave long-running Claude Code sessions working in the background
- run several sessions and need one inbox for anything waiting on you
- want to inspect progress, context use, token use, cost, and files touched
- need a shareable record of how a session produced its result

The dashboard and session servers run on your machine and bind to `127.0.0.1`.

## Quick start

### 1. Check the requirements

You need:

- [Git](https://git-scm.com/)
- [Bun](https://bun.sh/) to install dependencies and build Murmur
- Node.js 18 or later to run the server and hook
- the Claude Code `claude` CLI on your `PATH`

The browser dashboard and in-tab alerts run on macOS, Windows, and Linux. Background alerts also require browser notification and service worker support. Native alerts require macOS. Xcode Command Line Tools are optional on macOS. If `swiftc` is unavailable, Murmur uses AppleScript for native alerts.

### 2. Install

```bash
git clone https://github.com/siavash-mohseni/murmur.git
cd murmur
bun run setup
```

Setup:

- installs dependencies and builds the web app and server
- copies one Node hook to `~/.claude/hooks`
- copies the `murmur` and `progress-dashboard` skills to `~/.claude/skills`
- backs up and updates `~/.claude/settings.json`
- backs up and adds a managed Murmur block to `~/.claude/CLAUDE.md`
- registers the Murmur MCP server with Claude Code at user scope
- runs an isolated hook-to-dashboard smoke test

Keep the cloned directory in place after setup. Claude Code starts the built server from that path. You can rerun setup safely because its configuration changes are idempotent.

### 3. Start a new Claude Code session

Close any Claude Code sessions that were open during setup. Start a new session from one of your own project directories, not from the Murmur repository, then send:

```text
--murmur Before doing anything else, ask me whether to use option A or option B.
```

Claude opens the dashboard, prints its local URL, and sends the question there. Choose an answer in the browser to let the session continue.

Murmur intentionally does not intercept questions while you are working inside its own repository. This prevents a development session from talking to an older installed build.

Murmur stays active until you say `murmur off` or start a new Claude Code session.

### 4. Check the installation

If the dashboard does not open or activity is missing, run this from the cloned Murmur directory:

```bash
bun run doctor
```

The doctor checks dependencies, the build, installed hooks and skills, Claude Code configuration, MCP registration, running session servers, connected browser tabs, and recent warnings.

### Optional: turn Murmur on for every session

Set the environment variable before starting Claude Code:

```bash
export MURMUR_AUTO=1
```

Add the same line to your shell profile if you want it to persist across terminal restarts.

## Questions and permission prompts

### Questions

When Murmur is active, Claude uses `murmur_ask` for questions. The question appears in the dashboard, your answer returns to the waiting tool call, and the session continues. A countdown shows when the question will time out. If it expires, the activity feed records the timeout and Claude continues.

### Permissions

Murmur mirrors permission prompts from Claude Code with **Allow once**, **Always allow**, and **Deny** controls.

<p align="center">
  <img src="docs/screenshots/permission-modal.png" alt="A Murmur permission prompt with allow once, always allow, and deny controls">
</p>

Murmur does not create permission prompts. It only handles `PermissionRequest` events that Claude Code would otherwise show. Allowlisted, auto-approved, and bypass-permissions commands do not produce a Murmur prompt.

### When the dashboard is closed

Murmur routes a question or permission prompt to the dashboard only when a browser tab is connected or native alerts are enabled. If nobody can see the dashboard, permission prompts remain in the terminal and `murmur_ask` returns immediately so Claude can fall back to its normal question tool.

## Notification channels

Choose one or more channels from the bell menu in the session header.

<p align="center">
  <img src="docs/screenshots/alerts-channels.png" alt="Murmur notification settings for in-tab, background, and native channels">
</p>

- **In this tab**: the in-page overlay for questions and permissions.
- **Background**: a service-worker push that fires even when the tab is not focused. It needs a Murmur tab open somewhere, and the preference persists in the browser Cache API.
- **Native (macOS)**: a native modal alert. The choice persists across restarts and is shared by every Murmur session.

The browser tab title also flashes when something needs you, so a background tab is enough to notice.

## Dashboard views

Use the header toggle to switch between Owner and Operator views. Murmur remembers your choice.

### Owner view

Owner view answers three questions: what Claude is doing, what it has completed, and whether it needs you. It shows a current-status summary, an outcome timeline, an inbox, and a heartbeat for active work.

<p align="center">
  <img src="docs/screenshots/owner-view.png" alt="Murmur Owner view with current status, outcomes, and inbox">
</p>

### Operator view

Operator view shows session metrics and the detailed activity panels. Use the period picker to view the current session, today, or a wider time range.

<p align="center">
  <img src="docs/screenshots/operator-view.png" alt="Murmur Operator view with session metrics and activity panels">
</p>

| Tile | Shows |
|---|---|
| Activity | Messages and tool calls, with a sparkline and a rolling average. |
| Context | Live context-window usage as a gauge, with warn and cliff thresholds. |
| Tokens used | Total tokens, split into input, output, and cache, including tokens spent by workflows. |
| Cost | Estimated session cost for the current model, workflow cost folded in. |
| Cache hit | Cache read share as a donut. |
| Tool calls | Tool-call count for the period, with a sparkline. |

**Banners** appear only when relevant: a context-tier warning as you approach the window limit, a stuck-session warning, and a banner when another session is waiting on input.

## Progress and activity

Operator view includes Progress, Activity, Tool breakdown, Sub-agents, Background tasks, Slash commands, Skills loaded, Routines, Memory, and Files touched.

Progress rows come from Claude Code `TaskCreate` and `TaskUpdate` calls. Murmur groups them into named runs so you can see completed, active, and pending work.

<p align="center">
  <img src="docs/screenshots/progress-panel.png" alt="Murmur progress panel with completed and active task rows">
</p>

When Claude runs a multi-agent workflow, Murmur shows its phases, completion counts, longest-running agent, and token cost. Workflow cost is included in the session Cost metric.

<p align="center">
  <img src="docs/screenshots/workflows-panel.png" alt="Murmur workflow panel with phases, agent progress, and token use">
</p>

**Dimensions.** Custom usage tags from `OTEL_RESOURCE_ATTRIBUTES` (for example `team`, `repo`) show as session chips, so you can tell at a glance which project or team a session belongs to.

## The fleet

When more than one Claude Code session is running, the Fleet page shows every live session in one place. Sessions waiting for input appear first. Each card shows status, last activity, task progress, context use, and estimated cost.

The **Needs you** inbox collects pending questions and permission prompts from every session. You can answer them without opening each session.

<p align="center">
  <img src="docs/screenshots/fleet-home.png" alt="Murmur Fleet page with live sessions and a shared needs-you inbox">
</p>

<p align="center">
  <img src="docs/screenshots/fleet-needs-you.png" alt="Fleet, needs-you state" width="380">
</p>

The Fleet page is served by one local hub on port 4747. The hub starts when needed and exits after 30 minutes without sessions or browser clients. Its internal connection does not count as a viewer. A fleet browser tab must be open before sessions route prompts there.

### Switching sessions

Each Claude Code session runs its own Murmur server on the first available port starting at 5173. The header shows its working directory, model, start time, and last activity. Use the session switcher to move between live sessions or open a persisted earlier session.

<p align="center">
  <img src="docs/screenshots/session-switcher.png" alt="Murmur session switcher with live and earlier sessions">
</p>

## Privacy and local data

- Session servers and the Fleet hub bind to `127.0.0.1`.
- Murmur rejects unexpected host headers and cross-site mutation requests.
- Session activity, questions, permission decisions, and token statistics are persisted under `~/.claude/state/murmur/`.
- The live dashboard shows the original local data. It is not redacted.
- Export redaction applies to text. Screenshots and phone numbers are not redacted.
- Setup changes `~/.claude/settings.json` and `~/.claude/CLAUDE.md` only after writing backup files.
- Uninstall removes Murmur's managed configuration without removing unrelated settings.

Review an export before sharing it if the session contains sensitive screenshots or text that the redaction rules do not cover.

## Sharing and export

The header can produce a plain-language summary or a full session export. Each is a self-contained HTML file with no external runtime dependencies.

The same documents render server-side from persisted state, so past sessions export too and transcript images come inlined as data URIs:

- **HTTP**: `GET /export/<key>.html` on the hub or any session server (`?kind=data` for the dense dump instead of the narrative summary). A session server renders its own key from the live snapshot.
- **CLI**: `murmur-export` lists every session on disk, `murmur-export <key prefix>` writes the summary next to you, `--data` and `--out` adjust what and where. No server needs to be running.

**PR receipts.** `murmur-export <key> --receipt` publishes the summary as a secret gist and appends its link to the pull request body. Anyone with the gist URL can read it. Re-running the command replaces the previous receipt. Use `--pr <n>` to select a pull request or `--no-pr` to create only the gist. This command requires the GitHub CLI (`gh`).

**PII redaction.** Exports, receipts, and browser share actions redact emails, supported API keys and tokens, home-directory usernames, non-loopback IPv4 addresses, and Luhn-valid card numbers by default. Code, diffs, git SHAs, UUIDs, timestamps, screenshots, and phone numbers are left unchanged. Use `--no-redact` in the CLI or `?redact=0` in the export URL only when you intend to export the original text.

## Configuration

All environment variables are optional.

| Variable | Effect |
|---|---|
| `MURMUR_AUTO=1` | Open Murmur on the first prompt of every session. |
| `OTEL_RESOURCE_ATTRIBUTES` | Add `team=...,repo=...` usage tags to session chips. |
| `MURMUR_HUB=0` | Disable the Fleet hub. Each session continues to serve its own dashboard. |
| `MURMUR_HUB_PORT` | Override the Fleet hub port. The default is 4747. |
| `MURMUR_AGENTS_POLL=0` | Disable polling of `claude agents --json`, which can help in CI or headless runs. |
| `MURMUR_WORKFLOW_PREVIEWS=0` | Hide workflow preview text. |
| `CLAUDE_MURMUR_PORT` | Override the session port for hook debugging. |
| `MURMUR_DEBUG_ENV` | Log Claude-related environment variables at startup for diagnostics. |

`MURMUR_MAC_MODAL` is deprecated. Choose the native channel from the dashboard instead.

## Updating and removing

### Update

From the cloned Murmur directory, pull the latest changes and rerun setup:

```bash
git pull && bun run setup
```

Setup replaces its managed files and configuration without duplicating entries. Restart Claude Code after it completes.

### Remove

```bash
bun run uninstall:murmur          # keep session traces
bun run uninstall:murmur --purge  # also delete ~/.claude/state/murmur
```

Uninstall removes the hook, Murmur's settings registrations, its managed CLAUDE.md block, the MCP registration, and the copied skills. Other settings remain unchanged. You can delete the cloned directory after uninstall completes.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The dashboard never opens on a `--murmur` prompt | You did not restart Claude Code after setup, so the MCP server and hooks are not loaded yet. Restart, then try again. |
| `claude mcp add` failed during setup | The `claude` CLI is not on your `PATH`. Run the manual `claude mcp add` command that setup printed. |
| Rows and activity do not appear | Run `bun run doctor`: it checks the hook file and registrations, live session servers, and tails `warnings.log`. |
| Anything else misbehaves | `bun run doctor` first. Server-side mirror failures are logged to `~/.claude/state/murmur/warnings.log`. |
| Port 5173 is busy | Murmur automatically binds the next free port (5174, 5175, and so on) and writes a port file so the browser and hooks find it. No action needed. |
| The native macOS alert uses a plain dialog | The SwiftUI helper needs `swiftc` at build time. Install the Xcode Command Line Tools and rerun `bun run setup`. Without it, the channel uses AppleScript. |
| Setup says `dist/index.js not found` | You ran `bun scripts/setup.ts` without building first. Use `bun run setup`, which builds before wiring. |

## Advanced reference

### MCP tools

Murmur exposes five tools. Normal use requires only `murmur_open` and `murmur_ask`. The installed hook and skill call the others when needed.

| Tool | Purpose |
|---|---|
| `murmur_open` | Open the browser surface for this session and return its URL. Optional `port` and `open` arguments control the port and browser launch. |
| `murmur_init` | Add a named run of progress rows. |
| `murmur_update` | Update one progress row or mark a row as failed. |
| `murmur_log` | Add a past-tense status line to the activity feed. |
| `murmur_ask` | Show a question in the dashboard and return the answer to Claude. |

Use `TaskCreate` and `TaskUpdate` for operational progress, `murmur_log` for narrative history, `murmur_ask` for user decisions, and memory files for preferences that must persist across sessions.

### How it works

Murmur observes Claude Code events and returns answers and permission decisions. It does not execute agent work or modify tool inputs.

- **Per-session server.** The MCP child starts a local HTTP server on the first free port from 5173 up, bound to `127.0.0.1`, and writes a port file under `~/.claude/state/murmur/sessions/` so the hook and the browser can find the right instance. Its lifetime is tied to the parent Claude Code process, so it exits with the session.
- **The hub.** A detached process (`dist/hub.js`, port 4747) starts when the first session needs it. It reads each session's event stream, serves the Fleet page, and forwards requests to the owning session. Its mirror connections are excluded from viewer counts. It exits after 30 minutes with no sessions or browser clients.
- **Guards.** Both servers bind `127.0.0.1` only. They also reject `Host` headers that do not name the machine (DNS rebinding) and cross-site `Origin`s on mutating requests (CSRF), the two ways a victim's own browser can be turned against a loopback server.
- **One hook, six events.** Setup registers a single dependency-free Node script, `~/.claude/hooks/murmur-hook.mjs`, under six events. Each invocation posts to the session's local server and silent-fails when Murmur is not listening.

| Event | Subcommand | Role |
|---|---|---|
| PostToolUse | `mirror` | Mirrors tool calls into the Activity and Progress surfaces. |
| PermissionRequest | `permission` | Routes a permission prompt to the dashboard (only when the CLI would prompt). |
| PreToolUse (`AskUserQuestion`) | `question` | Redirects questions to `murmur_ask`. Skips the Murmur repo itself. |
| UserPromptSubmit | `user-prompt` | Captures your prompts into the feed and injects the routing reminder. |
| PreCompact | `precompact` | Marks a context compaction in the trace. |
| Stop | `stop` | Marks the session idle when a turn ends. |

- **State.** Per-session state (rows, activities, questions, token stats) lives under `~/.claude/state/murmur/` and is persisted so a reload does not lose the trace.
- **Feeds.** The hook POSTs to `/sync`. The browser reads a full snapshot from `/state` and streams updates over `/events`. Two server-side polls run without any hook: a workflow mirror (tails the workflow journal) and an agents mirror (`claude agents --json`).
- **Endpoints.** Question and permission answers come back over `/api/answer`, `/api/cancel`, and `/api/permission/answer`. Owner-view summaries are generated on demand via `/api/owner/summary`. Transcript images are served from `/api/image/`, and `/export/<key>.html` renders a self-contained session document from persisted state (the HTML builders live in `src/export/` and are shared verbatim with the browser Share buttons).
- **Bundled skills and CLAUDE.md.** Two skills ship in the repo: `murmur` (the activation skill, holding the artifact design system) and `progress-dashboard` (the fallback route for multi-phase progress). Setup also injects three sections into `~/.claude/CLAUDE.md`, sourced from `claude-md/murmur.md`.

## Develop

```bash
bun run dev      # run the server from source on :5173
bun run build    # web + server (+ setup/uninstall bins)
bun run smoke    # smoke tests
node scripts/mirror-hook-smoke.mjs   # hook -> server -> state round-trip
node scripts/hook-paths-smoke.mjs    # question/permission blocking paths
node scripts/hub-smoke.mjs           # hub, fleet, proxy, watcher relay
node scripts/export-smoke.mjs        # export CLI, server routes, image inlining
bun scripts/redact-smoke.ts          # PII redaction rules and share-context walk
node scripts/make-icons.mjs          # regenerate the PWA icon set
```

Type-check with `bunx tsc --noEmit` at the repo root (server) and inside `web/` (dashboard). The macOS alert helper builds separately with `bun run build:native` (needs `swiftc`) and is also built opportunistically by setup.
