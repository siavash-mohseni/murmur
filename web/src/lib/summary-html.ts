// Shim: the summary builder moved server-side (src/export/) in Phase 3 so the
// session server, the hub, and the CLI render the same document as the Share
// button. Web call sites keep this import path.
export * from "../../../src/export/summary-html";
