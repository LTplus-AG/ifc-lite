/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5893: the section cut and finished measurements are lasting scene state
 * the user toggles — they no longer draw only while their own tool is open.
 *
 * On main (pre-#5893): `store/section-active.ts` forced `sectionPlane.enabled`
 * off the moment `activeTool` left `'section'`, so cutting the building and
 * then opening Measure made the cut vanish, and `MeasureOverlay` only
 * mounted while `activeTool === 'measure'` (`ToolOverlays.tsx`), so a
 * finished measurement vanished on switching to Select. This spec drives the
 * real UI (ribbon tool buttons, the Section bar's Cut toggle) and fails
 * against that behaviour.
 */

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

interface StoreState {
  models: Map<unknown, unknown>;
  sectionPlane: { enabled: boolean };
  sceneState: { section: { visible: boolean }; measurements: { visible: boolean } };
  measurements: unknown[];
  activeTool: string;
}
type StoreHandle = { getState(): StoreState; setState(patch: object): void };

async function loadFixture(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction((key) => !!(globalThis as Record<string, unknown>)[key], STORE);
  await page.locator('input[type="file"]').first().setInputFiles(join(process.cwd(), FIXTURE));
  await page.waitForFunction((key) => {
    const store = (globalThis as Record<string, StoreHandle>)[key];
    return store.getState().models.size > 0;
  }, STORE, { timeout: 120000 });
  await page.waitForTimeout(1500);
}

function getState(page: Page): Promise<StoreState> {
  return page.evaluate((key) => {
    const store = (globalThis as Record<string, StoreHandle>)[key];
    const s = store.getState();
    return {
      models: s.models,
      sectionPlane: { enabled: s.sectionPlane.enabled },
      sceneState: s.sceneState,
      measurements: s.measurements,
      activeTool: s.activeTool,
    };
  }, STORE);
}

test.describe('#5893 section cut and measurements are lasting scene state', () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  test('cutting the building, then opening Measure, keeps the cut on screen; a measurement survives switching to Select', async ({ page }, testInfo) => {
    await loadFixture(page);

    // 1. Open the Section tool and turn the cut on.
    await page.locator('[data-tour="tool-section"]').click();
    await expect(page.locator('[data-tool-bar="section"]')).toBeVisible();
    await page.locator('[data-tool-bar="section"]').getByRole('button', { name: 'Cut', exact: true }).click();

    let state = await getState(page);
    expect(state.sectionPlane.enabled, 'the cut is on after the Cut toggle').toBe(true);
    expect(state.sceneState.section.visible, 'visible by default').toBe(true);
    await testInfo.attach('section-cut.png', { body: await page.screenshot(), contentType: 'image/png' });

    // 2. Open Measure. BUG (pre-#5893): this used to park the cut.
    await page.locator('[data-tour="tool-measure"]').click();
    await expect(page.locator('[data-testid="measure-toolbar"]')).toBeVisible();

    state = await getState(page);
    expect(state.sectionPlane.enabled, 'BUG (pre-#5893): the cut was forced off the moment Measure opened').toBe(true);
    expect(state.sceneState.section.visible).toBe(true);
    // The section chip (SectionParkedChip) proves it independent of the tool.
    await expect(page.locator('button[aria-label="Resume the section cut"]')).toBeVisible();

    // 3. Take a measurement inside the cut (deterministic injection, the
    // same idiom `viewport-hud.e2e.spec.ts`'s "#5813 Measure Clear all"
    // test uses — real pointer drags over a WebGPU canvas cannot be
    // asserted pixel-for-pixel, but the finished measurement this produces
    // is exactly what a drag measurement leaves in the store).
    await page.evaluate((key) => {
      const store = (globalThis as Record<string, StoreHandle>)[key];
      store.setState({
        measurements: [{
          id: 'e2e-5893-measurement',
          start: { x: 0, y: 0, z: 0, screenX: 300, screenY: 300 },
          end: { x: 2, y: 0, z: 0, screenX: 400, screenY: 300 },
          distance: 2,
        }],
      });
    }, STORE);
    await testInfo.attach('measure-inside-cut.png', { body: await page.screenshot(), contentType: 'image/png' });

    // 4. Switch to Select. BUG (pre-#5893): MeasureOverlay unmounts and the
    // finished measurement's SVG vanishes with it.
    await page.locator('[data-tour="tool-select"]').click();

    state = await getState(page);
    expect(state.measurements.length, 'the measurement itself is still in the store').toBe(1);
    expect(state.sceneState.measurements.visible).toBe(true);
    expect(state.sectionPlane.enabled, 'the cut is still on after Select too').toBe(true);
    // MeasurementSceneLayer is mounted unconditionally, so its SVG survives
    // the tool switch; the measurements chip is the user-facing proof.
    await expect(page.locator('button[aria-label="Clear all measurements"]')).toBeVisible();
    await testInfo.attach('measurement-survives-select.png', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('the section chip toggle hides and shows the cut independent of the active tool', async ({ page }) => {
    await loadFixture(page);
    await page.locator('[data-tour="tool-section"]').click();
    await page.locator('[data-tool-bar="section"]').getByRole('button', { name: 'Cut', exact: true }).click();
    await page.locator('[data-tour="tool-measure"]').click();

    const hide = page.locator('button[aria-label="Hide the section cut"]');
    await expect(hide).toBeVisible();
    await hide.click();

    let state = await getState(page);
    expect(state.sceneState.section.visible).toBe(false);
    expect(state.sectionPlane.enabled, 'hiding does not forget the cut').toBe(true);

    await page.locator('button[aria-label="Show the section cut"]').click();
    state = await getState(page);
    expect(state.sceneState.section.visible).toBe(true);
  });
});
