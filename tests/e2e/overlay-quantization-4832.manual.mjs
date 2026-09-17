/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome check for issue #4832: colour overlays (chart buckets, lens,
// IDS) must paint on EVERY surface of a model wider than the ~64 m lattice
// range. Not a CI test: it needs real WebGPU. It loads a >64 m fixture,
// screenshots the plain model, registers an overlay layer that colours every
// element cyan or magenta by expressId parity (spatially unclustered, like a
// chart bucket), screenshots again, and counts painted pixels. Run it once
// against a renderer dist built from main and once from the fix branch:
// the painted-pixel count is the before/after evidence.
//
// With `pnpm exec vite --port 5199` up in apps/viewer (rebuild
// `pnpm --filter @ifc-lite/renderer build` first — the viewer imports dist):
//   node tests/e2e/overlay-quantization-4832.manual.mjs
// Env: WALKTHROUGH_BASE (default http://localhost:5199), WALKTHROUGH_OUT
// (default <tmp>/ifc-lite-4832), TAG (screenshot prefix, default "run"),
// FIXTURE (path under tests/models, served via Vite's /@fs/; default
// ara3d/FM_ARC_DigitalHub.ifc — fetch with `node scripts/fixtures/fetch-fixtures.mjs <path>`),
// MODEL_URL (any same-origin URL, overrides FIXTURE), QUANTIZED=0 to
// reproduce the maintainer's console-flag workaround.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// FIXTURE = path under tests/models (default: a >64 m office building). Kept
// relative on purpose: an absolute /@fs/ URL in an env var gets rewritten by
// MSYS path conversion on Windows and the viewer then refuses it as cross-origin.
const FIXTURE = join(REPO, 'tests', 'models', process.env.FIXTURE ?? 'ara3d/FM_ARC_DigitalHub.ifc');
const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-4832');
mkdirSync(OUT, { recursive: true });
const TAG = process.env.TAG ?? 'run';
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5199';
const MODEL_URL = process.env.MODEL_URL ?? `/@fs/${FIXTURE.replace(/\\/g, '/')}`;
const log = (...a) => console.log('[4832]', ...a);

if (!process.env.MODEL_URL && !existsSync(FIXTURE)) {
  console.error(`fixture missing: ${FIXTURE} — run: node scripts/fixtures/fetch-fixtures.mjs ${process.env.FIXTURE ?? 'ara3d/FM_ARC_DigitalHub.ifc'}`);
  process.exit(2);
}

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const consoleHits = [];
page.on('console', (m) => { const t = m.text(); if (/4832|quantiz/i.test(t) || m.type() === 'error') consoleHits.push(`${m.type()}: ${t}`); });
page.on('pageerror', (e) => consoleHits.push(`pageerror: ${e}`));
if (process.env.QUANTIZED === '0') {
  await page.addInitScript(() => { globalThis.__IFC_LITE_QUANTIZED = 0; });
  log('quantization DISABLED via __IFC_LITE_QUANTIZED = 0');
}

const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const shot = async (name) => { const p = join(OUT, `${TAG}-${name}.png`); const buf = await page.screenshot({ path: p }); log('shot', p); return buf; };

/**
 * Pixel stats inside the WebGPU canvas rect, decoded in-page (no node PNG
 * dependency). `geometry` = pixels of the BASE shot that differ from the
 * background (sampled at the canvas corner); `painted` = geometry pixels the
 * overlay shot changed. Coverage = painted / geometry.
 */
const pixelStats = (basePng, overlayPng, rect) => page.evaluate(async ({ a, b, r }) => {
  const decode = async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return { px: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width };
  };
  const base = await decode(a);
  const over = b ? await decode(b) : null;
  const x0 = Math.floor(r.x) + 8, y0 = Math.floor(r.y) + 8, x1 = Math.floor(r.x + r.width) - 8, y1 = Math.floor(r.y + r.height) - 8;
  const at = (d, x, y) => { const i = (y * d.w + x) * 4; return [d.px[i], d.px[i + 1], d.px[i + 2]]; };
  const bg = at(base, x0 + 4, y0 + 4);
  const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  let geometry = 0, painted = 0, cyan = 0, magenta = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = at(base, x, y);
      if (dist(p, bg) <= 30) continue;
      geometry++;
      if (!over) continue;
      const q = at(over, x, y);
      if (dist(p, q) > 40) painted++;
      // Shading scales both strong channels; the odd channel stays well below.
      if (q[1] > 60 && q[2] > 60 && q[0] < 0.7 * Math.min(q[1], q[2])) cyan++;
      else if (q[0] > 60 && q[2] > 60 && q[1] < 0.7 * Math.min(q[0], q[2])) magenta++;
    }
  }
  return { background: bg, geometry, painted, coverage: geometry ? +(painted / geometry).toFixed(4) : null, cyan, magenta };
}, { a: basePng.toString('base64'), b: overlayPng ? overlayPng.toString('base64') : null, r: rect });

/** World AABB extent of the loaded flat geometry (origin + positions), metres. */
const modelExtent = () => state(`(() => {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const m of s.geometryResult.meshes) {
    const o = m.origin ?? [0, 0, 0]; const p = m.positions;
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = p[i + k] + o[k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v;
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => +v.toFixed(2));
})()`);

await page.goto(`${BASE}/?model=${encodeURIComponent(MODEL_URL)}`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 300000 });
// Let streaming finalize and the camera settle before the baseline shot.
await page.waitForTimeout(10000);
const meshCount = await state('s.geometryResult?.meshes?.length');
const ids = await state('[...new Set(s.geometryResult.meshes.map((m) => m.expressId))]');
const extent = await modelExtent();
log('model loaded: meshes', meshCount, 'unique entities', ids.length, 'extent (m)', extent);
if (Math.max(...extent) <= 64) log('WARNING: model extent <= 64 m — this is a CONTROL, it cannot reproduce #4832');
const rect = await page.locator('canvas').first().boundingBox();
const base = await shot('01-base');

// Colour EVERY element by expressId parity — no spatial locality, like a
// chart bucket — so each overlay colour group spans the whole model.
await page.evaluate(({ k }) => {
  const s = globalThis[k].getState();
  const overrides = new Map();
  for (const m of s.geometryResult.meshes) overrides.set(m.expressId, m.expressId % 2 ? [1, 0, 1, 1] : [0, 1, 1, 1]);
  s.registerOverlayLayer({ id: 'e2e-4832', priority: 50, hiddenIds: null, colorOverrides: overrides });
}, { k: STORE });
await page.waitForTimeout(4000);
const overlay = await shot('02-overlay');

const stats = await pixelStats(base, overlay, rect);
const result = { tag: TAG, model: MODEL_URL, meshCount, entities: ids.length, extentMetres: extent, ...stats, consoleHits };
log(JSON.stringify(result, null, 2));
writeFileSync(join(OUT, `${TAG}-result.json`), JSON.stringify(result, null, 2));
await browser.close();
