/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewport HUD collision e2e (charter #5478; first tools on it in
 * #5503: Split, Space Sketch, Add element). For each tool state, every
 * `[data-hud-item]` the HUD placed must (a) lie inside the viewport, (b) not
 * overlap any other HUD item, and (c) not overlap the ViewCube. Layout is
 * only observable with real layout, so this runs in the browser with a
 * model loaded (the tool overlays only render over a model); tools are
 * opened through the store. Section joined in #5499 and its parked chip
 * beside the Solo chip in #5500 (the #5481 collision); Measure joins once
 * #5510 puts its bar on the table.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const TOOLS = ['split', 'spaceSketch', 'addElement', 'section'] as const;
/** After the tools: leave Section with a cut on (it parks) and solo the top storey — two top-left chips. */
const PARKED_SOLO = 'parked+solo';

interface Box { name: string; left: number; top: number; right: number; bottom: number }

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

for (const width of [1280, 1600, 1920]) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`HUD items never collide: ${TOOLS.join('/')} at ${width}px ${scheme}`, async ({ page }) => {
      test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/');
      await page.waitForFunction((k) => !!(globalThis as Record<string, unknown>)[k], STORE, { timeout: 120000 });
      await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
      await page.waitForFunction((k) => {
        const s = (globalThis as Record<string, { getState(): { models: Map<string, unknown>; geometryResult?: { meshes?: unknown[] } } }>)[k].getState();
        return s.models.size > 0 && (s.geometryResult?.meshes?.length ?? 0) > 0;
      }, STORE, { timeout: 180000 });
      await page.evaluate(([k, theme]) => {
        (globalThis as Record<string, { getState(): Record<string, (v: unknown) => void> }>)[k].getState().setTheme(theme);
      }, [STORE, scheme] as const);

      const failures: string[] = [];
      for (const tool of [...TOOLS, PARKED_SOLO]) {
        await page.evaluate(([k, t]) => {
          const state = (globalThis as Record<string, { getState(): Record<string, (v: unknown) => void> }>)[k].getState();
          if (t !== 'parked+solo') { state.setActiveTool(t); return; }
          state.setActiveTool('section');
          state.setSectionPlaneAxis('down');
          state.setSectionPlanePosition(50);
          state.setActiveTool('select');
          state.setLevelDisplayMode('solo');
        }, [STORE, tool] as const);
        await expect(page.locator('[data-viewport]').first()).toBeAttached({ timeout: 60000 });
        await expect(page.locator('[data-hud-region] [data-hud-item]').first()).toBeVisible({ timeout: 60000 });
        // Space Sketch derives rooms through wasm and then lays out its plan card.
        await page.waitForTimeout(tool === 'spaceSketch' ? 4000 : 800);

        const boxes: Box[] = await page.evaluate(() => {
          const out: Box[] = [];
          const items = document.querySelectorAll<HTMLElement>('[data-hud-region] [data-hud-item]');
          items.forEach((el, i) => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return;
            out.push({ name: `${el.closest<HTMLElement>('[data-hud-region]')!.dataset.hudRegion}#${i}`, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          });
          const cube = document.querySelector<HTMLElement>('[data-tour="viewcube"], [aria-label="View cube"], [data-viewcube]');
          if (cube) {
            const r = cube.getBoundingClientRect();
            out.push({ name: 'viewcube', left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          }
          const vp = document.querySelector<HTMLElement>('[data-viewport]')!.getBoundingClientRect();
          out.push({ name: 'viewport', left: vp.left, top: vp.top, right: vp.right, bottom: vp.bottom });
          return out;
        });
        const viewport = boxes.find((b) => b.name === 'viewport')!;
        const items = boxes.filter((b) => b.name !== 'viewport');
        expect(items.length, `${tool}: the tool placed at least one HUD item`).toBeGreaterThan(0);
        for (const a of items) {
          if (a.left < viewport.left || a.top < viewport.top || a.right > viewport.right || a.bottom > viewport.bottom) {
            failures.push(`${tool}: ${a.name} leaves the viewport`);
          }
          for (const b of items) {
            if (a === b || a.name > b.name) continue;
            if (overlaps(a, b)) failures.push(`${tool}: ${a.name} overlaps ${b.name}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }
}
