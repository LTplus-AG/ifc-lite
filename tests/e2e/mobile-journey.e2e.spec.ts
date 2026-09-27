/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5865: one authored-model mobile journey and mobile axe ratchet. */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { SceneFaceHitSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';
import { WORKSPACE_PANELS } from '../../apps/viewer/src/lib/panels/registry';
import { en } from '../../apps/viewer/src/i18n/en';
import { checkAxeBaseline } from './axe-baseline';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_scene_face_hits__: (globalId: number) => SceneFaceHitSnapshot[];
}

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('ifclite.extensions.privacy-disclosure.v2', 'e2e acknowledged');
    window.localStorage.setItem('ifc-lite:collab:enabled', 'false');
  });
});

async function loadAuthoredModel(page: Page): Promise<void> {
  await page.goto('/?model=/samples/building-architecture.ifc');
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state?.models.size === 1 && !state.loading && !state.geometryStreamingActive &&
      [...state.models.values()].every((model) => model.ifcDataStore && (model.geometryResult?.meshes.length ?? 0) > 0) &&
      typeof globalThis.__ifc_lite_scene_face_hits__ === 'function';
  }, undefined, { timeout: 180_000 });
}

type TouchPoint = { x: number; y: number; id: number };

async function touch(device: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: TouchPoint[]): Promise<void> {
  await device.send('Input.dispatchTouchEvent', { type, touchPoints: points });
}

async function visibleFaces(page: Page): Promise<Array<{ globalId: number; x: number; y: number }>> {
  return page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]');
    if (!canvas) throw new Error('viewer canvas is missing');
    const rect = canvas.getBoundingClientRect();
    const faces: Array<{ globalId: number; x: number; y: number }> = [];
    for (const [modelId, model] of state.models) for (const mesh of model.geometryResult?.meshes ?? []) {
      const globalId = state.toGlobalId(modelId, mesh.expressId);
      for (const { screen } of globalThis.__ifc_lite_scene_face_hits__(globalId)) {
        if (screen.x > rect.left + 20 && screen.x < rect.right - 20 &&
          screen.y > rect.top + 20 && screen.y < rect.bottom - 20) {
          faces.push({ globalId, x: screen.x, y: screen.y });
        }
      }
      if (faces.length >= 20) return faces;
    }
    if (faces.length === 0) throw new Error('no visible authored faces on the mobile canvas');
    return faces;
  });
}

async function viewpoint(page: Page) {
  return page.evaluate(() => {
    const view = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.getViewpoint?.();
    if (!view) throw new Error('live camera viewpoint is unavailable');
    return { position: view.position, target: view.target };
  });
}

function panelName(id: string): string {
  const panel = WORKSPACE_PANELS.find((item) => item.id === id);
  if (!panel) throw new Error(`Unregistered panel ${id}`);
  const name = en[panel.titleKey];
  if (typeof name !== 'string') throw new Error(`Panel ${id} has no text title`);
  return name;
}

test('mobile empty and authored-model screens stay within their axe baselines (#5865)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open file' })).toBeVisible();
  const empty = await checkAxeBaseline(page, 'mobile-empty');
  expect(empty.counts['button-name']).toBeUndefined();
  expect(empty.counts['meta-viewport']).toBeUndefined();
  expect(empty.failure).toBeNull();

  await loadAuthoredModel(page);
  const loaded = await checkAxeBaseline(page, 'mobile-loaded');
  expect(loaded.counts['button-name']).toBeUndefined();
  expect(loaded.counts['meta-viewport']).toBeUndefined();
  expect(loaded.failure).toBeNull();
});

test('the Panels sheet opens every available registry panel on a phone (#5865)', async ({ page }) => {
  await loadAuthoredModel(page);
  const available = await page.evaluate(() => {
    const { sidebarOrder, sidebarHiddenIds } = globalThis.__ifc_lite_viewer_store__.getState();
    return sidebarOrder.filter((id) =>
      (!sidebarHiddenIds.includes(id) || id === 'properties') &&
      id !== 'collab');
  });
  const registered = WORKSPACE_PANELS.filter(({ id }) => id !== 'collab');
  expect(available).toContain('pointclouds'); // #5873: the empty panel is reachable before a scan loads.
  expect([...available].sort()).toEqual(registered.map(({ id }) => id).sort());

  const launcher = page.getByRole('button', { name: 'Open the panel list' });
  for (const [index, id] of available.entries()) {
    await expect(launcher).toBeVisible();
    await launcher.click();
    const list = page.locator('ul').filter({ has: page.getByRole('button', { name: panelName('clash'), exact: true }) });
    if (index === 0) {
      await expect(list.locator(':scope > li > button')).toHaveCount(registered.length);
      expect((await list.locator(':scope > li > button').allTextContents()).map((name) => name.trim()))
        .toEqual(available.map(panelName));
    }
    await list.getByRole('button', { name: panelName(id), exact: true }).click();
    const state = await page.evaluate(() => {
      const { leftPanelCollapsed, rightPanelCollapsed, sidebarActivePanel } = globalThis.__ifc_lite_viewer_store__.getState();
      return { leftPanelCollapsed, rightPanelCollapsed, sidebarActivePanel };
    });
    if (id === 'hierarchy') expect(state.leftPanelCollapsed).toBe(false);
    else {
      expect(state.rightPanelCollapsed, `${id} did not open the mobile sheet`).toBe(false);
      await expect(page.locator('div.absolute.inset-x-0').getByText(panelName(id), { exact: true }).first()).toBeVisible();
    }
    await page.getByRole('button', { name: 'Close panels', exact: true }).first().click({ position: { x: 190, y: 30 } });
  }
});

test('one finger orbits, two fingers pinch, taps select and measure, and hold opens the entity menu (#5865)', async ({ page }, info) => {
  let softwareDeviceLost = false;
  page.on('console', (message) => {
    if (/\[WebGPU\] Device lost:|\[Renderer\] GPU device lost/.test(message.text())) softwareDeviceLost = true;
  });
  const requireRenderer = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (softwareDeviceLost && process.env.E2E_GPU_STRICT === '0') {
        test.skip(true, `Software WebGPU device lost during ${stage}; authored-model journey passed with a healthy GPU.`);
      }
      throw error;
    }
  };
  await loadAuthoredModel(page);
  const canvas = page.locator('canvas[data-viewport="main"]');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('mobile canvas is not laid out');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const device = await page.context().newCDPSession(page);
  try {
    const beforeOrbit = await viewpoint(page);
    await touch(device, 'touchStart', [{ ...center, id: 1 }]);
    for (let dx = 20; dx <= 100; dx += 20) {
      await touch(device, 'touchMove', [{ x: center.x + dx, y: center.y, id: 1 }]);
    }
    await touch(device, 'touchEnd', []);
    const afterOrbit = await viewpoint(page);
    expect(afterOrbit.position).not.toEqual(beforeOrbit.position);

    const distance = ({ position, target }: Awaited<ReturnType<typeof viewpoint>>) =>
      Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
    const beforePinch = await viewpoint(page);
    await touch(device, 'touchStart', [
      { x: center.x - 20, y: center.y, id: 1 }, { x: center.x + 20, y: center.y, id: 2 },
    ]);
    for (let spread = 40; spread <= 100; spread += 20) {
      await touch(device, 'touchMove', [
        { x: center.x - spread, y: center.y, id: 1 }, { x: center.x + spread, y: center.y, id: 2 },
      ]);
    }
    await touch(device, 'touchEnd', []);
    expect(distance(await viewpoint(page))).toBeLessThan(distance(beforePinch));
    expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);

    const faces = await requireRenderer('visible-face projection', () => visibleFaces(page));
    const first = faces[0];
    const second = faces.find((face) => Math.hypot(face.x - first.x, face.y - first.y) > 25);
    if (!second) throw new Error('two distinct visible face points are required for Measure');
    await page.touchscreen.tap(first.x, first.y);
    await requireRenderer('tap selection', () => expect.poll(
      () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId),
    ).toBe(first.globalId));

    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    await page.touchscreen.tap(first.x, first.y);
    await page.touchscreen.tap(second.x, second.y);
    await requireRenderer('two-tap measurement', () => expect.poll(
      () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().measurements.length),
    ).toBeGreaterThan(0));

    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await touch(device, 'touchStart', [{ x: first.x, y: first.y, id: 1 }]);
    await requireRenderer('long-press menu', () =>
      expect(page.getByRole('menu', { name: 'Entity actions' })).toBeVisible({ timeout: 10_000 }));
    await requireRenderer('long-press entity pick', () => expect.poll(
      () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().contextMenu.entityId),
    ).toBe(first.globalId));
    await info.attach('mobile-journey-authored-ifc.png', { body: await page.screenshot(), contentType: 'image/png' });
    await touch(device, 'touchEnd', []);
  } finally {
    await device.detach();
  }
});
