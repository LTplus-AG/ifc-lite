/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Walkthrough for #5491: one selection accent across GPU and DOM,
// annotations on ink/accent, and a BCF tooltip that follows the theme. For
// each of light and dark: a clicked (selected) mesh with its GPU tint, a
// selected annotation pin with its popover, a draft pin with its drop input,
// a rectangle-select marquee mid-drag, and a hovered BCF marker's tooltip.
// Run with a built viewer served from apps/viewer
// (`pnpm exec vite preview --port 5291 --strictPort`):
//   WALKTHROUGH_BASE=http://localhost:5291 node tests/e2e/selection-accent-5491.manual.mjs
// WebGPU runs on SwiftShader. Headed by default: under WSL the headless
// window never presents the WebGPU canvas; set WALKTHROUGH_HEADLESS=1 on a
// host where it does (the viewer-e2e-ci setup).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-selection-accent-5491');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5291';
const log = (...a) => console.log('[walk]', ...a);

const browser = await chromium.launch({
  headless: process.env.WALKTHROUGH_HEADLESS === '1', channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const act = (expr) => page.evaluate(({ k, e }) => { new Function('s', 'store', e)(globalThis[k].getState(), globalThis[k]); }, { k: STORE, e: expr });
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const shot = async (name, clip) => { const p = `${OUT}/${name}.png`; await page.screenshot({ path: p, clip }); log('shot', p); };

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 180000 });
await page.waitForTimeout(2500);

const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
// Points on the sample house at the default camera (fractions of the canvas).
const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
const ROOF = at(0.6, 0.35);
const WALL = at(0.42, 0.62);
const selected = () => state('s.selectedEntityId');

// Select the roof with a click, and file one BCF topic on it so a marker is placed.
// SwiftShader renders a few frames a second, so give the GPU pick time to land.
const clickSelect = async (pt) => {
  await page.mouse.click(pt.x, pt.y);
  await page.waitForFunction((k) => globalThis[k].getState().selectedEntityId != null, STORE, { timeout: 15000 }).catch(() => {});
  return selected();
};
for (let i = 0; i < 4 && (await clickSelect(ROOF)) == null; i++) await page.waitForTimeout(1500);
log('selected after click', await selected());
await act('s.setBcfPanelVisible(true)');
await page.waitForTimeout(600);
await page.locator('[aria-label="New topic"]').first().evaluate((b) => b.click());
await page.locator('input[placeholder="Brief description of the topic"]').fill('Roof overhang clashes with gutter');
await page.locator('input[placeholder="Brief description of the topic"]').evaluate((i) => i.closest('form').requestSubmit());
await page.waitForTimeout(1500);
await act('s.setBcfPanelVisible(false); s.setBcfOverlayVisible(true)');
log('bcf topics', JSON.stringify(await state('s.bcfProject ? [...s.bcfProject.topics.values()].map((t) => ({ title: t.title, status: t.topicStatus, viewpoints: t.viewpoints.length, selected: t.viewpoints[0]?.components?.selection?.length ?? 0 })) : null')));

for (const theme of ['light', 'dark']) {
  await act(`s.setTheme('${theme}')`);
  await act("s.setActiveTool('select')");
  log(theme, 'selected after click', await clickSelect(ROOF));

  // Annotate: click the wall, type a note, Enter commits; clicking the pin selects it.
  await act("s.clearAllAnnotations(); s.setActiveTool('annotate')");
  await page.mouse.click(WALL.x, WALL.y);
  const note = page.locator('[role="dialog"] textarea').first();
  await note.waitFor({ timeout: 15000 });
  await note.fill(`Check the head height (${theme}).`);
  await note.press('Enter');
  await page.waitForTimeout(600);
  await page.locator('button[aria-label^="Annotation 1"]').first().click({ force: true }).catch((e) => log('pin click', String(e).slice(0, 80)));
  await page.waitForTimeout(800);
  log(theme, 'selected annotation', await state('s.selectedAnnotationId'));
  await shot(`${theme}-1-selected-mesh-pin-popover`);

  // Draft pin + drop input: a second click in the annotate tool.
  await page.keyboard.press('Escape');
  await act("s.setActiveTool('annotate')");
  await page.mouse.click(ROOF.x - 40, ROOF.y + 30);
  await page.locator('[role="dialog"] textarea').first().waitFor({ timeout: 15000 }).catch(() => log('no drop input'));
  await page.waitForTimeout(400);
  await shot(`${theme}-2-draft-pin-drop-input`);
  await page.keyboard.press('Escape');
  await act("s.cancelDraft(); s.clearAllAnnotations(); s.setActiveTool('select')");

  // Rectangle-select marquee mid-drag (Ctrl + LMB over the canvas).
  const from = at(0.3, 0.3);
  await page.keyboard.down('Control');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 220, from.y + 160, { steps: 8 });
  await page.waitForTimeout(300);
  await shot(`${theme}-3-rect-select`);
  await page.mouse.up();
  await page.keyboard.up('Control');
  await clickSelect(ROOF);

  // BCF marker tooltip on hover.
  const marker = page.locator('.bcf-overlay-marker').first();
  if (await marker.count()) {
    await marker.hover({ force: true });
    // The marker re-projects every frame; if the pointer landed on a moving
    // target, deliver the hover the renderer listens for directly.
    await marker.dispatchEvent('mouseenter');
    // setMarkers() rebuilds the marker's inner HTML (tooltip hidden) whenever
    // the viewer recomputes markers, which SwiftShader's slow frames make
    // likely between the hover and the capture; pin the tooltip open for the shot.
    await marker.evaluate((el) => { el.querySelector('.bcf-overlay-tooltip').style.display = ''; });
    const mb = await marker.boundingBox();
    await shot(`${theme}-4-bcf-tooltip`, mb ? { x: Math.max(0, mb.x - 180), y: Math.max(0, mb.y - 130), width: 420, height: 200 } : undefined);
    const colours = await page.locator('.bcf-overlay-tooltip').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, color: cs.color, meta: getComputedStyle(el.querySelector('.bcf-tooltip-meta')).color };
    });
    log(theme, 'bcf tooltip', JSON.stringify(colours));
    await page.mouse.move(5, 5);
  } else {
    log(theme, 'no BCF marker rendered');
  }
}

log('page errors', errors.length ? errors : 'none');
await browser.close();
