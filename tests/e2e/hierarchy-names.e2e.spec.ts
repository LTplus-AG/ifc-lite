/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5394: in the default layout a storey row left its name about 15-33 px
 * ("D.. A" on FZK-Haus), because every other part of the row was fixed and the
 * name was the only part that could shrink. Measured on the real model in the
 * real default panel: both FZK-Haus storey Names ("Dachgeschoss",
 * "Erdgeschoss") must render untruncated.
 */

import { test, expect } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

test('#5394: storey names are readable in the default hierarchy panel', async ({ page }) => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.waitForFunction((k) => !!(globalThis as Record<string, unknown>)[k], STORE, { timeout: 120000 });
  await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction((k) => {
    const s = (globalThis as Record<string, { getState(): { models: Map<string, unknown>; geometryResult?: { meshes?: unknown[] } } }>)[k].getState();
    return s.models.size > 0 && (s.geometryResult?.meshes?.length ?? 0) > 0;
  }, STORE, { timeout: 180000 });

  const storeyNames = ['Dachgeschoss', 'Erdgeschoss'];
  for (const name of storeyNames) {
    await expect(page.locator('.hierarchy-item', { hasText: name }).first()).toBeVisible({ timeout: 60000 });
  }
  const measured = await page.evaluate((names) => names.map((name) => {
    const row = [...document.querySelectorAll('.hierarchy-item')].find((r) => r.textContent?.includes(name))!;
    const primary = [...row.querySelectorAll('span')].find((s) => s.textContent === name)!;
    return { name, rowWidth: row.getBoundingClientRect().width, shown: primary.clientWidth, needs: primary.scrollWidth };
  }), storeyNames);

  for (const m of measured) {
    // The default panel really is the narrow case the issue is about.
    expect(m.rowWidth, `${m.name} row width`).toBeLessThan(288);
    expect(m.needs - m.shown, `${m.name} is truncated (${m.shown}px of ${m.needs}px)`).toBeLessThanOrEqual(1);
  }
});
