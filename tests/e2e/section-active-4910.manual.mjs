/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough for #4910: the section state agrees with the
// viewport. Cut in the Section tool, switch to Select (store, SDK and BCF
// export report no cut), reopen Section (cut restored), apply BCF viewpoints
// with and without a clipping plane. Run with
// `pnpm exec vite --port 5291 --strictPort` up in apps/viewer:
//   WALKTHROUGH_BASE=http://localhost:5291 node tests/e2e/section-active-4910.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-section-4910');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5291';
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
let step = 0;
const shot = async (name) => { step += 1; const p = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const act = (expr) => page.evaluate(({ k, e }) => { new Function('s', e)(globalThis[k].getState()); }, { k: STORE, e: expr });
const sdkSection = () => page.evaluate(async (k) => {
  const { createViewerAdapter } = await import('/src/sdk/adapters/viewer-adapter.ts');
  return createViewerAdapter(globalThis[k]).getSection();
}, STORE);
const section = () => state('({ tool: s.activeTool, enabled: s.sectionPlane.enabled, parked: s.sectionPlane.parked, axis: s.sectionPlane.axis, position: s.sectionPlane.position })');

async function newTopic(title) {
  await act('s.setBcfPanelVisible(true)');
  await page.evaluate((k) => globalThis[k].setState({ activeTopicId: null }), STORE);
  await page.waitForTimeout(500);
  await page.locator('[aria-label="New topic"]').first().evaluate((b) => b.click());
  await page.locator('input[placeholder="Brief description of the topic"]').fill(title);
  await page.locator('input[placeholder="Brief description of the topic"]').evaluate((i) => i.closest('form').requestSubmit());
  await page.waitForTimeout(1500);
  return state(`[...s.bcfProject.topics.values()].find(t => t.title === ${JSON.stringify(title)})`)
    .then((t) => ({ guid: t.guid, planes: t.viewpoints[0]?.clippingPlanes?.length ?? 0 }));
}

async function applyTopicViewpoint(guid) {
  await page.evaluate(({ k, g }) => globalThis[k].setState({ activeTopicId: g }), { k: STORE, g: guid });
  await page.waitForTimeout(800);
  const target = page.locator('img[alt="Viewpoint"], div.aspect-video.cursor-pointer').first();
  await target.evaluate((el) => el.click());
  await page.waitForTimeout(1500);
}

await page.goto(`${BASE}/?model=/samples/hello-wall.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(2500);
await shot('loaded');

// 1. Cut in the Section tool (ribbon button, then the axis + slider actions).
const sectionButton = page.getByRole('button', { name: /^Section/ }).first();
await sectionButton.evaluate((b) => b.click());
await page.waitForTimeout(800);
await act("s.setSectionPlaneAxis('down'); s.setSectionPlanePosition(40);");
await act('s.setDrawing2DPanelVisible(false)');
await page.waitForTimeout(1200);
log('in section', await section());
expect((await section()).enabled === true, 'cut is enabled inside the Section tool');
expect((await sdkSection())?.position === 40, 'SDK getSection() reports the visible cut');
await shot('cut-visible');
const cutTopic = await newTopic('Visible cut');
expect(cutTopic.planes === 1, 'BCF topic captured with the cut on screen has a ClippingPlane');

// 2. Switch to Select.
await act("s.setActiveTool('select')");
await page.waitForTimeout(1200);
log('after select', await section());
expect((await section()).enabled === false, 'store reports no enabled section after switching to Select');
expect((await sdkSection()) === null, 'SDK getSection() is null after switching to Select');
const noCutTopic = await newTopic('No cut after Select');
expect(noCutTopic.planes === 0, 'BCF topic captured after switching to Select has no ClippingPlane');
await shot('select-no-cut');

// 3. Reopen Section: the cut comes back.
await sectionButton.evaluate((b) => b.click());
await page.waitForTimeout(1200);
await act('s.setDrawing2DPanelVisible(false)');
log('reopened', await section());
const reopened = await section();
expect(reopened.enabled === true && reopened.axis === 'down' && Math.abs(reopened.position - 40) < 1e-6, 'reopening Section restores the down 40% cut');
await shot('reopened-cut-restored');

// 4. Apply a viewpoint WITH a plane from Select.
await act("s.setActiveTool('select')");
await page.waitForTimeout(800);
await applyTopicViewpoint(cutTopic.guid);
log('applied cut viewpoint', await section());
const applied = await section();
expect(applied.tool === 'section' && applied.enabled === true && applied.axis === 'down', 'applying a viewpoint with a plane shows the cut');
expect((await sdkSection()) !== null, 'SDK getSection() reports the applied cut');
await shot('bcf-apply-with-plane');

// 5. Apply a viewpoint WITHOUT a plane.
await applyTopicViewpoint(noCutTopic.guid);
log('applied uncut viewpoint', await section());
expect((await section()).enabled === false, 'applying a viewpoint without planes clears the cut');
await shot('bcf-apply-without-plane');

log('console errors', errors.length, errors.slice(0, 5));
log(failures.length ? `FAILURES: ${failures.join(' | ')}` : 'ALL PASS');
await browser.close();
process.exit(failures.length ? 1 : 0);
