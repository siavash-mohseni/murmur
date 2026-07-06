import { randomUUID } from "node:crypto";
import { store, type PendingOption, type PendingQuestion } from "../state.js";

const DEFAULT_TIMEOUT_MS = 600_000;

export const dashboardAskTool = {
  name: "murmur_ask",
  description: "Ask the user a question via the Murmur browser pane. Same shape as AskUserQuestion. Blocks for the answer. Returns { ok, answer } or { ok: false, reason } — fall back to AskUserQuestion on ok=false.",
  inputSchema: {
    type: "object" as const,
    required: ["question", "options"],
    properties: {
      question: { type: "string" },
      header: { type: "string" },
      options: {
        type: "array",
        items: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string" },
            description: { type: "string" },
          },
        },
      },
      multiSelect: { type: "boolean" },
      timeoutMs: { type: "number" },
    },
  },
  async handler(args: {
    question: string;
    header?: string;
    options: PendingOption[];
    multiSelect?: boolean;
    timeoutMs?: number;
  }) {
    // Nobody can see the pane (no dashboard tab connected, native alerts off):
    // fail fast instead of blocking invisibly until the timeout. The caller
    // falls back to AskUserQuestion, and the question hook's watcher gate lets
    // that CLI prompt through.
    if (!store.hasWatchers()) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: false, reason: "no-watchers" }),
          },
        ],
        isError: true,
      };
    }
    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + timeoutMs).toISOString();
    const question: PendingQuestion = {
      questionId: randomUUID(),
      question: args.question,
      header: args.header,
      options: args.options,
      multiSelect: args.multiSelect ?? false,
      createdAt,
      expiresAt,
    };
    const result = await store.setPendingQuestion(question, timeoutMs);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result),
        },
      ],
      isError: !result.ok,
    };
  },
};
