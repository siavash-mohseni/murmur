// Pairing-token plumbing for the phone/LAN path. The QR encodes
// <hub-url>/#t=<token>: fragments never reach the server, so the unpaired
// phone can fetch the static shell, and this module then moves the token
// into a SameSite cookie that every subsequent request (fetch, EventSource,
// service-worker fetch, static asset) carries automatically. Loopback
// browsers never need any of this: the server trusts loopback callers.

const STORAGE_KEY = "murmur.token";

function setCookie(token: string): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `murmur_token=${token}; path=/; SameSite=Strict; max-age=31536000${secure}`;
}

/** Capture a pairing token from the URL fragment (if present) and re-assert
 * the cookie from localStorage on every load, so a cleared cookie jar heals
 * itself. Call before the app renders. */
export function initToken(): void {
  const m = location.hash.match(/[#&]t=([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      localStorage.setItem(STORAGE_KEY, m[1]);
    } catch {
      // private mode: the cookie alone still covers this visit
    }
    setCookie(m[1]);
    // Drop the token from the visible URL (and from anything that copies it).
    history.replaceState(null, "", location.pathname + location.search);
    return;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) setCookie(stored);
  } catch {
    // ignore
  }
}
