/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GPU driver for the modelling parity UI probes (#9296).
 *
 * It follows `tests/ui-scenes/capture.mjs`: serve a built viewer `dist/` with
 * `vite preview` (so the production COOP/COEP headers apply), connect to a
 * Chrome on the real GPU over CDP, fixed 1600x900 viewport at DPR 1, a fixed
 * start date, transitions frozen and the tour dismissed.
 *
 * What a modeller does goes through `session.ui`: pointer clicks on the canvas
 * at world points, clicks on named controls, and key presses. Each one counts
 * toward `metrics.actions`. The harness's own work (aiming the camera,
 * reading the store, exporting for an oracle) goes through `session.harness`
 * and is not counted. A product step the UI could not do and the probe did
 * through the store goes through `session.scripted`; it is listed in the
 * result and never counts as a UI pass.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VIEWPORT = { width: 1600, height: 900 };
const FREEZE_CSS = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }';

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

export async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}${lastError ? `: ${lastError.message}` : ''}`, { cause: lastError });
}

/** `vite preview` of a built dist on a free port, exactly as capture.mjs serves it. */
export function startPreview(root, dist) {
  const port = randomPort();
  const child = spawn('pnpm', ['--filter', '@ifc-lite/viewer', 'exec', 'vite', 'preview', '--outDir', dist,
    '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  return {
    url: `http://127.0.0.1:${port}`,
    log: () => log,
    stop() { try { process.kill(-child.pid); } catch (error) { if (error.code !== 'ESRCH') console.warn(`preview kill: ${error.message}`); } },
  };
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Convert IFC metres (x, y, z-up) to a client pixel on the 3D canvas. */
async function worldToScreen(page, p) {
  return page.evaluate(([x, y, z]) => {
    const m = globalThis.__ifc_lite_view_projection__();
    const c = document.querySelector('[data-testid=model-3d-panel] canvas').getBoundingClientRect();
    const wx = x; const wy = z; const wz = -y; // IFC Z-up -> viewer Y-up
    const cx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
    const cy = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
    const cw = m[3] * wx + m[7] * wy + m[11] * wz + m[15];
    return [c.x + (cx / cw * 0.5 + 0.5) * c.width, c.y + (1 - (cy / cw * 0.5 + 0.5)) * c.height];
  }, p);
}

const applyView = (page, pos, target) => page.evaluate(([pos, target]) => {
  const cb = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
  const cur = cb.getViewpoint();
  cb.applyViewpoint({ ...cur, position: { x: pos[0], y: pos[2], z: -pos[1] }, target: { x: target[0], y: target[2], z: -target[1] }, up: { x: 0, y: 1, z: 0 } }, false);
}, [pos, target]);
const viewMatrix = (page) => page.evaluate(() => globalThis.__ifc_lite_view_projection__());
const sameMatrix = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-5);

/**
 * A fresh page on the viewer with counters. `theme` is light or dark.
 * Returns the session object every probe and exercise drives.
 */
export async function openSession(browser, baseUrl, { theme = 'light', shotsDir, label = 'session' } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)));
  await page.clock.setSystemTime(new Date('2026-01-15T10:00:00Z'));
  await page.addInitScript(({ theme, css }) => {
    localStorage.setItem('ifc-lite-theme', theme);
    localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'modelling-parity');
    localStorage.setItem('ifc-lite:tours:v1', JSON.stringify({ inviteDismissedAt: '2026-01-01T00:00:00.000Z', tours: {} }));
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    });
    // Capture downloads: every viewer export ends in an <a download> click on a blob: or data: URL.
    // Bytes are kept as base64 so binary files (PDF) survive the trip out of the page.
    globalThis.__parity_downloads__ = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      if (this.download && /^(blob|data):/.test(this.href)) {
        const name = this.download;
        fetch(this.href).then((r) => r.blob()).then((blob) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ type: blob.type, b64: String(reader.result).split(',')[1] ?? '' });
          reader.readAsDataURL(blob);
        })).then(({ type, b64 }) => globalThis.__parity_downloads__.push({ name, type, b64 }));
        return undefined;
      }
      return original.call(this);
    };
  }, { theme, css: FREEZE_CSS });
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => !!globalThis.__ifc_lite_viewer_store__, undefined, { timeout: 120000 });

  const counters = { clicks: 0, keys: 0, cameraJumps: 0 };
  // The camera a probe pinned with harness.aim. The viewer may move the camera on its own
  // (for example reframing after a commit); each time it did, the pinned view is restored
  // before the next click and `cameraJumps` counts it as a UX finding.
  let pinned = null;

  /** Hover a world point and return its pixel once the projection is still. */
  const stablePixel = async (p, hoverMs) => {
    if (pinned && !sameMatrix(await viewMatrix(page), pinned.matrix)) {
      counters.cameraJumps++;
      await applyView(page, pinned.pos, pinned.target);
      await page.waitForTimeout(120);
      pinned.matrix = await viewMatrix(page);
    }
    let [x, y] = await worldToScreen(page, p);
    await page.mouse.move(x, y, { steps: 3 });
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(hoverMs);
      const [nx, ny] = await worldToScreen(page, p);
      if (Math.hypot(nx - x, ny - y) < 0.75) return [x, y];
      [x, y] = [nx, ny];
      await page.mouse.move(x, y, { steps: 1 });
    }
    throw new Error(`camera did not settle while aiming at ${JSON.stringify(p)}`);
  };
  const scriptedSteps = [];
  let shotN = 0;

  const settle = async (ms = 250) => {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(ms);
  };

  const state = (fn, arg) => page.evaluate(fn, arg);

  const ui = {
    /** Click a Playwright locator (a named control). */
    async click(locator, opts = {}) {
      await locator.click({ timeout: opts.timeout ?? 5000 });
      counters.clicks++;
      await settle(opts.settle ?? 150);
    },
    /** Click the 3D canvas at an IFC world point (pixel re-projected until the camera is still). */
    async clickWorld(p, opts = {}) {
      const [x, y] = await stablePixel(p, opts.hover ?? 120);
      // A held modifier (Alt: "ignore snaps and surfaces") is part of the one click.
      for (const m of opts.modifiers ?? []) await page.keyboard.down(m);
      await page.mouse.down();
      await page.mouse.up();
      for (const m of opts.modifiers ?? []) await page.keyboard.up(m);
      counters.clicks++;
      await page.waitForTimeout(opts.settle ?? 150);
      return [Math.round(x), Math.round(y)];
    },
    /** Click the canvas at a client pixel. */
    async clickPixel(x, y, opts = {}) {
      await page.mouse.move(x, y, { steps: 3 });
      await page.waitForTimeout(opts.hover ?? 120);
      await page.mouse.click(x, y, { modifiers: opts.modifiers });
      counters.clicks++;
      await page.waitForTimeout(opts.settle ?? 150);
    },
    /** Press, drag and release between two client pixels (one action). */
    async drag(from, to, opts = {}) {
      await page.mouse.move(from[0], from[1], { steps: 3 });
      await page.waitForTimeout(opts.hover ?? 120);
      await page.mouse.down();
      await page.mouse.move(to[0], to[1], { steps: opts.steps ?? 12 });
      await page.waitForTimeout(80);
      await page.mouse.up();
      counters.clicks++;
      await page.waitForTimeout(opts.settle ?? 200);
    },
    /** Move the pointer to a world point without clicking (hover feedback). Not an action. */
    async hoverWorld(p) {
      return stablePixel(p, 150);
    },
    /** One key or chord, e.g. `Escape`, `Control+Shift+V`. */
    async key(combo, opts = {}) {
      await page.keyboard.press(combo);
      counters.keys++;
      await page.waitForTimeout(opts.settle ?? 120);
    },
    /** Type text; each character is one action. */
    async type(text, opts = {}) {
      await page.keyboard.type(String(text), { delay: 25 });
      counters.keys += String(text).length;
      await page.waitForTimeout(opts.settle ?? 100);
    },
  };

  const session = {
    page,
    context,
    theme,
    label,
    pageErrors,
    counters,
    scriptedSteps,
    /** UX findings any helper noticed; probes and exercises add them to their notes. */
    findings: new Set(),
    ui,
    state,
    settle,
    worldToScreen: (p) => worldToScreen(page, p),
    /** Harness-only work: never counted as a user action. */
    harness: {
      /** Set the camera (IFC metres) and pin it; `pin: false` sets it once. */
      async aim(pos, target, { pin = true } = {}) {
        await applyView(page, pos, target);
        await settle(200);
        pinned = pin ? { pos, target, matrix: await viewMatrix(page) } : null;
      },
      unpin() { pinned = null; },
      async dismissToasts() {
        for (const button of await page.getByRole('button', { name: 'Dismiss notification' }).all()) {
          await button.click({ timeout: 1500 }).catch(() => {});
        }
      },
    },
    /** A product step done through the store because the UI could not. Listed in the result. */
    async scripted(name, fn) {
      scriptedSteps.push(name);
      return fn();
    },
    /** Screenshot to the shots dir; returns `{ file, sha256 }`. */
    async shot(name) {
      if (!shotsDir) return null;
      const file = `${label}-${String(++shotN).padStart(2, '0')}-${name}.${theme}.png`;
      const png = await page.screenshot();
      writeFileSync(join(shotsDir, file), png);
      return { file, sha256: sha256(png) };
    },
    async close() { await context.close().catch(() => {}); },
  };
  return session;
}

/**
 * Run one timed task inside a probe. Returns `{ name, ok, ms, actions, error? }`.
 * A task that throws is recorded, not rethrown, so a probe can report partial.
 */
export async function task(session, name, fn) {
  const before = session.counters.clicks + session.counters.keys;
  const t0 = Date.now();
  try {
    const value = await fn();
    return { name, ok: true, ms: Date.now() - t0, actions: session.counters.clicks + session.counters.keys - before, value };
  } catch (error) {
    return { name, ok: false, ms: Date.now() - t0, actions: session.counters.clicks + session.counters.keys - before, error: describeError(error) };
  }
}

/** First line of an error plus the locator Playwright was waiting for, if any. */
function describeError(error) {
  // eslint-disable-next-line no-control-regex -- strip Playwright's ANSI colour codes
  const lines = String(error.message ?? error).replace(/\u001b\[[0-9;]*m/g, '').split('\n');
  const waiting = lines.find((l) => /waiting for/.test(l))?.trim();
  return [lines[0], waiting].filter(Boolean).join(' | ').slice(0, 400);
}

/** Wait for a download after `before` captured ones; returns `{ name, type, bytes, text }`. */
export async function nextDownload(page, before, timeout = 60000) {
  await page.waitForFunction((n) => globalThis.__parity_downloads__.length > n, before, { timeout });
  const d = await page.evaluate(() => globalThis.__parity_downloads__.at(-1));
  const bytes = Buffer.from(d.b64, 'base64');
  return { name: d.name, type: d.type, bytes, text: bytes.toString('utf8') };
}

export const downloadCount = (page) => page.evaluate(() => globalThis.__parity_downloads__.length);

export function gitSource(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  return { commit, dirty };
}
