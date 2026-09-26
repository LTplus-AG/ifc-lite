/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough for #5547: a two-finger touch pinch toward a thin
// pipe stops short of it instead of passing through. On the opening view of
// buildingsmart/Infra-Plumbing.ifc it finds a screen point where an exact
// raycast hits an IfcPipeSegment, then dispatches two-finger TouchEvents at
// the viewport canvas (the listener useTouchControls registers) as repeated
// zoom-in pinches centred there. After each pinch it prints the camera
// position and how many of that pipe's faces a raycast still hits on screen:
// zero means the camera has passed through the pipe.
// Run with `pnpm exec vite --port 5547 --strictPort` up in apps/viewer:
//   WALKTHROUGH_BASE=http://localhost:5547 node tests/e2e/touch-pinch-surface-5547.manual.mjs
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = join(process.cwd(), 'tests/models/buildingsmart/Infra-Plumbing.ifc');
if (!existsSync(FIXTURE)) { console.log(`skip: ${FIXTURE} missing, run \`pnpm fixtures\``); process.exit(0); }
const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-touch-pinch-5547');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5547';
const PINCHES = Number(process.env.PINCHES ?? 8);
const STORE = '__ifc_lite_viewer_store__';

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1400,900'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE);
await page.locator('#file-input-open').setInputFiles(FIXTURE);
await page.waitForFunction((k) => {
  const s = globalThis[k]?.getState();
  return !!s && !s.loading && !s.geometryStreamingActive && s.models.size === 1
    && [...s.models.values()].every((m) => m.ifcDataStore && m.geometryResult && m.loadState === 'complete');
}, STORE, { timeout: 180_000 });

// The pipe segment with the most exactly-hit faces on the opening view, and
// the median of those hits as the pinch centre.
const target = await page.evaluate((k) => {
  const s = globalThis[k].getState();
  const model = [...s.models.values()][0];
  let best = null;
  for (const m of model.geometryResult.meshes) {
    if (model.ifcDataStore.entities.getTypeName(m.expressId) !== 'IfcPipeSegment') continue;
    const gid = s.toGlobalId(model.id, m.expressId);
    const hits = globalThis.__ifc_lite_scene_face_hits__(gid);
    if (!best || hits.length > best.hits.length) best = { expressId: m.expressId, gid, hits };
  }
  const h = best.hits[Math.floor(best.hits.length / 2)].screen;
  return { expressId: best.expressId, gid: best.gid, faces: best.hits.length, x: h.x, y: h.y };
}, STORE);
const viewpoint = () => page.evaluate((k) => globalThis[k].getState().cameraCallbacks.getViewpoint(), STORE);
const facesHit = () => page.evaluate((gid) => globalThis.__ifc_lite_scene_face_hits__(gid).length, target.gid);

/** Two fingers `2 * spread` apart around the pinch centre, as the canvas sees them. */
function touch(type, spread) {
  return page.evaluate(({ type, spread, x, y }) => {
    const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    const at = (identifier, dx) => new Touch({ identifier, target: canvas, clientX: x + dx, clientY: y });
    const touches = spread === null ? [] : [at(1, -spread), at(2, spread)];
    canvas.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true }));
  }, { type, spread, x: target.x, y: target.y });
}

/** One zoom-in pinch: finger half-spread 20 px opening to 200 in 20 px steps
 *  (spreading the fingers zooms in, #5777). */
async function pinch() {
  await touch('touchstart', 20);
  for (let s = 40; s <= 200; s += 20) await touch('touchmove', s);
  await touch('touchend', null);
  await page.waitForTimeout(150);
}

const fmt = (v) => `(${v.position.x.toFixed(2)}, ${v.position.y.toFixed(2)}, ${v.position.z.toFixed(2)})`;
console.log(`[pinch] IfcPipeSegment #${target.expressId}: ${target.faces} faces hit, pinching at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}), camera ${fmt(await viewpoint())}`);
await page.screenshot({ path: join(OUT, '00-opening.png') });
for (let i = 1; i <= PINCHES; i++) {
  await pinch();
  console.log(`[pinch] after pinch ${i}: ${await facesHit()} pipe faces hit, camera ${fmt(await viewpoint())}`);
  if (i === Math.ceil(PINCHES / 2) || i === PINCHES) await page.screenshot({ path: join(OUT, `${String(i).padStart(2, '0')}-after-pinch.png`) });
}
console.log(`[pinch] screenshots in ${OUT}${errors.length ? `; page errors: ${errors.join(' | ')}` : ''}`);
await browser.close();
