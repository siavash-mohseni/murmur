import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ISOLATION: src/state.ts resolves the state directory from homedir() and the
// session identity from CLAUDE_CODE_SESSION_ID (with a PID-walk fallback that
// finds the parent Claude session) at import time. Run inside a live Claude
// session, an unisolated smoke run therefore adopts that session's identity
// and clobbers its state and port files (store.reset + setPort below), which
// severs the live mirror. In-process env mutation is not enough: bun resolves
// homedir() at process start and the PID walk ignores env entirely. So this
// script re-execs itself as a child with a fresh HOME and a synthetic session
// id set from birth, the same idiom as progress-run-smoke.ts.
if (!process.env["MURMUR_SMOKE_CHILD"]) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: {
      ...process.env,
      MURMUR_SMOKE_CHILD: "1",
      HOME: mkdtempSync(join(tmpdir(), "murmur-smoke-")),
      CLAUDE_CODE_SESSION_ID: randomUUID(),
      MURMUR_AGENTS_POLL: "0",
      MURMUR_HUB: "0",
    },
  });
  process.exit(result.status ?? 1);
}

const { startHttpServer } = await import("../src/http.js");
const { store } = await import("../src/state.js");
const { dashboardAskTool } = await import("../src/tools/ask.js");

const PORT = 5179;

async function postJson(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return res.json();
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`assertion failed: ${msg}`);
  }
}

async function main(): Promise<void> {
  const handle = await startHttpServer(store, PORT);
  store.reset();
  store.setPort(handle.port);

  console.log(`smoke: server up on ${handle.port}`);

  // 1. addRow via /sync
  await postJson("/sync", { type: "task-create", label: "smoke phase 1" });
  await postJson("/sync", { type: "task-create", label: "smoke phase 2" });
  const state1 = (await getJson("/state")) as { rows: { label: string }[] };
  assert(state1.rows.length === 2, "expected 2 rows after task-create x2");
  assert(state1.rows[0]!.label === "smoke phase 1", "row 0 label");
  console.log("ok: task-create mirrored");

  // 2. updateRow via /sync
  await postJson("/sync", {
    type: "task-update",
    label: "smoke phase 1",
    status: "in_progress",
  });
  const state2 = (await getJson("/state")) as { rows: { status: string }[] };
  assert(state2.rows[0]!.status === "in_progress", "row 0 status after update");
  console.log("ok: task-update mirrored");

  // 3. log via /sync
  await postJson("/sync", { type: "log", message: "smoke log entry" });
  const state3 = (await getJson("/state")) as {
    activities: { kind: string; message?: string }[];
  };
  const logActs = state3.activities.filter((a) => a.kind === "log");
  assert(logActs.length === 1, "expected 1 log activity");
  assert(logActs[0]!.message === "smoke log entry", "log message");
  console.log("ok: log mirrored");

  // 4. dashboard_ask round-trip
  const questionId = randomUUID();
  const askPromise = store.setPendingQuestion(
    {
      questionId,
      question: "Smoke question?",
      header: "Smoke",
      options: [{ label: "yes" }, { label: "no" }],
      multiSelect: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    },
    5_000
  );
  const answerRes = await postJson("/api/answer", { questionId, answer: "yes" });
  assert(answerRes.status === 200, "/api/answer status 200");
  const result = await askPromise;
  assert("ok" in result && result.ok === true, "ask result ok=true");
  assert("answer" in result && result.answer === "yes", "ask result answer=yes");
  console.log("ok: dashboard_ask round-trip");

  // 5. duplicate answer returns 409
  const dupId = randomUUID();
  const dupPromise = store.setPendingQuestion(
    {
      questionId: dupId,
      question: "Q",
      options: [{ label: "a" }],
      multiSelect: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    },
    5_000
  );
  await postJson("/api/answer", { questionId: dupId, answer: "a" });
  await dupPromise;
  const dup2 = await postJson("/api/answer", { questionId: dupId, answer: "a" });
  assert(dup2.status === 409, "duplicate answer status 409");
  console.log("ok: duplicate answer rejected");

  // 6. cancel
  const cancelId = randomUUID();
  const cancelPromise = store.setPendingQuestion(
    {
      questionId: cancelId,
      question: "Q",
      options: [{ label: "a" }],
      multiSelect: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    },
    5_000
  );
  await postJson("/api/cancel", { questionId: cancelId });
  const cancelResult = await cancelPromise;
  assert("ok" in cancelResult && cancelResult.ok === false, "cancel result ok=false");
  assert("reason" in cancelResult && cancelResult.reason === "cancelled", "cancel reason");
  console.log("ok: cancel");

  // 7. timeout
  const timeoutId = randomUUID();
  const timeoutPromise = store.setPendingQuestion(
    {
      questionId: timeoutId,
      question: "Q",
      options: [{ label: "a" }],
      multiSelect: false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 100).toISOString(),
    },
    100
  );
  const timeoutResult = await timeoutPromise;
  assert("ok" in timeoutResult && timeoutResult.ok === false, "timeout result ok=false");
  assert("reason" in timeoutResult && timeoutResult.reason === "timeout", "timeout reason");
  console.log("ok: timeout");

  // 8. one-shot AskUserQuestion fallback: only a failed murmur_ask (via the
  // tool, not bare setPendingQuestion) arms it, and consuming clears it.
  const consumeFallback = async (): Promise<boolean> => {
    const r = await postJson("/question/fallback", {});
    assert(r.status === 200, "/question/fallback status 200");
    return (r.json as { fallback: boolean }).fallback;
  };
  assert((await consumeFallback()) === false, "fallback unarmed before any murmur_ask");
  const noWatchers = await dashboardAskTool.handler({ question: "Q", options: [{ label: "a" }] });
  assert(noWatchers.isError === true, "no-watchers murmur_ask isError");
  assert((await consumeFallback()) === true, "failed murmur_ask arms the fallback");
  assert((await consumeFallback()) === false, "fallback is one-shot");
  console.log("ok: fallback armed by failed murmur_ask, one-shot consume");

  // 9. an answered murmur_ask leaves the fallback unarmed, and a mirrored
  // AskUserQuestion (/sync source "ask") clears a stale armed flag.
  const sseCtrl = new AbortController();
  const sse = await fetch(`http://127.0.0.1:${PORT}/events`, { signal: sseCtrl.signal });
  sse.body!.getReader().read().catch(() => {});
  const answeredPromise = dashboardAskTool.handler({
    question: "Q",
    options: [{ label: "yes" }],
    timeoutMs: 5_000,
  });
  assert(store.state.pendingQuestion !== null, "murmur_ask registered a pending question");
  await postJson("/api/answer", { questionId: store.state.pendingQuestion!.questionId, answer: "yes" });
  const answered = await answeredPromise;
  assert(answered.isError === false, "answered murmur_ask not an error");
  assert((await consumeFallback()) === false, "answered murmur_ask leaves fallback unarmed");
  const timedOutAsk = await dashboardAskTool.handler({
    question: "Q",
    options: [{ label: "a" }],
    timeoutMs: 100,
  });
  assert(timedOutAsk.isError === true, "timed-out murmur_ask isError");
  await postJson("/sync", { type: "prompt", source: "ask", question: "Q", ok: true });
  assert((await consumeFallback()) === false, "mirrored AskUserQuestion clears a stale armed flag");
  sseCtrl.abort();
  console.log("ok: answered ask disarms, mirrored AskUserQuestion clears stale flag");

  await handle.close();
  console.log("\nsmoke: all checks passed");
}

main()
  .then(() => {
    // Force the exit: startHttpServer's intervals (mirrors) keep the event
    // loop alive past handle.close(), and the parent spawnSync waits on us.
    process.exit(0);
  })
  .catch((err) => {
    console.error("smoke FAILED:", err);
    process.exit(1);
  });
