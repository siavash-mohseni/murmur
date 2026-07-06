// Murmur Service Worker.
//
// Why this exists: page-side `new Notification(...)` calls don't reliably
// fire when the tab is in the background (Chrome aggressively throttles JS
// in backgrounded tabs, and the page's EventSource may stall). A Service
// Worker keeps its own EventSource open on `/events`, runs independently of
// the page, and uses `registration.showNotification(...)` which the browser
// honours from background.
//
// Bump SW_VERSION on any behavioural change so you can confirm in DevTools
// (Application > Service Workers, or the console log below) that the browser
// has actually picked up the new worker and isn't still running an old one.
const SW_VERSION = "2026-07-04-pager";

self.addEventListener("install", () => {
  // Activate immediately; we don't need the old SW to drain first.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("[Murmur SW] activate — version", SW_VERSION);
  event.waitUntil(
    caches
      .open(PREF_CACHE)
      .then((cache) => cache.put(ACTIVE_VERSION_URL, new Response(SW_VERSION)))
      .catch(() => {})
      .then(() => self.clients.claim())
      .then(() => connect())
  );
});

let es = null;
let lastQuestionId = null;
let lastPermissionId = null;
// Fleet (hub-origin) dedupe: one seen-id per session key, since the hub's
// stream carries every session's pending prompts in each frame.
const fleetLastQuestion = new Map();
const fleetLastPermission = new Map();
// Routine-notification feed: ids we've already accounted for, so each entry
// fires at most once. Seeded from the first state we see (baseline) so existing
// history is never replayed as a toast on (re)start.
const seenNotifIds = new Set();
let notifBaselineDone = false;

// Background-push preference, set by the page's alert chooser.
//
// This MUST be durable. The browser terminates and restarts the worker freely
// (idle-kill), which reruns this module top-to-bottom and would reset an
// in-memory flag back to its default, replaying notifications for a channel
// the user had turned off (e.g. a Chrome toast popping next to the native
// macOS alert). So we persist the pref in the Cache API (service workers can't
// touch localStorage) and reload it on every (re)start.
//
// Default OFF until the persisted value loads or the page tells us, so a
// freshly-restarted worker never fires a channel the user disabled. The page
// re-sends the real pref on mount, so the default-on experience is preserved.
const PREF_CACHE = "murmur-prefs";
const PREF_PUSH_URL = "/__murmur__/push-pref";
// The version of whichever worker most recently activated. A worker that finds
// a NEWER version here knows it has been superseded and self-terminates — this
// is what stops an old worker from lingering as a zombie (its open EventSource
// otherwise keeps it alive and firing past `unregister()`, since unregister
// removes the registration but can't stop a running worker holding a fetch).
const ACTIVE_VERSION_URL = "/__murmur__/active-version";
let pushEnabled = false;
let superseded = false;

async function isSuperseded() {
  try {
    const cache = await caches.open(PREF_CACHE);
    const res = await cache.match(ACTIVE_VERSION_URL);
    if (!res) return false;
    const v = await res.text();
    return v.length > 0 && v !== SW_VERSION;
  } catch {
    return false;
  }
}

async function loadPushPref() {
  try {
    const cache = await caches.open(PREF_CACHE);
    const res = await cache.match(PREF_PUSH_URL);
    if (res) pushEnabled = (await res.text()) === "1";
  } catch {
    // keep the current (default-off) value on failure
  }
}

async function savePushPref(on) {
  pushEnabled = on;
  try {
    const cache = await caches.open(PREF_CACHE);
    await cache.put(PREF_PUSH_URL, new Response(on ? "1" : "0"));
  } catch {
    // best-effort; the in-memory flag still reflects the latest pref
  }
}

// Load the persisted pref as soon as the worker (re)starts. handleState awaits
// this before deciding whether to show, so the startup race can't fire a
// disabled channel.
const prefReady = loadPushPref();

let reconnectTimer = null;

function connect() {
  // A superseded worker must not reopen its stream — that's how it stays a
  // zombie. Let it wind down instead.
  if (superseded) return;
  // readyState 2 === CLOSED: the stream is dead and must be rebuilt. Only a
  // CONNECTING (0) or OPEN (1) stream is "already connected" and left alone.
  if (es && es.readyState !== 2) {
    console.log("[Murmur SW] connect: already connected");
    return;
  }
  if (es) {
    try { es.close(); } catch {}
    es = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    es = new EventSource("/events");
    console.log("[Murmur SW] EventSource opened");
  } catch (err) {
    console.error("[Murmur SW] EventSource failed:", err);
    es = null;
    scheduleReconnect();
    return;
  }
  es.addEventListener("state", (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    const state = payload && payload.state;
    if (!state) return;
    handleState(state);
  });
  // Hub origin: the stream carries fleet frames instead of state frames, so
  // background push keeps working when the dashboard is served by the hub.
  es.addEventListener("fleet", (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    const fleet = payload && payload.fleet;
    if (!fleet || !Array.isArray(fleet.sessions)) return;
    handleFleet(fleet);
  });
  es.addEventListener("error", () => {
    // A transient drop leaves the stream CONNECTING and the browser retries on
    // its own. A CLOSED stream means it gave up (e.g. the server restarted), so
    // rebuild it ourselves — this is what lets background push survive a server
    // bounce or network blip without waiting for the page to re-prime us.
    if (!es || es.readyState === 2) {
      if (es) { try { es.close(); } catch {} es = null; }
      scheduleReconnect();
    }
  });
}

// Reconnect with a small fixed delay. Timers only run while the worker is
// alive; if the browser has terminated us, the page's keepalive ping restarts
// the worker and calls connect() again, so this only needs to cover the
// stay-alive case.
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// True when a Murmur browser tab is open AND focused/visible. The worker is
// the *background* channel, so when the user is looking right at the dashboard
// the page's own in-tab channel owns the alert. Deferring here is what stops a
// worker notification from firing next to the native/in-tab one while the tab
// is focused — independent of the push pref or any stale worker state.
async function aVisibleClientExists() {
  try {
    const cls = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    return cls.some((c) => c.visibilityState === "visible" || c.focused);
  } catch {
    return false;
  }
}

async function handleState(state) {
  // A newer worker has activated → this one is obsolete. Close our stream and
  // go silent so we don't double-fire alongside the current worker. This is the
  // self-eviction that keeps an old worker from lingering as a zombie.
  if (await isSuperseded()) {
    superseded = true;
    if (es) { try { es.close(); } catch {} es = null; }
    console.log("[Murmur SW] superseded — shutting down", SW_VERSION);
    return;
  }
  // Wait for the persisted pref before deciding whether to show, so a worker
  // that just restarted doesn't fire on its (default-off) flag prematurely.
  await prefReady;

  const pq = state.pendingQuestion;
  const pp = state.pendingPermission;
  const qId = pq && pq.questionId ? pq.questionId : null;
  const pId = pp && pp.permissionId ? pp.permissionId : null;
  const notifs = Array.isArray(state.notifications) ? state.notifications : [];

  const tabVisible = await aVisibleClientExists();
  // Questions and permissions have an in-tab channel, so when a tab is focused
  // (or push is off) the worker defers to it and just advances the seen-ids so
  // the prompt isn't replayed the moment the channel/visibility flips.
  const suppressPrompts = !pushEnabled || tabVisible;
  if (suppressPrompts) {
    lastQuestionId = qId;
    lastPermissionId = pId;
  } else {
    if (qId && qId !== lastQuestionId) {
      lastQuestionId = qId;
      showQuestion(pq);
    } else if (!pq) {
      lastQuestionId = null;
    }
    if (pId && pId !== lastPermissionId) {
      lastPermissionId = pId;
      showPermission(pp);
    } else if (!pp) {
      lastPermissionId = null;
    }
  }

  // Routine notifications. Unlike questions/permissions they have NO in-tab
  // toast channel (the page only lists them in its inbox), so a focused tab must
  // NOT mark them seen — that would swallow the entry and it would never fire as
  // a background push once the tab loses focus. The first state we process is
  // the baseline: record its ids without firing so opening Murmur doesn't replay
  // the backlog. After that, each new unread entry fires one push — unless a tab
  // is focused (leave it unseen so it fires when focus is lost) or push is off
  // (mark it seen so turning push on later doesn't flood).
  if (!notifBaselineDone) {
    for (const n of notifs) if (n && n.id) seenNotifIds.add(n.id);
    notifBaselineDone = true;
  } else {
    for (const n of notifs) {
      if (!n || !n.id || seenNotifIds.has(n.id)) continue;
      if (pushEnabled && tabVisible) continue; // defer; keep unseen until unfocused
      seenNotifIds.add(n.id);
      if (pushEnabled && !n.read) showRoutineNotification(n);
    }
  }
}

// Fleet counterpart of handleState: same supersede/pref/visibility gates, then
// per-session question/permission dedupe. Notifications deep-link to the
// session's drill-down route so a click lands on the right dashboard.
async function handleFleet(fleet) {
  if (await isSuperseded()) {
    superseded = true;
    if (es) { try { es.close(); } catch {} es = null; }
    console.log("[Murmur SW] superseded — shutting down", SW_VERSION);
    return;
  }
  await prefReady;
  const tabVisible = await aVisibleClientExists();
  const suppressPrompts = !pushEnabled || tabVisible;
  const liveKeys = new Set();
  for (const s of fleet.sessions) {
    if (!s || !s.key) continue;
    liveKeys.add(s.key);
    const pq = s.pendingQuestion;
    const pp = s.pendingPermission;
    const qId = pq && pq.questionId ? pq.questionId : null;
    const pId = pp && pp.permissionId ? pp.permissionId : null;
    const label = s.title || s.cwdBasename || s.key.slice(0, 8);
    if (suppressPrompts) {
      if (qId) fleetLastQuestion.set(s.key, qId);
      else fleetLastQuestion.delete(s.key);
      if (pId) fleetLastPermission.set(s.key, pId);
      else fleetLastPermission.delete(s.key);
      continue;
    }
    if (qId && qId !== fleetLastQuestion.get(s.key)) {
      fleetLastQuestion.set(s.key, qId);
      showQuestion(pq, { label, url: `/s/${s.key}` });
    } else if (!pq) {
      fleetLastQuestion.delete(s.key);
    }
    if (pId && pId !== fleetLastPermission.get(s.key)) {
      fleetLastPermission.set(s.key, pId);
      showPermission(pp, { label, url: `/s/${s.key}` });
    } else if (!pp) {
      fleetLastPermission.delete(s.key);
    }
  }
  for (const key of Array.from(fleetLastQuestion.keys())) {
    if (!liveKeys.has(key)) fleetLastQuestion.delete(key);
  }
  for (const key of Array.from(fleetLastPermission.keys())) {
    if (!liveKeys.has(key)) fleetLastPermission.delete(key);
  }
}

function showQuestion(pq, ctx) {
  const prefix = ctx && ctx.label ? `${ctx.label} · ` : "";
  const title = pq.header ? `${prefix}Claude · ${pq.header}` : `${prefix}Claude is waiting for an answer`;
  console.log("[Murmur SW] showQuestion:", title, "tag=", pq.questionId);
  self.registration
    .showNotification(title, {
      body: pq.question || "",
      tag: pq.questionId,
      icon: "/favicon.svg",
      requireInteraction: true,
      data: ctx && ctx.url ? { url: ctx.url } : undefined,
    })
    .then(() => console.log("[Murmur SW] question notification shown"))
    .catch((err) => console.error("[Murmur SW] showNotification failed:", err));
}

function showPermission(pp, ctx) {
  const cmd = pp.command || "";
  const body = cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd;
  const prefix = ctx && ctx.label ? `${ctx.label} · ` : "";
  console.log("[Murmur SW] showPermission:", pp.tool, "tag=", pp.permissionId);
  self.registration
    .showNotification(`${prefix}Permission · ${pp.tool || "Bash"}`, {
      body,
      tag: pp.permissionId,
      icon: "/favicon.svg",
      requireInteraction: true,
      data: ctx && ctx.url ? { url: ctx.url } : undefined,
    })
    .then(() => console.log("[Murmur SW] permission notification shown"))
    .catch((err) => console.error("[Murmur SW] showNotification failed:", err));
}

// Routine-notification toast. Unlike questions/permissions these are
// informational (no requireInteraction), and clicking opens the entry's link.
function showRoutineNotification(n) {
  const body = (n.body || "").slice(0, 220);
  console.log("[Murmur SW] showRoutineNotification:", n.title, "tag=", n.id);
  self.registration
    .showNotification(n.title || "Murmur", {
      body,
      tag: n.id,
      icon: "/favicon.svg",
      data: { url: n.link || "/" },
    })
    .catch((err) => console.error("[Murmur SW] showNotification failed:", err));
}

// --- Web Push (the pager channel) -------------------------------------------
//
// Real push from the hub: arrives through the browser's push service, so it
// fires with every Murmur tab closed and the browser in the background. This
// is deliberately NOT gated by the pushEnabled pref or tab visibility: the
// pref governs the SSE fallback channel above, while a push subscription is
// its own explicit opt-in (made from the fleet view's alert menu) and exists
// precisely for the moments no tab can fire. Tags match the SSE channel's
// (questionId/permissionId), so if both channels race, the OS shows one.
self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  if (!data) return;
  event.waitUntil(handlePushMessage(data));
});

async function handlePushMessage(data) {
  // The prompt was answered somewhere else: clear the lock-screen alert so
  // its Allow/Deny buttons don't linger pointing at a resolved permission.
  if (data.kind === "resolve" && data.tag) {
    const shown = await self.registration.getNotifications({ tag: data.tag });
    for (const n of shown) n.close();
    return;
  }
  if (data.kind === "permission") {
    return self.registration.showNotification(data.title || "Permission requested", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-72.png",
      requireInteraction: true,
      actions: [
        { action: "allow", title: "Allow" },
        { action: "deny", title: "Deny" },
      ],
      data: {
        url: data.url || "/",
        kind: "permission",
        key: data.key,
        permissionId: data.permissionId,
      },
    });
  }
  return self.registration.showNotification(data.title || "Murmur", {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    requireInteraction: data.kind === "question",
    data: { url: data.url || "/" },
  });
}

function base64UrlToUint8(base64url) {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Push services rotate subscriptions occasionally; re-subscribe and re-register
// with the hub so the pager survives without a manual re-pair.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cfg = await (await fetch("/api/push/config")).json();
        if (!cfg.publicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8(cfg.publicKey),
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      } catch {
        // best-effort; the next manual toggle re-pairs
      }
    })()
  );
});

// Clicking a notification opens its link (routine notifications carry one),
// otherwise focuses an open Murmur tab or opens the dashboard. The Allow and
// Deny actions on a permission push answer it directly from the lock screen,
// through the hub proxy, without opening the app at all.
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  if (event.action === "allow" || event.action === "deny") {
    event.notification.close();
    const decision = event.action === "allow" ? "allow" : "deny";
    event.waitUntil(
      fetch(`/s/${data.key}/api/permission/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionId: data.permissionId, decision }),
      }).catch(() =>
        // Couldn't answer headlessly (hub unreachable, cookie expired):
        // fall back to opening the dashboard on the right session.
        self.clients.openWindow(data.url || "/")
      )
    );
    return;
  }
  event.notification.close();
  const url = data.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // For an external link (a PR, a digest), open it directly.
      if (url && url !== "/") return self.clients.openWindow(url);
      for (const c of clients) {
        if (c.url.includes(self.location.origin)) return c.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});

// Page can re-prime the SW after a navigation, and set the push preference.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === "connect") connect();
  if (data.type === "prefs" && typeof data.push === "boolean") {
    // Persist so the pref survives the next SW restart, not just this session.
    event.waitUntil(savePushPref(data.push));
  }
  // Version handshake: the page pings the controlling worker on load to find
  // out if it's a current build. Pre-guard workers lack this reply, so the
  // page's silence-detector evicts them. Reply over the MessageChannel port if
  // one was transferred, else broadcast to all clients.
  if (data.type === "ping-version") {
    const reply = { type: "sw-version", version: SW_VERSION };
    if (event.ports && event.ports[0]) {
      event.ports[0].postMessage(reply);
    } else {
      void self.clients
        .matchAll({ includeUncontrolled: true })
        .then((cls) => cls.forEach((c) => c.postMessage(reply)));
    }
  }
});
