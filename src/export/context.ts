// Shared input shape for the HTML builders. Lives server-side (src/export/)
// so the session server, the hub, and the CLI can render the same documents
// the dashboard's Share buttons produce. Browser-safe: types only.

import type { ActivityImage, DashboardState, SessionSummary } from "../shared-types.js";

// The bundle of state both HTML builders need: the dashboard snapshot plus
// the cross-session metadata used to derive a session title.
export interface ShareContext {
  state: DashboardState | null;
  sessions: SessionSummary[];
  // When present, activity images are inlined into the document via this
  // resolver (the server and CLI return data: URIs read from the image
  // store). When absent, images are skipped: the browser builders would
  // otherwise emit relative /api/image URLs that break in a saved file.
  resolveImage?: (img: ActivityImage) => string | null;
}
