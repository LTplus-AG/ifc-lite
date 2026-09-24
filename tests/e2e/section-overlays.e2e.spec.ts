/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5391: the Section tool's bottom strip must paint above its neighbours.
 *
 * The hint used to sit at z-30 under the 2D Section panel (z-40, docked
 * bottom-left), so at 1600 px its left half was hidden ("…E TO PREVIEW"), and
 * the Clip toggle shared the Presentation dock pill's `bottom-4` anchor and was
 * hidden behind it outright. Paint order is only observable with real layout,
 * so this runs in the browser, with a model loaded (the tool overlays only
 * render over a model). The tool and the panel are opened through the store.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

test('#5391: section hint and clip toggle are not covered by the 2D panel or the Presentation pill', async ({ page }) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForFunction((k) => !!(globalThis as Record<string, unknown>)[k], STORE, { timeout: 120000 });
  await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction((k) => {
    const s = (globalThis as Record<string, { getState(): { models: Map<string, unknown>; geometryResult?: { meshes?: unknown[] } } }>)[k].getState();
    return s.models.size > 0 && (s.geometryResult?.meshes?.length ?? 0) > 0;
  }, STORE, { timeout: 180000 });
  await page.evaluate((k) => {
    const s = (globalThis as Record<string, { getState(): Record<string, (v: unknown) => void> }>)[k].getState();
    s.setActiveTool('section');
    s.setDrawing2DPanelVisible(true);
  }, STORE);

  const hint = page.locator('[data-section-hint]');
  const toggle = page.locator('[data-section-clip-toggle]');
  await expect(hint).toBeVisible({ timeout: 60000 });
  await expect(toggle).toBeVisible();
  await page.waitForTimeout(500);

  // The hint is click-through by design, which also hides it from hit
  // testing; re-enable pointer events so elementFromPoint reports paint order.
  const covered = await page.evaluate(() => {
    const targets = [...document.querySelectorAll<HTMLElement>('[data-section-hint], [data-section-clip-toggle]')];
    for (const el of targets) { el.style.pointerEvents = 'auto'; el.parentElement!.style.pointerEvents = 'auto'; }
    const out: string[] = [];
    for (const el of targets) {
      const r = el.getBoundingClientRect();
      for (const fx of [0.05, 0.5, 0.95]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height / 2;
        const top = document.elementFromPoint(x, y);
        if (!top || !el.contains(top)) out.push(`${el.textContent?.trim()} @${Math.round(x)},${Math.round(y)} under "${(top?.textContent ?? '').trim().slice(0, 30)}"`);
      }
    }
    return out;
  });
  expect(covered).toEqual([]);
});
