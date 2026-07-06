// Shared compile-time constants for the Murmur server.

// Default port each Claude Code session's Murmur HTTP listener prefers. Used by
// src/index.ts (the --port flag fallback) and src/tools/open.ts (the
// murmur_open args.port fallback). Shell scripts, install helpers, and
// web/scripts use the literal 5173 directly because they cannot import a TS
// constant.
export const DEFAULT_PORT = 5173;
