#!/usr/bin/env node
import { execSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { dashboardOpenTool } from "./tools/open.js";
import { ensureHttpServer, pruneDeadPortFiles } from "./server-lifecycle.js";
import { dashboardInitTool } from "./tools/init.js";
import { dashboardUpdateTool } from "./tools/update.js";
import { dashboardLogTool } from "./tools/log.js";
import { dashboardAskTool } from "./tools/ask.js";
import { store, initServerRuntime } from "./state.js";
import { DEFAULT_PORT } from "./constants.js";
import { startWorkflowMirror } from "./workflow-mirror.js";
import { startAgentsMirror } from "./agents-mirror.js";
import { ensureHub } from "./hub-client.js";

/**
 * Parse OTEL_RESOURCE_ATTRIBUTES ("key1=val1,key2=val2") into a record so the
 * dashboard can show custom usage dimensions (team, repo, …) as session chips.
 */
function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  handler(args: Record<string, unknown>): Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
}

const tools: Tool[] = [
  dashboardOpenTool,
  dashboardInitTool,
  dashboardUpdateTool,
  dashboardLogTool,
  dashboardAskTool,
] as Tool[];

const server = new Server(
  { name: "murmur", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: `tool not found: ${name}` }) }],
      isError: true,
    };
  }
  return tool.handler((args ?? {}) as Record<string, unknown>);
});

function flagValue(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1]!;
  }
  return fallback;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

async function main(): Promise<void> {
  // Resolve session identity (the PID/exec walk + orphan scan that used to run
  // at import) and load the per-session state from disk, before the HTTP server
  // or any tool reads store state. No-op when CLAUDE_CODE_SESSION_ID is set.
  initServerRuntime();

  const argv = process.argv.slice(2);
  const port = parseInt(flagValue(argv, "--port", String(DEFAULT_PORT)), 10);
  const autoStart = !hasFlag(argv, "--no-murmur");

  // Opt-in env probe: dump any Claude-related env vars so we can tell whether
  // the harness exposes a per-MCP-child session id. Gated behind
  // MURMUR_DEBUG_ENV because it otherwise runs on every ephemeral MCP child
  // Claude spawns (`claude mcp list`, etc.) and just produces stderr noise.
  if (process.env["MURMUR_DEBUG_ENV"]) {
    const claudeEnv = Object.entries(process.env)
      .filter(([k]) => /CLAUDE|SESSION|ANTHROPIC/i.test(k))
      .map(([k, v]) => `${k}=${(v ?? "").slice(0, 80)}`);
    console.error(`murmur env probe: ${JSON.stringify(claudeEnv)}`);
    console.error(`murmur ppid=${process.ppid} pid=${process.pid}`);
  }

  if (autoStart) {
    try {
      const { port: boundPort } = await ensureHttpServer(port);
      console.error(`Murmur listening on http://127.0.0.1:${boundPort}/`);
      // Sweep orphaned port files from servers that crashed without cleanup.
      // Fire-and-forget so it never delays startup; our own freshly-bound port
      // is live and within the grace window, so it's never pruned.
      void pruneDeadPortFiles()
        .then((n) => {
          if (n > 0) console.error(`Murmur pruned ${n} stale port file(s)`);
        })
        .catch(() => {});
      // Make sure the machine's hub is up (fleet home + session proxy).
      // Fire-and-forget: the hub is an enhancement, never a boot dependency.
      void ensureHub()
        .then((hubPort) => {
          if (hubPort) console.error(`Murmur hub on http://127.0.0.1:${hubPort}/`);
        })
        .catch(() => {});
    } catch (err) {
      console.error(`Murmur failed to bind ${port}+: ${(err as Error).message}`);
    }
  }

  // Re-read ~/.claude/sessions/<parentPid>.json every 5s in case Claude
  // rewrites its sessionId mid-process (e.g. on /resume). Without this the
  // MCP freezes on the first sessionId it ever saw and the dashboard cannot
  // find the right transcript.
  store.startSessionIdPolling();

  // Mirror this session's Claude Code dynamic-workflow runs into the dashboard
  // (read-only, alongside the murmur_update progress). Self-contained 5s poll.
  startWorkflowMirror(store);

  // Mirror all live Claude Code sessions on the box (`claude agents --json`),
  // including what a waiting session is blocked on. Self-contained 6s poll.
  startAgentsMirror(store);

  // Custom usage dimensions for this session (team, repo, …) from
  // OTEL_RESOURCE_ATTRIBUTES, surfaced as session chips.
  store.setResourceAttributes(parseResourceAttributes(process.env["OTEL_RESOURCE_ATTRIBUTES"]));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Murmur MCP server running on stdio");

  // Tie the MCP child's lifetime to the parent Claude Code session.
  // - SIGINT/TERM/HUP → exit cleanly. Earlier-registered cleanup handlers
  //   (port-file removal) fire first because Node runs listeners in
  //   registration order.
  // - The HTTP server's heartbeat interval keeps the event loop alive, so
  //   we must call process.exit explicitly after handlers.
  // - We also watch the parent PID once a second. If it goes away (Claude
  //   Code crashed without SIGTERM), self-terminate. This is the belt-and-
  //   braces fallback for stuck orphan processes.
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`Murmur shutting down (${reason})`);
    // Persist any debounced-but-unflushed state synchronously before exit, so a
    // graceful shutdown keeps the durability the old per-mutation sync write had.
    store.flushSync();
    setImmediate(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // Parent-PID watchdog. Only enabled when the parent is actually a `claude`
  // process — otherwise a dev launch via `nohup &` (parent is a transient
  // bash shell) would immediately shut us down when bash exits.
  const initialPpid = process.ppid;
  let parentIsClaude = false;
  if (initialPpid > 1) {
    try {
      const cmd = execSync(`ps -p ${initialPpid} -o command=`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      parentIsClaude =
        /(^|\/)claude(\s|$)/.test(cmd) &&
        !cmd.includes("murmur/dist") &&
        !cmd.includes("nohup");
    } catch {
      // ps not available or other error — leave watchdog off.
    }
  }
  if (parentIsClaude) {
    const watchdog = setInterval(() => {
      try {
        process.kill(initialPpid, 0);
      } catch {
        clearInterval(watchdog);
        shutdown(`parent ${initialPpid} exited`);
      }
    }, 2_000);
    watchdog.unref();
    console.error(`murmur watchdog active for parent pid=${initialPpid}`);
  }
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
