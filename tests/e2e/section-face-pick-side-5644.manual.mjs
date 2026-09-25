/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough for #5644: face-picking a section on a -X wall and
// on a +X wall keeps the same side (the picked face is cut away, the cap shows
// the wall's cross-section); Flip keeps the face. Real pick path: Section tool,
// pick mode, click the wall in the canvas. Run with
// `pnpm exec vite --port 5291 --strictPort` up in apps/viewer and the model
// served by it (e.g. copied under apps/viewer/public/):
//   WALKTHROUGH_BASE=http://localhost:5291 WALKTHROUGH_MODEL=/tmp-5644/AC20-FZK-Haus.ifc \
//     node tests/e2e/section-face-pick-side-5644.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-section-5644');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5291';
// Required: the default click fractions below are tuned for AC20-FZK-Haus.
const MODEL = process.env.WALKTHROUGH_MODEL;
if (!MODEL) {
  console.error('Set WALKTHROUGH_MODEL to a served URL of tests/models/ara3d/AC20-FZK-Haus.ifc (`pnpm fixtures`), or tune WALKTHROUGH_PICK_X/Y for another model.');
  process.exit(2);
}
const log = (...a) => console.log('[walk]', ...a);
const failures = [];
const expect = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures.push(what); };

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (name) => { const p = `${OUT}/${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const act = (expr) => page.evaluate(({ k, e }) => { new Function('s', e)(globalThis[k].getState()); }, { k: STORE, e: expr });

/** Is `p` clipped by the committed plane, evaluated the way the shader does. */
const clipped = (plane, p) => {
  const n = plane.custom.normal;
  const v = (p[0] * n[0] + p[1] * n[1] + p[2] * n[2] - plane.custom.distance) * (plane.flipped ? -1 : 1);
  return v > 0;
};

await page.goto(`${BASE}/?model=${MODEL}`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 180000 });
await page.waitForTimeout(2500);

await page.getByRole('button', { name: /^Section/ }).first().evaluate((b) => b.click());
await page.waitForTimeout(800);
await act('s.setDrawing2DPanelVisible(false)');
// The model's IfcAnnotation dimensions would sit over the walls in every shot.
await page.evaluate((k) => { const st = globalThis[k]; st.setState({ typeVisibility: { ...st.getState().typeVisibility, ifcAnnotations: false } }); }, STORE);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();

const ORBIT = Number(process.env.WALKTHROUGH_ORBIT ?? 25);
for (const view of ['left', 'right']) {
  // Start every pick from no cut, so the second click is not taken on the first cap.
  await act('s.resetSectionPlane()');
  await act(`s.cameraCallbacks.setPresetView('${view}')`);
  await page.waitForTimeout(1500);
  await act('s.setSectionPickMode(true)');
  await page.waitForTimeout(300);
  // Canvas fractions of the click; the defaults land on a ground-floor exterior wall of AC20-FZK-Haus.
  const x = box.x + box.width * Number(process.env.WALKTHROUGH_PICK_X ?? 0.5);
  const y = box.y + box.height * Number(process.env.WALKTHROUGH_PICK_Y ?? 0.52);
  await page.mouse.move(x, y);
  await page.waitForTimeout(600);
  await page.mouse.click(x, y);
  await page.waitForTimeout(1200);
  const plane = await state('s.sectionPlane');
  expect(!!plane.custom, `${view}: the click committed a face-picked plane`);
  if (!plane.custom) continue;
  const n = plane.custom.normal.map((c) => +c.toFixed(3));
  const tag = `${view}-${n[0] < 0 ? 'minusX' : 'plusX'}`;
  log(view, 'picked normal', n, 'flipped', plane.flipped, 'axis', plane.axis, 'pickedAt', plane.custom.pickedAt.map((c) => +c.toFixed(3)));
  const face = plane.custom.pickedAt;
  const behind = face.map((c, i) => c - plane.custom.normal[i] * 0.1);
  expect(clipped(plane, face), `${tag}: default clips the picked face`);
  expect(!clipped(plane, behind), `${tag}: default keeps the wall 10 cm behind the face`);
  // Slightly oblique view so the cap vs face reads in the screenshot.
  await act(`s.cameraCallbacks.orbit?.(${ORBIT}, ${ORBIT / 2})`);
  await page.waitForTimeout(1500);
  await shot(`${tag}-default`);
  await act('s.flipSectionPlane()');
  await page.waitForTimeout(1200);
  const flippedPlane = await state('s.sectionPlane');
  expect(!clipped(flippedPlane, face), `${tag}: Flip keeps the picked face`);
  await shot(`${tag}-flipped`);
  // Back to the default side, then Reset to axis (the panel button): it must
  // keep the side on screen (#5644 follow-up; on main a -X pick vanished the model).
  await act('s.flipSectionPlane()');
  await page.waitForTimeout(800);
  const onScreen = await state('s.sectionPlane');
  const probe = onScreen.custom.pickedAt.map((c, i) => c - onScreen.custom.normal[i] * 0.1);
  const keptBefore = !clipped(onScreen, probe);
  const resetButton = page.locator('button[title="Reset to nearest cardinal axis"]').first();
  // The panel opens collapsed; its header (the chevron button) expands it.
  const header = await page.locator('button', { hasText: /Custom\s+-?\d/ }).first().elementHandle();
  if (!(await resetButton.isVisible())) await header.click();
  await resetButton.click();
  await page.waitForTimeout(1200);
  const reset = await state('s.sectionPlane');
  const axisIdx = reset.axis === 'side' ? 0 : reset.axis === 'down' ? 1 : 2;
  // Cardinal renderer path: +axis normal through the picked point, flip relative to it.
  const along = probe[axisIdx] - onScreen.custom.pickedAt[axisIdx];
  const keptAfter = (along * (reset.flipped ? -1 : 1)) <= 0;
  expect(reset.custom === undefined && keptAfter === keptBefore, `${tag}: Reset to axis keeps the side that was on screen`);
  await shot(`${tag}-default-reset`);
  await header.click(); // collapse again so the panel does not cover the next pick
}

log('console errors', errors.length, errors.slice(0, 5));
log(failures.length ? `FAILURES: ${failures.join(' | ')}` : 'ALL PASS');
await browser.close();
process.exit(failures.length ? 1 : 0);
