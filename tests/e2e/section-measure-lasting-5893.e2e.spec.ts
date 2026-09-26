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
 * real UI (ribbon tool buttons, the chips) for tool switching, and injects
 * the section plane's geometry and the finished measurement through the
 * store — the same idiom `viewport-hud.e2e.spec.ts`'s "#5813 Measure Clear
 * all" test uses, since neither a face-pick nor a canvas pointer-drag can be
 * scripted deterministically against a WebGPU canvas.
 *
 * The claim this makes real (review of the first version of this spec,
 * which only checked store fields and button visibility and would have
 * passed even if the overlay had stopped drawing): the section plane is
 * placed so the measurement's two endpoints sit on the KEPT side and a third
 * control point sits on the CLIPPED side, verified against the exact
 * predicate `packages/renderer/src/shaders/main.wgsl.ts`'s fragment shader
 * clips with ("discard fragments ABOVE the plane" — `distToPlane =
 * (dot(fragmentPos, normal) - distance) * side; if (distToPlane > 0)
 * discard`), and the measurement's own SVG line + distance label are
 * asserted present in the DOM while the section is active, then asserted
 * gone once `sceneState.measurements.visible` is toggled off.
 */

import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'fs';
import { join } from 'path';

const STORE = '__ifc_lite_viewer_store__';
const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';

// A custom (face-pick-shaped) plane, chosen so the geometry below is
// trivially checkable without needing the fixture's real bounds: normal
// along +X, cut at x = PLANE_DISTANCE, not flipped.
const PLANE_NORMAL: [number, number, number] = [1, 0, 0];
const PLANE_DISTANCE = 3;
// Endpoints on the KEPT side (dot(p, normal) - distance <= 0): a distance-2
// measurement wholly on the near side of the cut.
const MEASURE_START = { x: 0, y: 0, z: 0, screenX: 300, screenY: 300 };
const MEASURE_END = { x: 2, y: 0, z: 0, screenX: 400, screenY: 300 };
// A control point on the CLIPPED side (dot > distance) — never part of the
// measurement, just proof the plane actually separates the two regions.
const CONTROL_POINT = { x: 10, y: 0, z: 0 };

/** `distToPlane` from the fragment shader, `flipped` always false here. */
function distToPlane(point: { x: number; y: number; z: number }, normal: [number, number, number], distance: number): number {
  return point.x * normal[0] + point.y * normal[1] + point.z * normal[2] - distance;
}

interface StoreState {
  models: Map<unknown, unknown>;
  sectionPlane: { enabled: boolean; custom?: { normal: [number, number, number]; distance: number } };
  sceneState: { section: { visible: boolean }; measurements: { visible: boolean } };
  measurements: Array<{ id: string; distance: number }>;
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
      sectionPlane: { enabled: s.sectionPlane.enabled, custom: s.sectionPlane.custom },
      sceneState: s.sceneState,
      measurements: s.measurements.map((m) => ({ id: m.id, distance: m.distance })),
      activeTool: s.activeTool,
    };
  }, STORE);
}

/** Put the fixed custom plane on screen — face-pick geometry a real pointer
 *  gesture cannot reach deterministically, injected the same way the
 *  measurement below is. */
async function placeSectionPlane(page: Page): Promise<void> {
  await page.evaluate(({ key, normal, distance }) => {
    const store = (globalThis as Record<string, StoreHandle>)[key];
    const plane = store.getState().sectionPlane;
    store.setState({
      sectionPlane: {
        ...plane,
        enabled: true,
        flipped: false,
        custom: { normal, distance, pickedAt: [distance, 0, 0], tangent: [0, 1, 0], bitangent: [0, 0, 1] },
      },
    });
  }, { key: STORE, normal: PLANE_NORMAL, distance: PLANE_DISTANCE });
}

async function placeMeasurement(page: Page): Promise<void> {
  await page.evaluate(({ key, start, end }) => {
    const store = (globalThis as Record<string, StoreHandle>)[key];
    store.setState({
      measurements: [{ id: 'e2e-5893-measurement', start, end, distance: 2 }],
    });
  }, { key: STORE, start: MEASURE_START, end: MEASURE_END });
}

test.describe('#5893 section cut and measurements are lasting scene state', () => {
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  test('the chosen plane really separates the measurement (kept) from the control point (clipped)', () => {
    // Self-check on the geometry every other test in this file relies on —
    // the exact predicate the fragment shader clips with (see file doc).
    expect(distToPlane(MEASURE_START, PLANE_NORMAL, PLANE_DISTANCE)).toBeLessThanOrEqual(0);
    expect(distToPlane(MEASURE_END, PLANE_NORMAL, PLANE_DISTANCE)).toBeLessThanOrEqual(0);
    expect(distToPlane(CONTROL_POINT, PLANE_NORMAL, PLANE_DISTANCE)).toBeGreaterThan(0);
  });

  test('cutting the building, then opening Measure, keeps the cut on screen; a measurement survives switching to Select, and draws while hidden toggles it off', async ({ page }, testInfo) => {
    await loadFixture(page);

    // 1. Open the Section tool and place the cut.
    await page.locator('[data-tour="tool-section"]').click();
    await expect(page.locator('[data-tool-bar="section"]')).toBeVisible();
    await placeSectionPlane(page);

    let state = await getState(page);
    expect(state.sectionPlane.enabled, 'the cut is on').toBe(true);
    expect(state.sceneState.section.visible, 'visible by default').toBe(true);
    // The store's own contract for "the visible cut" (mirrors
    // `activeSectionPlane()`, store/section-active.ts) — both must hold.
    expect(state.sectionPlane.enabled && state.sceneState.section.visible).toBe(true);
    await testInfo.attach('section-cut.png', { body: await page.screenshot(), contentType: 'image/png' });

    // 2. Open Measure. BUG (pre-#5893): this used to park the cut.
    await page.locator('[data-tour="tool-measure"]').click();
    await expect(page.locator('[data-testid="measure-toolbar"]')).toBeVisible();

    state = await getState(page);
    expect(state.sectionPlane.enabled, 'BUG (pre-#5893): the cut was forced off the moment Measure opened').toBe(true);
    expect(state.sceneState.section.visible).toBe(true);
    // The section chip (SectionParkedChip) proves it independent of the tool.
    await expect(page.locator('button[aria-label="Resume the section cut"]')).toBeVisible();

    // 3. Take a measurement whose endpoints sit on the KEPT side (verified
    // above), inside the cut.
    await placeMeasurement(page);
    // While the Measure tool is open, MeasureOverlay draws it (not
    // MeasurementSceneLayer, which defers to it — see that component's doc).
    // The injected screenX/screenY are only the INITIAL values: the
    // animation loop's per-frame reprojection (`updateMeasurementScreenCoords`)
    // immediately re-derives them from the real camera, so the locator
    // matches the finished-measurement line by its distinctive style
    // (`MeasurementVisuals.tsx`: ink stroke, 6,3 dash, the overlay glow
    // filter) rather than by coordinates nothing here controls.
    const line = page.locator('svg line[stroke-dasharray="6,3"][filter="url(#scene-overlay-glow)"]');
    await expect(line).toHaveCount(1);
    const label = page.locator('[data-scene-primitive="world-label"]', { hasText: /2\.000\s*m/ });
    await expect(label.first()).toBeVisible();
    await testInfo.attach('measure-inside-cut.png', { body: await page.screenshot(), contentType: 'image/png' });

    // 4. Switch to Select. BUG (pre-#5893): MeasureOverlay unmounts and the
    // finished measurement's SVG vanished with it — MeasurementSceneLayer
    // (always mounted) must now draw it instead.
    await page.locator('[data-tour="tool-select"]').click();

    state = await getState(page);
    expect(state.measurements.length, 'the measurement itself is still in the store').toBe(1);
    expect(state.sceneState.measurements.visible).toBe(true);
    expect(state.sectionPlane.enabled, 'the cut is still on after Select too').toBe(true);
    await expect(line).toHaveCount(1);
    await expect(label.first()).toBeVisible();
    await expect(page.locator('button[aria-label="Clear all measurements"]')).toBeVisible();
    await testInfo.attach('measurement-survives-select.png', { body: await page.screenshot(), contentType: 'image/png' });

    // 5. Toggling the measurements chip off removes the SVG/label from the
    // DOM, not just the store flag — the claim the first version of this
    // spec never actually made.
    await page.locator('button[aria-label="Hide measurements"]').click();
    state = await getState(page);
    expect(state.sceneState.measurements.visible).toBe(false);
    expect(state.measurements.length, 'hiding does not delete the data').toBe(1);
    await expect(line).toHaveCount(0);
    await expect(label).toHaveCount(0);
    await testInfo.attach('measurement-hidden.png', { body: await page.screenshot(), contentType: 'image/png' });

    await page.locator('button[aria-label="Show measurements"]').click();
    await expect(line).toHaveCount(1);
    await expect(label.first()).toBeVisible();
  });

  test('the section chip toggle hides and shows the cut independent of the active tool', async ({ page }) => {
    await loadFixture(page);
    await page.locator('[data-tour="tool-section"]').click();
    await placeSectionPlane(page);
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
