import { useCallback, useEffect, useRef, useState } from "react";
import { permissionIntent } from "@/lib/event-intent";
import type {
  PendingPermission,
  PendingQuestion,
} from "./useDashboardState";
import type { StuckWarning } from "./useStuckDetection";

const KEY_BROWSER = "murmur.notify.browser";
const KEY_PUSH = "murmur.notify.push";
// Legacy single-toggle key (pre-channel chooser): seeds both channels so users
// who had alerts on/off keep that preference on first load.
const LEGACY_KEY = "murmur.notifications.enabled";

export interface UseNotificationsResult {
  permission: NotificationPermission;
  supported: boolean;
  /** True when any channel is active — drives the bell icon's on/off look. */
  enabled: boolean;
  channels: { browser: boolean; push: boolean; native: boolean };
  nativeSupported: boolean;
  /** In-page Notification toasts. Requests permission when turning on. */
  setBrowser: (on: boolean) => Promise<void>;
  /** Background (service-worker) notifications; survive tab throttling. */
  setPush: (on: boolean) => Promise<void>;
  /** Native macOS modal; round-trips through the server. */
  setNative: (on: boolean) => Promise<void>;
}

export interface NotificationSources {
  pendingQuestion: PendingQuestion | null;
  pendingPermission: PendingPermission | null;
  lastWarning: string | null;
  stuckWarnings: StuckWarning[];
  // Server-reported native-alert state. Held server-side (not in localStorage)
  // so the toggle reflects the live truth and survives browser reloads; it
  // resets to the MURMUR_MAC_MODAL env default if the MCP server restarts.
  nativeAlerts: boolean;
  nativeSupported: boolean;
}

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
}

// The background (service-worker) channel pref, shared with the fleet view's
// alert menu so both surfaces read and write the same switch.
export function readBackgroundPushPref(): boolean {
  return readBool(KEY_PUSH, readBool(LEGACY_KEY, true));
}

export function writeBackgroundPushPref(on: boolean): void {
  writeBool(KEY_PUSH, on);
  syncPushPrefToSW(on);
}

// Tell the service worker whether background push is allowed, so it can gate
// its own showNotification calls.
export function syncPushPrefToSW(push: boolean): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    navigator.serviceWorker.ready
      .then((reg) => {
        (reg.active || reg.waiting || reg.installing)?.postMessage({
          type: "prefs",
          push,
        });
      })
      .catch(() => {});
  } catch {
    // best-effort
  }
}

export function useNotifications(
  sources: NotificationSources
): UseNotificationsResult {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [permission, setPermission] = useState<NotificationPermission>(
    supported ? Notification.permission : "denied"
  );

  // The legacy single-toggle default is only meaningful at mount (it seeds the
  // initial channel state and is the fallback in the storage handler). Read it
  // once instead of on every render, and keep it stable so the storage effect
  // does not re-subscribe.
  const legacyDefaultRef = useRef<boolean>(readBool(LEGACY_KEY, true));
  const legacyDefault = legacyDefaultRef.current;
  const [browser, setBrowserState] = useState<boolean>(() =>
    readBool(KEY_BROWSER, legacyDefault)
  );
  const [push, setPushState] = useState<boolean>(() =>
    readBool(KEY_PUSH, legacyDefault)
  );

  const lastQuestionIdRef = useRef<string | null>(null);
  const lastPermissionIdRef = useRef<string | null>(null);
  const lastWarningRef = useRef<string | null>(null);
  const seenStuckRef = useRef<Set<string>>(new Set());
  const autoRequestedRef = useRef<boolean>(false);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    if (permission === "granted") return true;
    if (permission === "denied") return false;
    const result = await Notification.requestPermission();
    setPermission(result);
    return result === "granted";
  }, [supported, permission]);

  const setBrowser = useCallback(
    async (on: boolean) => {
      if (on && !(await requestPermission())) return;
      setBrowserState(on);
      writeBool(KEY_BROWSER, on);
    },
    [requestPermission]
  );

  const setPush = useCallback(
    async (on: boolean) => {
      if (on && !(await requestPermission())) return;
      setPushState(on);
      writeBool(KEY_PUSH, on);
      syncPushPrefToSW(on);
    },
    [requestPermission]
  );

  const setNative = useCallback(async (on: boolean) => {
    try {
      await fetch("/api/alerts/native", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: on }),
      });
    } catch {
      // best-effort; the next state snapshot reflects the server's truth
    }
  }, []);

  // Keep the SW's push pref in sync on mount and whenever it changes.
  useEffect(() => {
    syncPushPrefToSW(push);
  }, [push]);

  // Cross-tab sync. localStorage is shared, but each tab's in-memory toggle
  // state is frozen at mount, so turning a channel off in one tab left other
  // open tabs still firing it. The `storage` event fires in the OTHER tabs when
  // any tab writes the pref, so adopt the new value here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === KEY_BROWSER) {
        setBrowserState(readBool(KEY_BROWSER, legacyDefault));
      } else if (e.key === KEY_PUSH) {
        const next = readBool(KEY_PUSH, legacyDefault);
        setPushState(next);
        syncPushPrefToSW(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // legacyDefault is read once (legacyDefaultRef) and never changes, so the
    // listener only needs to be wired on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default-on: if neither channel was explicitly disabled and permission has
  // never been asked, request it once on first mount.
  useEffect(() => {
    if (!supported) return;
    if (autoRequestedRef.current) return;
    autoRequestedRef.current = true;
    if (!browser && !push) return;
    if (permission !== "default") return;
    void Notification.requestPermission().then(setPermission);
  }, [supported, browser, push, permission]);

  // In-page notification (the "browser" channel). Background delivery is the
  // SW's job (the "push" channel); both share a tag so the OS shows one.
  const fire = useCallback(
    (title: string, body: string, tag: string) => {
      if (!supported || !browser || permission !== "granted") return;
      try {
        const n = new Notification(title, {
          body,
          tag,
          icon: "/favicon.svg",
          requireInteraction: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        // best-effort
      }
    },
    [supported, browser, permission]
  );

  // Pending question
  useEffect(() => {
    const q = sources.pendingQuestion;
    if (!q) {
      lastQuestionIdRef.current = null;
      return;
    }
    if (lastQuestionIdRef.current === q.questionId) return;
    lastQuestionIdRef.current = q.questionId;
    fire(
      q.header ? `Claude · ${q.header}` : "Claude is waiting for an answer",
      q.question,
      q.questionId
    );
  }, [sources.pendingQuestion, fire]);

  // Pending permission — body reads as semantic intent via permissionIntent,
  // with the raw command on the second line.
  useEffect(() => {
    const p = sources.pendingPermission;
    if (!p) {
      lastPermissionIdRef.current = null;
      return;
    }
    if (lastPermissionIdRef.current === p.permissionId) return;
    lastPermissionIdRef.current = p.permissionId;
    const intent = permissionIntent(p.tool, p.command).headline;
    const rawShort = p.command.length > 140 ? p.command.slice(0, 140) + "…" : p.command;
    const body = `${intent}\n${rawShort}`;
    fire(`Allow ${p.tool}?`, body, p.permissionId);
  }, [sources.pendingPermission, fire]);

  // Warnings (mirror.sh stream warnings via SSE)
  useEffect(() => {
    const w = sources.lastWarning;
    if (!w) {
      lastWarningRef.current = null;
      return;
    }
    if (lastWarningRef.current === w) return;
    lastWarningRef.current = w;
    fire("Murmur · warning", w, `warn:${w.slice(0, 64)}`);
  }, [sources.lastWarning, fire]);

  // Stuck-detector warnings
  useEffect(() => {
    for (const w of sources.stuckWarnings) {
      const tag =
        w.kind === "row-stalled"
          ? `stuck:row-stalled:${w.label}`
          : `stuck:loop:${w.command}`;
      const body =
        w.kind === "row-stalled"
          ? `${w.label} has been in progress for ${Math.round(w.sinceMs / 60_000)} min`
          : `Loop detected: ${w.command} (${w.count} runs in ${Math.round(w.windowMs / 1_000)}s)`;
      if (seenStuckRef.current.has(tag)) continue;
      seenStuckRef.current.add(tag);
      fire("Murmur · stuck", body, tag);
    }
    if (seenStuckRef.current.size > 100) {
      const arr = Array.from(seenStuckRef.current);
      seenStuckRef.current = new Set(arr.slice(arr.length - 100));
    }
  }, [sources.stuckWarnings, fire]);

  const native = sources.nativeAlerts;
  const enabled =
    (supported && permission === "granted" && (browser || push)) || native;

  return {
    permission,
    supported,
    enabled,
    channels: { browser, push, native },
    nativeSupported: sources.nativeSupported,
    setBrowser,
    setPush,
    setNative,
  };
}
