// Shared filesystem locations for the Murmur state tree. Import-safe from any
// server-side entry (session server, hub, scripts): no side effects beyond
// path derivation, so the hub can locate sessions without pulling in
// state.ts's import-time session-identity resolution.

import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(homedir(), ".claude", "state", "murmur");
export const SESSIONS_DIR = join(STATE_DIR, "sessions");

// The hub's port file. One hub per machine, so this lives at the STATE_DIR
// root next to the shared native-alert pref, not under sessions/.
export const HUB_PORT_FILE = join(STATE_DIR, "hub.port");
export const HUB_LOCK_FILE = join(STATE_DIR, "hub.lock");

// Default hub port. Deliberately outside the 5173+ walk the session servers
// use, so the hub never races a session bind. Override with MURMUR_HUB_PORT.
export const DEFAULT_HUB_PORT = 4747;

// Web Push subscriptions paired to this machine. Hub-owned (the hub is the
// per-machine surface that outlives sessions), persisted so a hub restart
// does not silently unsubscribe every phone.
export const PUSH_SUBS_FILE = join(STATE_DIR, "push-subscriptions.json");
