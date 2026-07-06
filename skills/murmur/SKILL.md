---
name: murmur
description: |
  Activate Murmur, the live agent-observability surface. Opens a browser pane that mirrors task rows, activity log, and pending questions for the session. Triggers when a user prompt contains "--murmur" or the phrase "murmur mode", or when a hook-injected context line says Murmur is active (the MURMUR_AUTO=1 always-on mode). Once active, replace AskUserQuestion with murmur_ask, emit narrative status via murmur_log, and let the PostToolUse mirror hook keep task rows in sync.
license: Proprietary
metadata:
  author: siavash
  version: "1.0"
  platform: shared
dependencies: []
---

# Murmur Mode

Murmur is the live agent-observability surface. Many agents, one view. The activation flag is `--murmur`.

## Trigger

A user prompt contains `--murmur` or the phrase "murmur mode", or a hook-injected context line says Murmur is active for this session (the `MURMUR_AUTO=1` always-on mode injects that line on every prompt while the dashboard is reachable).

## On activation (before responding)

1. Call the MCP tool `mcp__murmur__murmur_open` once. Surface the returned URL to the user in chat exactly once. In `MURMUR_AUTO` mode the pane may already be open (the hook auto-opens it), in which case `murmur_open` is still safe: it never spawns a second tab for a connected session.
2. If the task has discrete phases or steps (orchestrator, multi-step task), call `mcp__murmur__murmur_init` with the row list and use `TaskCreate` for each row. The PostToolUse mirror hook keeps Murmur in sync automatically.

## While active

- Replace every `AskUserQuestion` call with `mcp__murmur__murmur_ask`. Same input shape (question, header, options, multiSelect). The card renders in the browser as a modal and the answer flows back to the tool call.
- On `murmur_ask` returning `{ ok: false, reason: ... }`: fall back to `AskUserQuestion` for that single question. Do not retry `murmur_ask` for the same question.
- Use `mcp__murmur__murmur_log({ message })` for narrative status updates that would otherwise be silent prose ("running tests", "spec gathering complete").
- The mirror hook runs automatically. Do not also call `murmur_update` from a tool unless you are intentionally updating a row that was not created via `TaskCreate`.

## Sub-agent dispatch

When in Murmur mode and dispatching a sub-agent, prepend this reminder to the sub-agent's prompt: *"Murmur is on for the parent session. Do not call AskUserQuestion. Return any user-input need to the parent."*

## Deactivation

Murmur stays on for the rest of the session unless the user says "murmur off" or starts a new session. There is no cleanup on deactivation, the next prompt without the flag is simply business-as-usual.

## Multi-session

Each Claude Code session owns its own Murmur instance on its own port (5173, 5174, ...). The session switcher in the header lets one browser tab hop between them.

## Surface boundary

Pick the right tool based on tense and durability:

| Surface | Tool | Use for |
|---|---|---|
| Progress rows | `TaskCreate` / `TaskUpdate` | Operational status of committed work |
| Activity feed | `murmur_log` | Past-tense trace of what happened |
| Memory | `Write` to memory/ | Durable cross-session preferences |
| Permissions / questions | `murmur_ask` | Discrete string answers from the human |
