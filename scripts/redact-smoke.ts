// Smoke test for the PII redaction engine behind exports, receipts, hosted
// replays, and the browser Share buttons. Positive cases prove each rule
// fires. Negative cases prove the conservative guards hold on the content
// exports are actually full of: diffs, hashes, versions, timestamps, code.
//
// Run: bun run scripts/redact-smoke.ts

import {
  redactText,
  deriveNameTokens,
  redactShareContext,
} from "../src/export/redact.ts";
import type { DashboardState } from "../src/shared-types.ts";

let pass = 0;
let fail = 0;

function check(label: string, want: string, got: string): void {
  if (want === got) {
    pass++;
  } else {
    console.log(`!!  ${label}\n    want: ${JSON.stringify(want)}\n    got:  ${JSON.stringify(got)}`);
    fail++;
  }
}

function unchanged(label: string, input: string): void {
  check(label, input, redactText(input));
}

// --- credentials -------------------------------------------------------------

check(
  "anthropic key",
  "key=[redacted-key] set",
  redactText("key=sk-ant-api03-AbCdEf123456789012345 set")
);
check(
  "generic sk key",
  "[redacted-key]",
  redactText("sk-proj-abcdef1234567890XYZ")
);
check(
  "github token",
  "auth [redacted-key] done",
  redactText("auth ghp_AbCdEf1234567890AbCdEf123456 done")
);
check(
  "github fine-grained pat",
  "[redacted-key]",
  redactText("github_pat_11ABCDEFG0123456789_abcdef")
);
check("slack token", "[redacted-key]", redactText("xoxb-123456789012-abcdefABCDEF"));
check("aws access key id", "[redacted-key]", redactText("AKIAIOSFODNN7EXAMPLE"));
check(
  "google api key",
  "[redacted-key]",
  redactText("AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1v")
);
check(
  "jwt",
  "session [redacted-jwt]",
  redactText(
    "session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM"
  )
);
check(
  "bearer token",
  "authorization: Bearer [redacted-token]",
  redactText("authorization: Bearer abcdef1234567890abcdef")
);
check(
  "assigned api key",
  'api_key: "[redacted-secret]"',
  redactText('api_key: "abc123def456ghi"')
);
check(
  "assigned password",
  "password=[redacted-secret]",
  redactText("password=hunter2hunter22")
);
unchanged("code passing a password through a call", "password: hashPassword(input)");
unchanged("auth token built by a function", "auth_token = getAuthToken2()");

// --- emails and identity -----------------------------------------------------

check(
  "email",
  "contact [redacted-email] now",
  redactText("contact jane.doe+test@example.co.uk now")
);
unchanged("npm scoped package", "install @types/node and @vitejs/plugin-react");

check(
  "mac home dir",
  "read /Users/USER/dev/app/main.ts",
  redactText("read /Users/jane.doe/dev/app/main.ts")
);
check("linux home dir", "/home/USER/code", redactText("/home/jane/code"));
check(
  "windows home dir",
  "C:\\Users\\USER\\code",
  redactText("C:\\Users\\jane\\code")
);
check(
  "name token bare and slug forms",
  "USER edited -Users-USER-dev-app today",
  redactText("jane.doe edited -Users-jane-doe-dev-app today", ["jane.doe", "jane-doe"])
);

// --- network -----------------------------------------------------------------

check(
  "lan ip",
  "paired at http://[redacted-ip]:5173",
  redactText("paired at http://192.168.1.42:5173")
);
check("public ip", "[redacted-ip]", redactText("52.84.121.9"));
unchanged("loopback stays", "listening on 127.0.0.1:4747");
unchanged("unspecified address stays", "bind 0.0.0.0");
unchanged("netmask stays", "mask 255.255.255.0");
unchanged("version prefixed with v", "upgrade to v1.2.3.4");
unchanged("five dotted segments", "ip-ish 1.2.3.4.5 chain");

// --- card numbers ------------------------------------------------------------

check(
  "card spaced groups",
  "pay [redacted-card] now",
  redactText("pay 4111 1111 1111 1111 now")
);
check("card contiguous", "[redacted-card]", redactText("4111111111111111"));
unchanged("luhn-invalid number stays", "4111111111111112");
unchanged("epoch millis stays", "at 1751904000000 ms");
unchanged("uuid stays", "a1111111-1111-4111-8111-111111111111");
unchanged(
  "git sha stays",
  "commit 4a79aee95a6575d0e2ae3a1241474b2c9d0e1f2a"
);

// --- diffs and code shapes ---------------------------------------------------

unchanged("diff plus line with digits", "+1234567890\n-9876543210");
unchanged("plain sentence", "The build finished in 2.4s with 0 errors.");

// --- deriveNameTokens --------------------------------------------------------

const state = {
  sessionId: "s1",
  rows: [],
  activities: [
    {
      detail:
        "mailed jane.doe@corp.com from /Users/jane.doe/x with sk-ant-abcdef1234567890abc",
    },
    { detail: "slug -Users-jane-doe-dev-app on 10.0.0.7", count: 3 },
  ],
  pendingQuestion: null,
  pendingPermission: null,
  port: 5173,
  startedAt: "2026-07-10T10:00:00.000Z",
  sessionInfo: { cwd: "/Users/jane.doe/dev/app", cwdBasename: "app" },
  tokenStats: null,
  memoryEntries: [],
} as unknown as DashboardState;

const tokens = deriveNameTokens(state);
check("derived tokens", "jane.doe,jane-doe,jane", tokens.join(","));
check(
  "bare name segment in a command",
  "grep -oci USER src/",
  redactText("grep -oci jane src/", tokens)
);
check(
  "regex-escaped name form, segments under 4 chars stay",
  "match USER\\.doe there",
  redactText("match jane\\.doe there", tokens)
);

// --- redactShareContext ------------------------------------------------------

const resolveImage = (): string | null => "data:image/png;base64,AAAA";
const ctx = redactShareContext({
  state,
  sessions: [
    {
      key: "k1",
      port: 5173,
      url: "",
      current: true,
      alive: false,
      cwd: "/Users/jane.doe/dev/app",
      title: "jane.doe fixes login",
    },
  ] as unknown as Parameters<typeof redactShareContext>[0]["sessions"],
  resolveImage,
});

const acts = (ctx.state as DashboardState).activities as unknown as {
  detail: string;
  count?: number;
}[];
check(
  "state activity strings redacted",
  "mailed [redacted-email] from /Users/USER/x with [redacted-key]",
  acts[0]!.detail
);
check(
  "slug and ip redacted, numbers preserved",
  "slug -Users-USER-dev-app on [redacted-ip]",
  acts[1]!.detail
);
check("non-string values preserved", "3", String(acts[1]!.count));
check(
  "session summary redacted",
  "USER fixes login",
  (ctx.sessions[0] as { title?: string }).title ?? ""
);
check(
  "cwd redacted",
  "/Users/USER/dev/app",
  (ctx.state as DashboardState).sessionInfo.cwd ?? ""
);
check(
  "resolveImage passes through",
  "data:image/png;base64,AAAA",
  ctx.resolveImage?.({ url: "/api/image/x.png" } as never) ?? ""
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
