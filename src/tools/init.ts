import { store } from "../state.js";

export const dashboardInitTool = {
  name: "murmur_init",
  description: "Seed Murmur with a new run of progress rows. Each call starts a separate run that is appended (it does NOT replace earlier runs), so several dashboards can coexist in one session without mixing. Pass an optional title to name the run. Call once at the start of each multi-phase run.",
  inputSchema: {
    type: "object" as const,
    required: ["rows"],
    properties: {
      rows: { type: "array", items: { type: "string" } },
      title: { type: "string" },
    },
  },
  async handler(args: { rows: string[]; title?: string }) {
    store.initRows(args.rows, args.title);
    return { content: [{ type: "text" as const, text: "" }] };
  },
};
