/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real Revit IFC witness for hover, click and drag measurement on authored curves (#5780). */
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = process.env.REBAR_IFC ?? join(process.cwd(), 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc');
type SourceHit = { modelId: string; expressId: number; segmentIndex: number; kind: 'line' | 'arc'; length: number; t: number };
type BrowserState = {
  models: Map<string, { id: string; ifcDataStore?: { entityCount: number } | null }>;
  geometryResult?: { meshes: unknown[] };
  snapTarget?: { position: { x: number; y: number; z: number }; metadata?: { sourceCurve?: SourceHit } } | null;
  activePolyline?: { points: Array<{ x: number; y: number; z: number }> } | null;
  measurements: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }>;
  toGlobalId(modelId: string, expressId: number): number;
  setSelectedEntity(ref: { modelId: string; expressId: number }): void;
  setSelectedEntityId(id: number): void;
  setSelectedEntityIds(ids: number[]): void;
  setCentrelineOverlayEnabled(enabled: boolean): void;
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

test('selected Revit source curve snaps on hover, click and drag, then clears with overlay (#5780)', async ({ page }, testInfo) => {
  test.skip(!existsSync(FIXTURE), `Revit Snowdon IFC missing at ${FIXTURE}; run pnpm fixtures or provide REBAR_IFC`);
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await page.locator('#file-input-open').setInputFiles(FIXTURE);
  await page.waitForFunction(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__?: BrowserStore }).__ifc_lite_viewer_store__?.getState();
    const model = state?.models.values().next().value;
    return state?.models.size === 1 && state.geometryResult?.meshes?.length > 0
      && (model?.ifcDataStore?.entityCount ?? 0) > 0;
  }, undefined, { timeout: 300_000 });
  const modelId = await page.evaluate(() => {
    const state = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore }).__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    if (!model) throw new Error('loaded IFC model is missing');
    const id = state.toGlobalId(model.id, 132347);
    state.setSelectedEntity({ modelId: model.id, expressId: 132347 });
    state.setSelectedEntityId(id);
    state.setSelectedEntityIds([id]);
    state.cameraCallbacks.frameEntities?.([id]);
    state.setActiveTool('measure');
    state.setMeasureMode('polyline');
    state.setCentrelineOverlayEnabled(true);
    return model.id;
  });
  await page.waitForFunction(() => typeof (globalThis as unknown as { __ifc_lite_source_segment_screen__?: ScreenProbe })
    .__ifc_lite_source_segment_screen__ === 'function', undefined, { timeout: 120_000 });
  const candidates = await page.evaluate((id) => {
    const probe = (globalThis as unknown as { __ifc_lite_source_segment_screen__: ScreenProbe }).__ifc_lite_source_segment_screen__;
    const canvas = document.querySelector('canvas[data-viewport="main"]');
    const rect = canvas?.getBoundingClientRect();
    if (!rect) throw new Error('viewer canvas is missing');
    // Segment 0 of this authored Revit bar is a line. Its two exact source
    // endpoints give an independent geometric witness for the clicked point.
    return [0.25, 0.5, 0.75]
      .map((t) => ({ segmentIndex: 0, screen: probe(id, 132347, 0, t) }))
      .filter((candidate) => candidate.screen && candidate.screen.x > rect.left + 20
        && candidate.screen.x < rect.right - 20 && candidate.screen.y > rect.top + 20
        && candidate.screen.y < rect.bottom - 20);
  }, modelId);
  expect(candidates.length, 'at least one Revit source segment projects inside the viewer').toBeGreaterThan(0);
  let witnessed: { x: number; y: number; segmentIndex: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.screen) continue;
    await page.mouse.move(candidate.screen.x, candidate.screen.y);
    try {
      await page.waitForFunction((segmentIndex) => {
        const hit = (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
          .__ifc_lite_viewer_store__.getState().snapTarget?.metadata?.sourceCurve;
        return hit?.expressId === 132347 && hit.segmentIndex === segmentIndex;
      }, candidate.segmentIndex, { timeout: 1_500 });
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
  const endpoints = await page.evaluate((id) => {
    const probe = (globalThis as unknown as { __ifc_lite_source_segment_screen__: ScreenProbe }).__ifc_lite_source_segment_screen__;
    return [probe(id, 132347, 0, 0)?.world, probe(id, 132347, 0, 1)?.world];
  }, modelId);
  const [start, end] = endpoints;
  expect(start).toBeDefined();
  expect(end).toBeDefined();
  const clickOnSource = distanceFromFiniteLine(clicked!, start!, end!);
  expect(clickOnSource.t).toBeGreaterThanOrEqual(0);
  expect(clickOnSource.t).toBeLessThanOrEqual(1);
  expect(clickOnSource.distance).toBeLessThan(1e-7);
  const frame = await page.evaluate(() => (globalThis as unknown as {
    __ifc_lite_capture_color_frame__: () => Promise<string | null>;
  }).__ifc_lite_capture_color_frame__());
  expect(frame).toMatch(/^data:image\/png;base64,/);
  await testInfo.attach('Snowdon source snap', { body: Buffer.from(frame!.split(',')[1], 'base64'), contentType: 'image/png' });
  await page.evaluate(() => (globalThis as unknown as { __ifc_lite_viewer_store__: BrowserStore })
    .__ifc_lite_viewer_store__.getState().setMeasureMode('drag'));
  const dragScreens = await page.evaluate((id) => {
    const probe = (globalThis as unknown as { __ifc_lite_source_segment_screen__: ScreenProbe }).__ifc_lite_source_segment_screen__;
    return [probe(id, 132347, 0, 0.2), probe(id, 132347, 0, 0.8)];
  }, modelId);
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
