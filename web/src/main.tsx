import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initToken } from "./lib/token";
import "./index.css";

// Adopt a pairing token from the URL fragment before anything fetches, so a
// phone's very first data request is already authenticated.
initToken();

// Evict a stale Service Worker before (re)registering. A pre-guard Murmur SW
// keeps firing a browser notification next to the native alert even when the
// in-tab/push channels are off, and it can outlive a normal update because its
// open EventSource keeps it alive. We can't fix that from the old SW's code, so
// the page detects it: ping the controller for its version, and if it stays
// silent (old SWs have no such reply), unregister everything and reload once so
// the fresh, focus-guarded worker takes over. Guarded by sessionStorage so it
// can never loop. Returns true when a reload was triggered.
async function evictStaleServiceWorker(): Promise<boolean> {
  if (sessionStorage.getItem("murmur.sw.evicted") === "1") return false;
  const regs = await navigator.serviceWorker.getRegistrations();
  if (regs.length === 0) return false; // nothing registered — the fresh register is current
  // Ping each registration's *active* worker (NOT navigator.serviceWorker.
  // controller, which is null on an uncontrolled page — the bug that let an old
  // worker keep firing). A current, guard-aware build replies; a pre-guard one
  // stays silent.
  const pingWorker = (worker: ServiceWorker | null): Promise<boolean> => {
    if (!worker) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const ch = new MessageChannel();
      const timer = window.setTimeout(() => resolve(false), 2000);
      ch.port1.onmessage = (e) => {
        window.clearTimeout(timer);
        resolve((e.data as { type?: string } | null)?.type === "sw-version");
      };
      try {
        worker.postMessage({ type: "ping-version" }, [ch.port2]);
      } catch {
        window.clearTimeout(timer);
        resolve(false);
      }
    });
  };
  const replies = await Promise.all(
    regs.map((r) => pingWorker(r.active || r.waiting || r.installing))
  );
  if (replies.some(Boolean)) return false; // a current worker is present
  // Every registered worker is stale (or unreachable): unregister all and reload
  // once so the fresh, focus-guarded worker takes over.
  sessionStorage.setItem("murmur.sw.evicted", "1");
  await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
  // eslint-disable-next-line no-console
  console.log("[Murmur] evicted a stale Service Worker — reloading for the fresh one");
  location.reload();
  return true;
}

// Register the Service Worker that handles background notifications.
// Page-side `new Notification(...)` doesn't reliably fire when the tab is
// throttled; the SW keeps its own SSE subscription and showNotification call
// alive in the background.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void evictStaleServiceWorker().then((reloading) => {
      if (reloading) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        // eslint-disable-next-line no-console
        console.log("[Murmur] SW registered. scope=", reg.scope);
        // Re-prime the worker: this reopens its EventSource. Crucially,
        // postMessage to a registered worker also *restarts* it if the browser
        // has idle-killed it, so a periodic ping is what keeps background push
        // alive across SW restarts for as long as a Murmur tab is open.
        const ping = (): void => {
          const sw =
            reg.active ||
            reg.waiting ||
            reg.installing ||
            navigator.serviceWorker.controller;
          sw?.postMessage({ type: "connect" });
        };
        ping();
        // Heartbeat backstop. Hidden tabs throttle timers to ~once/min, which
        // is fine: each ping that lands restarts a dead worker and reconnects
        // its stream. The events below cover the cases that matter most
        // (refocus, regained network) without waiting for the next tick.
        window.setInterval(ping, 20_000);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") ping();
        });
        window.addEventListener("focus", ping);
        window.addEventListener("pageshow", ping);
        window.addEventListener("online", ping);
        navigator.serviceWorker.addEventListener("controllerchange", ping);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[Murmur] SW registration failed:", err);
      });
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
