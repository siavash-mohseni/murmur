import { store } from "../state.js";

export const dashboardLogTool = {
  name: "murmur_log",
  description: "Append a status line to the Murmur activity feed.",
  inputSchema: {
    type: "object" as const,
    required: ["message"],
    properties: {
      message: { type: "string" },
    },
  },
  async handler(args: { message: string }) {
    store.appendLog(args.message);
    return { content: [{ type: "text" as const, text: "" }] };
  },
};
