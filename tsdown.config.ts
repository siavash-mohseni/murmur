import { defineConfig } from "tsdown";

// clean is false because the Vite web build runs first (via `bun run build:web`)
// and writes to dist/web/. If tsdown cleared dist/, that bundle would be lost.
// The server entry point at dist/index.js is overwritten each build, so a stale
// dist/index.js is not a real risk.
//
// setup and uninstall are compiled to dist/ so the npm bins run them under
// plain Node (`npx murmur-mcp-install`): no Bun, jq, or curl on the user's
// machine. They bundle scripts/install-shared.ts into each output.
export default defineConfig([
  {
    entry: ["./src/index.ts", "./src/hub.ts"],
    dts: true,
    clean: false,
    format: "esm",
    external: ["@modelcontextprotocol/sdk"],
  },
  {
    entry: {
      setup: "./scripts/setup.ts",
      uninstall: "./scripts/uninstall.ts",
      "export-cli": "./src/export-cli.ts",
    },
    dts: false,
    clean: false,
    format: "esm",
  },
]);
