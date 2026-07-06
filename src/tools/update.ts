import { store, type RowStatus } from "../state.js";

const VALID_STATUSES: RowStatus[] = ["pending", "in_progress", "completed", "failed"];

export const dashboardUpdateTool = {
  name: "murmur_update",
  description: "Update one progress row's status and optional detail.",
  inputSchema: {
    type: "object" as const,
    required: ["row", "status"],
    properties: {
      row: { type: "string" },
      status: { type: "string", enum: VALID_STATUSES },
      detail: { type: "string" },
    },
  },
  async handler(args: { row: string; status: RowStatus; detail?: string }) {
    if (!VALID_STATUSES.includes(args.status)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `invalid status: ${args.status}`,
          },
        ],
        isError: true,
      };
    }
    const ok = store.updateRow(args.row, args.status, args.detail);
    if (ok) {
      return { content: [{ type: "text" as const, text: "" }] };
    }
    return {
      content: [
        { type: "text" as const, text: `row not found: ${args.row}` },
      ],
      isError: true,
    };
  },
};
