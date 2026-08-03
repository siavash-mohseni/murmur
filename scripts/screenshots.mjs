#!/usr/bin/env node
// screenshots.mjs: retake the README screenshots against live local Murmur
// pages through headless Chrome's DevTools protocol. No dependencies: Node's
// global WebSocket and fetch drive CDP directly.
//
// Usage:
//   node scripts/screenshots.mjs [shot ...]
//
// Env:
//   MURMUR_SHOT_MAIN  session key for the wide shots (rows, activity, a workflow)
//   MURMUR_SHOT_A     session key with a pending permission
//   MURMUR_SHOT_B     session key with a pending question and a live workflow
//   MURMUR_HUB        hub origin (default http://127.0.0.1:4747)
//
// Each shot renders at deviceScaleFactor 2, so a 1440-wide viewport lands a
// 2880-wide PNG. Element shots clip to the element's box plus padding.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "screenshots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HUB = process.env.MURMUR_HUB || "http://127.0.0.1:4747";
const MAIN = process.env.MURMUR_SHOT_MAIN || "";
const A = process.env.MURMUR_SHOT_A || "";
const B = process.env.MURMUR_SHOT_B || "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page helpers injected before each stage script. waitFor polls for a
// selector, rectOf returns a padded clip box clamped to the viewport.
const PAGE_HELPERS = `
  window.__waitFor = (sel, ms = 8000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const el = document.querySelector(sel);
      if (el) return resolve(el);
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout: " + sel));
      setTimeout(tick, 100);
    };
    tick();
  });
  // Clip boxes are in document coordinates and paired with
  // captureBeyondViewport, so a target below the fold needs no scrolling.
  window.__box = (el, pad = 12) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, r.left + window.scrollX - pad),
      y: Math.max(0, r.top + window.scrollY - pad),
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    };
  };
  // The modal card inside its full-screen dimming overlay.
  window.__modalCard = () => document.querySelector('[role="dialog"]')?.firstElementChild ?? null;
  window.__frame = (pad = 24) => {
    const el = document.querySelector('#root [class*="max-w-"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left + window.scrollX - pad);
    return {
      x,
      y: 0,
      width: Math.min(document.documentElement.clientWidth - x, r.width + pad * 2),
      height: window.innerHeight,
    };
  };
  window.__panel = (title) =>
    [...document.querySelectorAll(".panel")].find((p) => {
      const h = p.querySelector(".panel-header");
      return h && h.textContent.trim().startsWith(title);
    }) ?? null;
  // The Workflows block is embedded in the Progress panel, so it has a label
  // rather than a panel header of its own.
  window.__workflowBlock = () => {
    const label = [...document.querySelectorAll("span")].find(
      (n) => n.textContent.trim() === "Workflows"
    );
    return label ? label.parentElement.parentElement : null;
  };
`;



// stage runs in the page after load and settle. It must resolve to null (full
// viewport) or a {x,y,width,height} clip in CSS pixels.
const SHOTS = [
  {
    name: "hero",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 1080, view: "operator",
    stage: `await __waitFor(".panel"); return __frame()`,
  },
  {
    name: "operator-view",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 1315, view: "operator",
    stage: `await __waitFor(".panel"); return __frame()`,
  },
  {
    name: "owner-view",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 1310, view: "owner",
    stage: `await __waitFor("main, .panel, h1"); return __frame()`,
  },
  {
    name: "question-modal",
    url: `${HUB}/s/${B}`,
    width: 1440, height: 900, view: "operator",
    stage: `await __waitFor('[role="dialog"]'); return __box(__modalCard(), 16)`,
  },
  {
    name: "permission-modal",
    url: `${HUB}/s/${A}`,
    width: 1440, height: 900, view: "operator",
    stage: `await __waitFor('[role="dialog"]'); return __box(__modalCard(), 16)`,
  },
  {
    name: "alerts-channels",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 900, view: "operator",
    stage: `
      const bell = await __waitFor('button[title="Choose alert channels"]');
      bell.click();
      const menu = await __waitFor('[role="menu"]');
      return __box(menu, 10)`,
  },
  {
    name: "progress-panel",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 1000, view: "operator",
    stage: `await __waitFor(".panel"); return __box(__panel("Progress"))`,
  },
  {
    name: "workflows-panel",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 1000, view: "operator",
    stage: `await __waitFor(".panel"); return __box(__workflowBlock())`,
  },
  {
    name: "fleet-home",
    url: `${HUB}/`,
    width: 1440, height: 760, view: "operator",
    stage: `await __waitFor("main, h1"); return __frame()`,
  },
  {
    name: "fleet-needs-you",
    url: `${HUB}/`,
    width: 390, height: 844, view: "operator", mobile: true,
    stage: `await __waitFor("main, h1"); return null`,
  },
  {
    name: "session-switcher",
    url: `${HUB}/s/${MAIN}`,
    width: 1440, height: 900, view: "operator",
    stage: `
      const btns = [...document.querySelectorAll("header button")];
      const trigger = btns.find((b) => b.getAttribute("aria-haspopup") === "listbox");
      trigger.click();
      const list = await __waitFor('[role="listbox"]');
      const a = __box(trigger, 12);
      const b = __box(list, 12);
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      return { x, y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y };`,
  },
];



// --- minimal CDP client ---------------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  waitEvent(method, sessionId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l);
        reject(new Error(`timeout waiting ${method}`));
      }, timeoutMs);
      const l = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          this.listeners.delete(l);
          resolve(msg.params);
        }
      };
      this.listeners.add(l);
    });
  }
}

async function main() {
  const only = process.argv.slice(2);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  if (!MAIN) throw new Error("MURMUR_SHOT_MAIN is required");

  const profile = mkdtempSync(join(tmpdir(), "murmur-shots-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "about:blank",
  ], { stdio: "ignore" });

  let wsUrl = "";
  for (let i = 0; i < 50 && !wsUrl; i++) {
    await sleep(200);
    try {
      const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      const list = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      wsUrl = list.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
  }
  if (!wsUrl) throw new Error("Chrome DevTools endpoint never came up");

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  const cdp = new Cdp(ws);

  for (const shot of shots) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Browser.grantPermissions", {
      origin: new URL(shot.url).origin,
      permissions: ["notifications"],
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 2,
      mobile: Boolean(shot.mobile),
    }, sessionId);
    // Prime prefs before the app boots: view mode, and mute the permission
    // auto-request so headless never shows a permission-denied banner.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try {
        localStorage.setItem("murmur.view", ${JSON.stringify(shot.view)});
        localStorage.setItem("murmur.notify.browser", "1");
        localStorage.setItem("murmur.notify.push", "1");
      } catch {}`,
    }, sessionId);
    const loaded = cdp.waitEvent("Page.loadEventFired", sessionId);
    await cdp.send("Page.navigate", { url: shot.url }, sessionId);
    await loaded;
    await sleep(1600); // SSE snapshot + first paint settle

    const clipEval = await cdp.send("Runtime.evaluate", {
      expression: `(async () => { ${PAGE_HELPERS}; return await ${wrap(shot.stage)} })()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (clipEval.exceptionDetails) {
      const detail = clipEval.exceptionDetails.exception?.description ?? clipEval.exceptionDetails.text;
      throw new Error(`${shot.name}: stage failed: ${detail}`);
    }
    const clip = clipEval.result?.value ?? null;
    await sleep(250);

    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
    }, sessionId);
    writeFileSync(join(OUT, `${shot.name}.png`), Buffer.from(data, "base64"));
    console.log(`shot ${shot.name}.png${clip ? ` (clip ${Math.round(clip.width)}x${Math.round(clip.height)})` : ""}`);
    await cdp.send("Target.closeTarget", { targetId });
  }

  ws.close();
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}

// A stage is an async function body that returns the clip (or null).
function wrap(stage) {
  return `(async () => { ${stage} })()`;
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
