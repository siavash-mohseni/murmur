---
name: progress-dashboard
description: |
  Make a multi-phase orchestrator surface its progress as a live dashboard the user sees from start to finish. Requires a TaskCreate call for every phase and gate before Step 1 of the orchestration, a TaskUpdate plus dashboard re-emit at every phase or gate transition, a mandatory close-out that drives every row to a terminal state before the run yields (so no phase is ever left hanging in progress), and treats omission as a gate failure. Triggers when an orchestrator with named phases or gates begins, and at every transition during the run.
license: Proprietary
metadata:
  author: siavash
  version: "1.2"
  platform: shared
dependencies: []
---

# Progress Dashboard

Make orchestrator progress visible the whole way through. The user should see the same dashboard at start, at every gate, and at the end, never as prose updates and never as silence.

## Route check (read first)

This skill is the **fallback** route for multi-phase progress. Before following the ritual below, check capability:

- If the `Workflow` tool is available to you and the work is genuinely decomposable (parallel phases, fan-out, independent agents), prefer a **dynamic Workflow** instead. Its `meta.phases` become the phases and it renders live in Murmur's Workflows panel automatically, with no `TaskCreate` or dashboard re-emit needed.
- Use the `TaskCreate` + dashboard ritual below only when you cannot run a Workflow: you are a sub-agent, the `Workflow` tool is not in your tools, multi-agent orchestration was not opted into, or the work is sequential single-context.

Either way the user sees the run in Murmur. Try the workflow route first, fall back to this dashboard if you cannot call `Workflow`.

## Context Scope

### Include
- The loading orchestrator's Progress Tracking section (the canonical list of phases and gates)
- The current state of those phases as the run advances

### Exclude
- Per-step debug output, tool results, or sub-agent transcripts (the dashboard is a high-signal summary, not a log)
- Project source files (the orchestrator handles those, this skill is only about visibility)

### Why This Matters
A multi-phase orchestrator that posts prose updates ("running tests now...", "moving on") leaves the user blind to overall progress and gate state. The user has flagged this regression before. A re-emitted dashboard at every transition is the single load-bearing artifact that keeps the run legible.

## Workflow

1. **Read the orchestrator's Progress Tracking list.** It is the source of truth for which rows belong on the dashboard.

2. **Before Step 1, call TaskCreate for every row.** One TaskCreate per phase item and per gate. Status `pending` on all. Subject should match the row text verbatim so the dashboard re-emit later is just a TaskList render. **Name the run by its goal:** set `metadata.murmurRun` on the FIRST TaskCreate to a short goal label (e.g. "Review PR 4617", "Tabs refactor"). Murmur uses it as the run's title instead of "Run N". If you omit it, Murmur falls back to the active skill name, then the first row's label.

3. **Emit the initial dashboard.** As a markdown table with columns Status, Phase / Gate, Detail. Status uses `⏳ pending`, `🔄 in_progress`, `✅ done`, `❌ failed`. Emit it as plain text to the user, not inside a tool result.

4. **On entering a phase or gate.** Call TaskUpdate on the matching row to `in_progress`, then re-emit the dashboard.

5. **On phase or gate completion.** Call TaskUpdate to `completed`, then re-emit the dashboard. **Marking a row failed:** the harness TaskUpdate status enum is `pending|in_progress|completed|deleted`: it has NO `failed`. To turn a row red, call the `mcp__murmur__murmur_update` tool with `{ row: "<exact subject>", status: "failed", detail: "<reason>" }`. Never use TaskUpdate `deleted` to signal failure: Murmur treats `deleted` as a no-op so a completed prior run is never flipped red. A conditional phase whose condition is not met (for example "if user confirmed" and they did not, or a step gated on external CI you will not wait for) still gets closed now: mark it `completed` with a detail saying why it did not run, such as "Skipped: user did not confirm". Reserve `failed` (via `murmur_update`) for the case where not running it is itself a problem. Never leave a not-taken branch sitting in `in_progress`.

6. **On gate failure.** Re-emit the dashboard with the gate row marked failed (via `mcp__murmur__murmur_update`, status `failed`), surface the failure detail to the user, stop the orchestration. Do not proceed to the next phase. Closing the run still applies: run the close-out in Step 7 so no earlier row is left open.

7. **Close out the run (mandatory final update).** The run is not finished while any row is still `pending` or `in_progress`. Before you end your turn, hand off, or move on to unrelated work, sweep every non-terminal row to a terminal state and then emit the final dashboard:
   - A phase that did its work: `completed` (TaskUpdate).
   - A phase or gate that failed: `failed` with the reason, via `mcp__murmur__murmur_update`.
   - A conditional or externally-gated phase you are not going to finish in this run: `completed` with a "Skipped: <reason>" detail (or `failed` via `murmur_update` if the skip is a problem).

   The last thing the user sees is the dashboard with every row terminal. This step is the guard against the most common defect: the final phase, especially a conditional or CI-gated one, left `in_progress` forever because the conversation drifted elsewhere before it was closed. If you are about to respond with anything other than a dashboard re-emit while a row is open, close the row first.

## Quality Checklist

- [ ] TaskCreate ran for every row in the orchestrator's Progress Tracking list before Step 1
- [ ] Initial dashboard was emitted to the user before any sub-agent dispatch
- [ ] Every phase or gate transition has a paired TaskUpdate plus dashboard re-emit (count of emits >= count of transitions)
- [ ] No phase advances past a failed gate
- [ ] When the run yields (success, failure, or a pivot to other work), zero rows are left `pending` or `in_progress`. Every row is `completed` or `failed`
- [ ] Conditional or externally-gated phases that did not run were closed with a `completed` "Skipped: <reason>" detail, not left open
- [ ] Final dashboard emit covers every row in a terminal state (`completed` or `failed`)
- [ ] No prose-only update replaced a dashboard re-emit at any transition

## Do Not

- End your turn, hand off, or pivot to unrelated work while any row is still `in_progress` or `pending`. Close every open row to a terminal state and emit the final dashboard first. A stranded `in_progress` row, almost always the last phase, is the dashboard's most visible failure.
- Leave a conditional phase ("if user confirmed", "if CI passes") open because its branch was not taken. Close it as `completed` with a "Skipped: <reason>" detail. The store never auto-closes a row, so whatever you leave open stays open forever.
- Skip the initial dashboard emit. The user must see the whole plan before the run begins. Otherwise they cannot judge scope or estimate time.
- Replace a dashboard re-emit with a prose sentence like "moving to Phase 3". The dashboard is the artifact, prose is not a substitute.
- Batch many transitions into a single re-emit. One transition, one re-emit. Batching hides which step advanced.
- TaskCreate rows lazily as phases start. The user needs the full list up front so the dashboard length stays stable.
- Cross a gate marked failed. Stop the run and ask the user how to proceed. Auto-recovery hides regressions.
- Use a different format per orchestrator. The same Status / Phase / Detail markdown table everywhere keeps the user's pattern-matching cheap.
- Hide the dashboard inside a `<details>` block or a tool result the user has to expand. It must be the visible top-level output at every transition.
