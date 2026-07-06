import { openInBrowser } from "../browser-open.js";
import { DEFAULT_PORT } from "../constants.js";
import { ensureHttpServer } from "../server-lifecycle.js";
import { store, SESSION_KEY } from "../state.js";
import { preferredDashboardUrl } from "../hub-client.js";

export const dashboardOpenTool = {
  name: "murmur_open",
  description: "Open the Murmur browser surface for this session. Returns the URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      port: { type: "number" },
      open: { type: "boolean" },
    },
  },
  async handler(args: { port?: number; open?: boolean }) {
    const port = args.port ?? DEFAULT_PORT;
    try {
      const { port: boundPort } = await ensureHttpServer(port);
      // Prefer the hub's drill-down route when a hub is alive: same session
      // view, but the fleet home is one click away and the origin is stable.
      const url = await preferredDashboardUrl(SESSION_KEY, boundPort);
      // Skip the launch when a tab is already connected (e.g. MURMUR_AUTO
      // opened one, or the user kept theirs from earlier): re-activating
      // Murmur must never stack duplicate tabs on the same session.
      const shouldOpen = args.open !== false && store.clientCount() === 0;
      if (shouldOpen) {
        openInBrowser(url);
      }
      return {
        content: [{ type: "text" as const, text: url }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: message }],
        isError: true,
      };
    }
  },
};
