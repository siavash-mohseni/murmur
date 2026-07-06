import { useCallback, useEffect, useState } from "react";

// Real Web Push: the browser's push service wakes our service worker even
// with every Murmur tab closed, which is what makes the phone a pager. The
// hub holds the subscription and encrypts pager frames to it (RFC 8291).
//
// Browsers only grant PushManager in secure contexts, so this is available on
// http://localhost (the desktop) and on any https hub (e.g. a tailscale cert),
// but not over plain-http LAN. `supported` reflects exactly that.

function keyToBytes(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface UsePushResult {
  supported: boolean;
  subscribed: boolean;
  busy: boolean;
  /** Subscribe this device and register with the hub. False = denied/failed. */
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
}

export function usePush(): UsePushResult {
  const supported =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    window.isSecureContext;

  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (!cancelled) setSubscribed(sub !== null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    setBusy(true);
    try {
      if (Notification.permission !== "granted") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return false;
      }
      const cfgRes = await fetch("/api/push/config");
      if (!cfgRes.ok) return false;
      const cfg = (await cfgRes.json()) as { publicKey?: string };
      if (!cfg.publicKey) return false;
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          // Cast: TS's BufferSource wants an ArrayBuffer-backed view, which
          // this is, but Uint8Array only says ArrayBufferLike pre-es2024 libs.
          applicationServerKey: keyToBytes(cfg.publicKey) as BufferSource,
        }));
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) return false;
      setSubscribed(true);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const disable = useCallback(async (): Promise<void> => {
    if (!supported) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setSubscribed(false);
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { supported, subscribed, busy, enable, disable };
}
