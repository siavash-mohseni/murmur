// Smoke test for the shared semantic-intent layer.
//
// Exercises bashIntent() against a representative set of commands and prints
// the headline + verb for each. Both the browser notification (web side) and
// the macOS modal alert (server side) read these exact strings, so a pass
// here means a pass on both surfaces.
//
// Run: bun run scripts/intent-smoke.ts

import { bashIntent } from "../src/intent.ts";

interface Case {
  command: string;
  /** Optional expected headline. If set, mismatch is reported as a fail. */
  expecting?: string;
}

const cases: Case[] = [
  // build / test / lint
  { command: "bun run build", expecting: "Built the project" },
  { command: "npm run dev", expecting: "Started the dev server" },
  { command: "bun test src/intent.test.ts" },
  { command: "tsc --noEmit", expecting: "Ran the TypeScript compiler" },

  // git
  { command: "git status", expecting: "Checked git status" },
  { command: "git log --oneline -20", expecting: "Read git history" },
  { command: 'git commit -m "feat: add summary"', expecting: "Created a git commit" },
  { command: "git push origin main", expecting: "Pushed to the remote" },
  { command: "git diff HEAD~1", expecting: "Read the git diff" },
  { command: "git stash pop", expecting: "Stashed working changes" },

  // search
  { command: 'grep -rn "useNotifications" src/', expecting: 'Searched for "useNotifications"' },
  { command: 'rg "bashIntent" --type ts', expecting: 'Searched for "bashIntent"' },
  { command: 'find . -name "*.test.ts"' },
  { command: "which bun", expecting: "Located the bun binary" },

  // listing / inspection
  { command: "ls -la /Users/jane/.claude/mcp-servers/murmur" },
  { command: "cat package.json", expecting: "Read package.json" },
  { command: "head -50 src/state.ts", expecting: "Read state.ts" },
  { command: "wc -l web/src/App.tsx", expecting: "Counted lines in App.tsx" },
  { command: "du -sh dist/", expecting: "Checked disk usage" },

  // file mutation
  { command: "mkdir -p src/lib" },
  { command: "rm /tmp/murmur-summary-preview.html", expecting: "Removed murmur-summary-preview.html" },
  { command: "mv src/old.ts src/new.ts", expecting: "Moved file(s)" },
  { command: "chmod +x scripts/smoke.ts", expecting: "Changed file permissions" },

  // network
  { command: "curl -sS https://api.github.com/repos/anthropics/claude-code", expecting: "Fetched api.github.com" },
  { command: "wget https://example.com/file.tar.gz", expecting: "Downloaded a file" },

  // scripting — the case that prompted this whole feature
  {
    command:
      "python3 << 'PYEOF'\nfrom pathlib import Path\np = Path('/Users/jane/.claude/mcp-servers/murmur/web/src/App.tsx')\ntext = p.read_text()\nPYEOF",
    expecting: "Read App.tsx via Python",
  },
  {
    command:
      'python3 -c "import re; print(re.sub(r\'foo\', \'bar\', open(\'src/state.ts\').read()))"',
  },
  {
    command:
      'bun -e \'await fetch("http://127.0.0.1:5173/state").then(r => r.json())\'',
    expecting: "Fetched the web via Bun",
  },
  {
    command:
      "node -e \"const fs = require('fs'); fs.writeFileSync('out.json', JSON.stringify({ok:true}))\"",
    expecting: "Wrote out.json via Node",
  },

  // pipelines — infer intent from source + final stage
  { command: 'grep "foo" file.ts | head -20', expecting: 'Searched for "foo"' },
  { command: "cat data.json | jq '.items[]'", expecting: "Extracted data from data.json" },
  { command: "ps aux | grep node", expecting: 'Searched the process list for "node"' },
  { command: "ls -la | grep test", expecting: 'Searched the file listing for "test"' },
  { command: 'find . -name "*.ts" | wc -l', expecting: "Counted matching files" },
  { command: "cat access.log | wc -l", expecting: "Counted lines in access.log" },
  { command: "git log --oneline | head -20", expecting: "Read git history" },
  { command: "curl -s https://api.github.com/repos/x | jq '.stars'", expecting: "Fetched api.github.com (parsed JSON)" },
  { command: "find . -name '*.tmp' | xargs rm", expecting: "Removed file(s)" },
  { command: "echo secret | pbcopy", expecting: "Copied output to the clipboard" },
  { command: "cat names.txt | sort | uniq", expecting: "Deduplicated names.txt" },

  // navigation + chains (the cd/jq case the user flagged)
  { command: "cd /Users/jane/.claude/mcp-servers/murmur", expecting: "Switched to the murmur directory" },
  { command: "cd app && npm run build", expecting: "Built the project" },
  { command: "mkdir -p src/lib && cd src/lib", expecting: "Created directory lib" },
  { command: "cd web && bun run build && cd ..", expecting: "Built the project" },
  // echo section-headers are scaffold: the real work wins, not the header print
  { command: 'echo "=== run sync ===" && bun run sync.ts', expecting: "Ran bun sync.ts" },
  // a path arg to `bun run` is shortened to its basename
  { command: "bun run .ai/scripts/sync-ai-infra.ts", expecting: "Ran bun sync-ai-infra.ts" },
  // azure cli + value-ranked stage selection: probe stages are skipped, and the
  // pipeline list (web) outranks the extension check (read), so the real intent wins
  { command: "az pipelines list --org X --project Platform -o table", expecting: "Listed Azure DevOps pipelines" },
  { command: "az extension show --name azure-devops", expecting: "Inspected the azure-devops extension" },
  { command: 'echo "=== probe ===" && az --version | head -1 && az extension show --name azure-devops | grep -i version && az pipelines list --org X --project Y -o table', expecting: "Listed Azure DevOps pipelines" },
  // a low-value inspection before real work: the build wins, not the pwd
  { command: "pwd && npm run build", expecting: "Built the project" },
  { command: 'cd app\necho "=== build ==="\nnpm run build', expecting: "Built the project" },
  { command: 'echo "step one"; echo "step two"', expecting: "Printed text" },
  { command: "FOO=bar npm test", expecting: "Ran the test suite" },
  { command: "export NODE_ENV=production", expecting: "Set an environment variable" },
  { command: "pwd", expecting: "Checked the current directory" },

  // data / text
  { command: "jq '.name' package.json", expecting: "Read data from package.json" },
  { command: 'jq -n "{ok: true}"', expecting: "Processed JSON data" },
  { command: "sed -i '' 's/foo/bar/' src/state.ts", expecting: "Edited state.ts" },
  { command: "awk '{print $1}' access.log", expecting: "Processed text" },
  { command: "sort names.txt", expecting: "Sorted lines" },
  { command: "diff a.ts b.ts", expecting: "Compared files" },

  // package / build / containers
  { command: "npm install", expecting: "Installed dependencies" },
  { command: "make build", expecting: "Built the build target" },
  { command: "cargo test", expecting: "Ran the test suite" },
  { command: "pip3 install requests", expecting: "Installed Python packages" },
  { command: "docker build -t app .", expecting: "Built a Docker image" },
  { command: "gh pr view 42", expecting: "Worked with a GitHub PR" },
  { command: "sudo rm -rf /tmp/cache", expecting: "Removed cache" },

  // shell control flow (the collapsed for-loop case that prompted this)
  { command: "f=/private/tmp/x/tasks/bf6tbipmj.output served=0 for i in 1 2 3", expecting: "Ran a loop" },
  { command: "for i in 1 2 3; do echo $i; done", expecting: "Printed text (in a loop)" },
  { command: "for f in src/*.ts; do tsc $f; done", expecting: "Ran the TypeScript compiler (in a loop)" },
  { command: "while true; do curl https://api.example.com/health; sleep 5; done", expecting: "Fetched api.example.com (in a loop)" },
  { command: 'if [ -f .env ]; then cat .env; fi', expecting: "Read .env (conditionally)" },
  { command: "case $x in a) echo hi;; esac", expecting: "Ran a conditional" },
  // loop body that assigns a command substitution — describe the script it runs,
  // not the leftover `--` after the assignment is stripped. secure_curl.sh is the
  // Jira/ADO REST wrapper, so projectToolIntent names the service + method (the
  // URL uses a `$key` variable, so there is no literal issue key to surface).
  {
    command:
      'for key in DEMO-101 DEMO-102; do\n  code=$(~/.claude/skills/jira/scripts/secure_curl.sh -- -s -o /dev/null -w "%{http_code}" -X PUT "https://example.atlassian.net/rest/api/3/issue/$key" -H "Content-Type: application/json" -d @/tmp/ac/$key.json)\ndone',
    expecting: "Updated the Jira API (PUT) (in a loop)",
  },
  { command: "out=$(git status --porcelain)", expecting: "Checked git status" },

  // subshell / group wrappers
  { command: "(cd /Users/jane/dev/app && git status)", expecting: "Checked git status" },
  { command: "(cd app && npm run build)", expecting: "Built the project" },
  { command: "(cd /tmp/work)", expecting: "Switched to the work directory" },
  { command: "{ tsc --noEmit; }", expecting: "Ran the TypeScript compiler" },

  // flutter / dart (mobile) + multi-line scripts
  { command: "cd /Users/jane/dev/demo/mobile/demo_app && flutter analyze --no-pub-get", expecting: "Analyzed the Flutter project" },
  { command: "cd mobile/demo_app\nflutter test", expecting: "Ran the test suite" },
  { command: "flutter build apk", expecting: "Built the app" },
  { command: "dart format lib/", expecting: "Formatted the code" },

  // edge cases
  { command: "" },
  { command: "echo hello", expecting: "Printed text" },
  { command: "obscure-binary --flag" },

  // --- bug fixes: quotes, dangling operators, redirects, heredoc-writes ---
  { command: 'SCRIPTS_DIR="$HOME/.claude/skills/ado-pr/scripts" && ls "$SCRIPTS_DIR"', expecting: "Listed $SCRIPTS_DIR" },
  { command: '"$HOME/.claude/skills/ado-pr/scripts/get_pr_info.sh" --help 2>&1 | head -40', expecting: "Read PR info" },
  { command: "ls .ai/skills/ 2>/dev/null", expecting: "Listed .ai/skills/" },
  { command: "git status 2>&1", expecting: "Checked git status" },
  { command: "grep -n foo bar.ts 2>/dev/null", expecting: "Searched the codebase" },
  { command: "cat > /tmp/note.txt << 'EOF'\nhello\nEOF", expecting: "Wrote note.txt" },
  { command: "echo hi > /tmp/out.log", expecting: "Wrote out.log" },
  { command: "cat /tmp/data/report.json", expecting: "Read report.json" },

  // --- project / skill toolchain ---
  {
    command: '~/.claude/skills/jira/scripts/secure_curl.sh -- -s -X GET "https://example.atlassian.net/rest/api/3/issue/DEMO-123"',
    expecting: "Read Jira issue DEMO-123",
  },
  {
    command: '~/.claude/skills/jira/scripts/secure_curl.sh -- -s -X GET "https://example.atlassian.net/rest/api/3/issue/DEMO-123/comment"',
    expecting: "Read DEMO-123 comments",
  },
  { command: "acli jira workitem view DEMO-123 --json -f summary,status", expecting: "Viewed Jira DEMO-123" },
  { command: "acli jira workitem comment list DEMO-123 --json", expecting: "Read DEMO-123 comments" },
  { command: "acli jira auth status 2>&1 | head -20", expecting: "Checked Jira auth" },
  { command: '"$HOME/.claude/skills/ado-pr/scripts/post_comment.sh" url 1 "looks good"', expecting: "Posted a PR comment" },
  { command: '"$HOME/.claude/skills/ado-pr/scripts/resolve_thread.sh" url 1', expecting: "Resolved a PR thread" },
  { command: "cd /Users/x/app && very_good test --exclude-tags=golden 2>&1 | tr '\\r' '\\n'", expecting: "Ran the test suite" },
  { command: 'keeper whoami 2>&1 || echo "no"', expecting: "Checked Keeper auth" },
  { command: "~/.claude/skills/pr-summary/scripts/collect-context.sh 2>&1", expecting: "Collected PR context" },

  // --- git global options before the subcommand ---
  { command: "git -c core.editor=true merge --continue", expecting: "Merged branches" },
  { command: "git --no-pager show origin/main:foo.yaml 2>&1 | head -30", expecting: "Inspected a git object" },
  { command: 'git -C /Users/x/repo log --oneline 2>/dev/null | head -20', expecting: "Read git history" },

  // --- flutter subcommands ---
  { command: "cd app && flutter gen-l10n 2>&1 | tail -5", expecting: "Generated localizations" },
  { command: "flutter --version 2>&1 | head -3", expecting: "Checked the Flutter version" },

  // --- loop / conditional keyword leakage ---
  { command: "cd forge for i in 1 2 3; do   very_good test ; done", expecting: "Ran the test suite" },
  { command: 'if ps -p 1 >/dev/null; then echo up; else echo gone; fi', expecting: "Printed text (conditionally)" },

  // --- shell / package-runner wrappers describe what they wrap ---
  { command: "bash ~/.claude/skills/dart-deslop/scripts/deslop.sh lib/ 2>&1 | tail -30", expecting: "Ran dart-deslop" },
  { command: "/bin/bash -c 'mkdir -p /tmp/x; echo done'", expecting: "Created directory x" },
  { command: 'bunx tsc --noEmit -p tsconfig.json 2>&1 | head -20', expecting: "Ran the TypeScript compiler" },
];

let asserted = 0;
let pass = 0;
let fail = 0;

console.log("=".repeat(120));
console.log("bashIntent() smoke — semantic headlines used by both notification surfaces");
console.log("=".repeat(120));

for (const c of cases) {
  const intent = bashIntent(c.command);
  const shown = c.command.replace(/\n/g, " ⏎ ");
  const truncShown = shown.length > 70 ? shown.slice(0, 67) + "..." : shown;
  const verb = `[${intent.verb}]`.padEnd(13);
  const head = intent.headline.padEnd(48);
  let mark = "  ";
  if (c.expecting) {
    asserted += 1;
    if (intent.headline === c.expecting) {
      mark = "OK";
      pass += 1;
    } else {
      mark = "!!";
      fail += 1;
    }
  }
  console.log(`${mark} ${head} ${verb}  ${truncShown || "(empty)"}`);
  if (c.expecting && intent.headline !== c.expecting) {
    console.log(`     expected: ${c.expecting}`);
  }
}

console.log("");
console.log(`Assertions: ${pass}/${asserted} pass, ${fail} fail.  Cases run: ${cases.length}.`);
process.exit(fail > 0 ? 1 : 0);
