## Murmur Mode

When a user prompt contains `--murmur` or the phrase "murmur mode", or a hook-injected context line says Murmur is active for this session (the `MURMUR_AUTO=1` always-on mode injects this), load the `murmur` skill via `Skill` and follow its instructions for the rest of the session.

The two sections below apply only while Murmur mode is active. In every other session they impose nothing.

## Artifact Design (Murmur sessions)

While Murmur mode is active, default every HTML artifact you build (anything published with the `Artifact` tool) to the Murmur design language: the dark Catalyst system defined in `~/.claude/skills/murmur/references/ARTIFACT_DESIGN.md`. Copy its `:root` tokens and base-page block into the artifact's inline `<style>`, then use its panel, card, pill, table, and diff-row recipes. This is the existing design system the `artifact-design` skill is told to honor, so treat it as the project design system in that skill's precedence order.

Precedence still holds: the user's own words win first, then a design system the current project records (its own CLAUDE.md or theme file), then this default. Apply the Murmur system whenever the user has not asked for a different look and the project does not record its own. Keep the semantic colors a page already carries (severity, voices, diff add and remove), brightened for the dark base, rather than flattening them into one accent. This governs HTML artifacts only, not the Murmur app or any product UI you build.

## Progress Dashboard (multi-phase orchestrators, Murmur sessions)

While Murmur mode is active, for any task that runs as a multi-phase orchestrator with named phases or gates (3 or more distinct phases, or any work routed through a project orchestrator like `flutter-widget-builder` or `feature-orchestrator`), surface progress through one of two routes, decided by capability. Both routes render live in Murmur (the Workflows panel and the Progress panel respectively), so the user sees the run either way.

1. **Dynamic workflow (preferred when available).** If the `Workflow` tool is in your available tools and the work is genuinely decomposable (parallel phases, fan-out, independent agents), author and run a dynamic Workflow. Its `meta.phases` are the phases, and it renders live in Murmur's Workflows panel automatically. No `TaskCreate` or dashboard re-emit is needed on this route.
   - **Model rule: never run dynamic workflow agents on Fable. Always pass `model: 'opus'` on every `agent()` call in a Workflow script** (do not rely on inheritance from the main loop, which may be Fable).

2. **Internal progress dashboard (fallback).** If the `Workflow` tool is not available to you (you are a sub-agent, or multi-agent orchestration was not opted into) or the work is sequential single-context, follow the `progress-dashboard` skill: load it via `Skill`, `TaskCreate` every phase and gate up front, and re-emit the dashboard at every transition. It renders in Murmur's Progress panel.

Try the workflow route first. If you cannot call `Workflow`, fall back to the dashboard. Never leave a multi-phase run as prose-only.

Do not apply this to single-step tasks, ad-hoc edits, or simple questions. The dashboard ritual is for runs the human needs to track across phases, not every conversation.
