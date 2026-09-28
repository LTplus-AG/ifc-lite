/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Browser witness for hover, click and drag measurement on authored curves (#5780). */
import { expect, test } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { sweptDiskFixture } from './swept-disk-fixture.js';

type SourceHit = { modelId: string; expressId: number; segmentIndex: number; kind: 'line' | 'arc'; length: number; t: number };
type BrowserState = {
  models: Map<string, { id: string; ifcDataStore?: {
    entityCount: number;
    entities: { getTypeName(id: number): string };
  } | null }>;
  geometryResult?: { meshes: unknown[] };
  snapTarget?: { position: { x: number; y: number; z: number }; metadata?: { sourceCurve?: SourceHit } } | null;
  activePolyline?: { points: Array<{ x: number; y: number; z: number }> } | null;
  measurements: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }>;
  toGlobalId(modelId: string, expressId: number): number;
  setSelectedEntity(ref: { modelId: string; expressId: number }): void;
  setSelectedEntityId(id: number): void;
  setSelectedEntityIds(ids: number[]): void;
  setCentrelineOverlayEnabled(enabled: boolean): void;
  setPropertiesActiveTab(tab: 'quantities'): void;
  setRightPanelCollapsed(collapsed: boolean): void;
  setActiveTool(tool: string): void;
  setMeasureMode(mode: 'polyline' | 'drag'): void;
  cameraCallbacks: { frameEntities?: (ids: number[]) => void };
};
type BrowserStore = { getState(): BrowserState };
type ScreenProbe = (modelId: string, expressId: number, segmentIndex: number, t: number) =>
  { x: number; y: number; world: { x: number; y: number; z: number } } | null;

function distanceFromFiniteLine(
  point: { x: number; y: number; z: number }, start: { x: number; y: number; z: number },
  end: { x: number; y: number; z: number },
): { distance: number; t: number } {
  const delta = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const t = ((point.x - start.x) * delta.x + (point.y - start.y) * delta.y
    + (point.z - start.z) * delta.z) / (delta.x ** 2 + delta.y ** 2 + delta.z ** 2);
  return { t, distance: Math.hypot(point.x - start.x - t * delta.x,
    point.y - start.y - t * delta.y, point.z - start.z - t * delta.z) };
}

test('selected authored source curve snaps on hover, click and drag, then clears with overlay (#5780)', async ({ page }, testInfo) => {
  test.skip(!existsSync(sweptDiskFixture.path), `Swept-disk IFC missing at ${sweptDiskFixture.path}; run pnpm fixtures or provide REBAR_IFC`);
  test.setTimeout(600_000);
  let deviceLostBeforeSnap: string | null = null;
  page.on('console', (message) => {
    if (message.text().includes('[WebGPU] Device lost:')) deviceLostBeforeSnap = message.text();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(sweptDiskFixture.path);
  await page.waitForFunction(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__?: BrowserStore }).__ifc_lite_viewer_store__?.getState();
    const model = state?.models.values().next().value;
    return state?.models.size === 1 && state.geometryResult?.meshes?.length > 0
      && (model?.ifcDataStore?.entityCount ?? 0) > 0;
  }, undefined, { timeout: 300_000 });
  const source = await page.evaluate((expressId) => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    if (!model) throw new Error('loaded IFC model is missing');
    const id = state.toGlobalId(model.id, expressId);
    state.setSelectedEntity({ modelId: model.id, expressId });
    state.setSelectedEntityId(id);
    state.setSelectedEntityIds([id]);
    state.cameraCallbacks.frameEntities?.([id]);
    state.setPropertiesActiveTab('quantities');
    state.setRightPanelCollapsed(false);
    return { modelId: model.id, typeName: model.ifcDataStore?.entities.getTypeName(expressId) };
  }, sweptDiskFixture.expressId);
  expect(source.typeName, 'the parsed IFC contains the authored reinforcing bar').toBe('IfcReinforcingBar');
  const modelId = source.modelId;
  const inspector = page.getByRole('region', { name: 'Derived source geometry' });
  await expect(inspector).toContainText(sweptDiskFixture.radiusText, { timeout: 120_000 });
  await expect(inspector).toContainText(sweptDiskFixture.totalLengthPrefix);
  await expect(inspector.getByRole('button', { name: /Segment \d+/ })).toHaveCount(sweptDiskFixture.segmentCount);

  await page.waitForFunction(() => Boolean((globalThis as unknown as { __ifc_lite_capture_color_frame__?: unknown }).__ifc_lite_capture_color_frame__));
  const capture = () => page.evaluate(() => (globalThis as unknown as {
    __ifc_lite_capture_color_frame__: () => Promise<string | null>;
  }).__ifc_lite_capture_color_frame__());
  let baseline: string | null = null;
  let captureThrew = false;
  try {
    await expect.poll(async () => {
      try { baseline = await capture(); }
      catch (error) { captureThrew = true; throw error; }
      return baseline;
    }, { timeout: 30_000, message: 'renderer produces a baseline frame before source snapping' })
      .toMatch(/^data:image\/png;base64,/);
  } catch (error) {
    if (!captureThrew && baseline === null && deviceLostBeforeSnap && process.env.E2E_GPU_STRICT === '0') {
      const reason = `Hosted software WebGPU device was lost before source snapping: ${deviceLostBeforeSnap}`;
      console.warn(`[e2e] ${reason}`);
      test.skip(true, reason);
    }
    throw error;
  }
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    state.setActiveTool('measure');
    state.setMeasureMode('polyline');
    state.setCentrelineOverlayEnabled(true);
  });
  await page.waitForFunction(() => typeof (globalThis as unknown as { __ifc_lite_source_segment_screen__?: ScreenProbe })
    .__ifc_lite_source_segment_screen__ === 'function', undefined, { timeout: 120_000 });
  const candidates = await page.evaluate(({ modelId, expressId }) => {
    const probe = (globalThis as unknown as { __ifc_lite_source_segment_screen__: ScreenProbe }).__ifc_lite_source_segment_screen__;
    const canvas = document.querySelector('canvas[data-viewport="main"]');
    const rect = canvas?.getBoundingClientRect();
    if (!rect) throw new Error('viewer canvas is missing');
    // Segment 0 of each authored bar is a line. Its two exact source
    // endpoints give an independent geometric witness for the clicked point.
    return [0.25, 0.5, 0.75]
      .map((t) => ({ segmentIndex: 0, screen: probe(modelId, expressId, 0, t) }))
      .filter((candidate) => candidate.screen && candidate.screen.x > rect.left + 20
        && candidate.screen.x < rect.right - 20 && candidate.screen.y > rect.top + 20
        && candidate.screen.y < rect.bottom - 20);
  }, { modelId, expressId: sweptDiskFixture.expressId });
  expect(candidates.length, 'at least one authored source segment projects inside the viewer').toBeGreaterThan(0);
  let witnessed: { x: number; y: number; segmentIndex: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.screen) continue;
    await page.mouse.move(candidate.screen.x, candidate.screen.y);
    try {
      await page.waitForFunction(({ expressId, segmentIndex }) => {
        const hit = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
          .__ifc_lite_viewer_store__.getState().snapTarget?.metadata?.sourceCurve;
        return hit?.expressId === expressId && hit.segmentIndex === segmentIndex;
      }, { expressId: sweptDiskFixture.expressId, segmentIndex: candidate.segmentIndex }, { timeout: 1_500 });
      witnessed = { ...candidate.screen, segmentIndex: candidate.segmentIndex };
      break;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('Timeout')) throw error;
    }
  }
  expect(witnessed, 'pointer hover resolves an authored source segment').not.toBeNull();
  const hover = await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().snapTarget);
  expect(hover?.metadata?.sourceCurve?.modelId).toBe(modelId);
  expect(hover?.metadata?.sourceCurve?.kind).toBe('line');
  expect(hover?.metadata?.sourceCurve?.length).toBeGreaterThan(0);
  await page.mouse.click(witnessed!.x, witnessed!.y);
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().activePolyline?.points.length ?? 0)).toBe(1);
  const clickState = await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    return { point: state.activePolyline?.points[0], snapTarget: state.snapTarget };
  });
  const clicked = clickState.point;
  expect(clicked).toBeDefined();
  expect(clickState.snapTarget?.metadata?.sourceCurve?.modelId).toBe(modelId);
  expect(clickState.snapTarget?.metadata?.sourceCurve?.segmentIndex).toBe(witnessed!.segmentIndex);
  const endpoints = await page.evaluate(({ modelId, expressId }) => {
    const probe = (globalThis as unknown as { __ifc_lite_source_segment_screen__: ScreenProbe }).__ifc_lite_source_segment_screen__;
    return [probe(modelId, expressId, 0, 0)?.world, probe(modelId, expressId, 0, 1)?.world];
  }, { modelId, expressId: sweptDiskFixture.expressId });
  const [start, end] = endpoints;
  expect(start).toBeDefined();
  expect(end).toBeDefined();
  const clickOnSource = distanceFromFiniteLine(clicked!, start!, end!);
  expect(clickOnSource.t).toBeGreaterThanOrEqual(0);
  expect(clickOnSource.t).toBeLessThanOrEqual(1);
  expect(clickOnSource.distance).toBeLessThan(1e-7);
  const frame = await capture();
  expect(frame).toMatch(/^data:image\/png;base64,/);
  const framePng = Buffer.from(frame!.split(',')[1], 'base64');
  await testInfo.attach(`${sweptDiskFixture.label} source snap`, { body: framePng, contentType: 'image/png' });
  if (process.env.SNAP_WITNESS_PNG) writeFileSync(process.env.SNAP_WITNESS_PNG, framePng);
  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setMeasureMode('drag'));
  const dragScreens = await page.evaluate(({ modelId, expressId }) => {
    const probe = (globalThis as unknown as { __ifc_lite_source_segment_screen__: ScreenProbe }).__ifc_lite_source_segment_screen__;
    return [probe(modelId, expressId, 0, 0.2), probe(modelId, expressId, 0, 0.8)];
  }, { modelId, expressId: sweptDiskFixture.expressId });
  expect(dragScreens[0]).not.toBeNull();
  expect(dragScreens[1]).not.toBeNull();
  await page.mouse.move(dragScreens[0]!.x, dragScreens[0]!.y);
  await page.mouse.down();
  await page.mouse.move(dragScreens[1]!.x, dragScreens[1]!.y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().measurements.length)).toBe(1);
  const drag = await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().measurements[0]);
  expect(drag).toBeDefined();
  for (const point of [drag!.start, drag!.end]) {
    const onSource = distanceFromFiniteLine(point, start!, end!);
    expect(onSource.t).toBeGreaterThanOrEqual(0);
    expect(onSource.t).toBeLessThanOrEqual(1);
    expect(onSource.distance).toBeLessThan(1e-7);
  }
  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setCentrelineOverlayEnabled(false));
  await page.waitForFunction(() => !(globalThis as unknown as { __ifc_lite_source_segment_screen__?: ScreenProbe })
    .__ifc_lite_source_segment_screen__);
  await page.mouse.move(witnessed!.x + 80, witnessed!.y + 80);
  await page.waitForTimeout(150); // Hover raycasts are deliberately throttled to 100 ms.
  await page.mouse.move(witnessed!.x, witnessed!.y);
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().snapTarget?.metadata?.sourceCurve)).toBeUndefined();
});
