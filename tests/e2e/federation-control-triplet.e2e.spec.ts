/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical, format-neutral federation acceptance for the CC0 bonsai-topo
 * control triplet (#5051). The IFC, LandXML and XYZ files are independently
 * authored representations of five asymmetric survey controls. This test
 * intentionally drives the viewer's Open/Add file controls: Open reaches
 * useIfcLoader.loadFile and each Add reaches useIfcFederation.addModel, its
 * deliberately thin wrapper around that same loadFile route.
 *
 * The control file declares local engineering coordinates and independently
 * authored projected coordinates. The test normalizes only the renderer's
 * documented Y-up frame back to that local engineering frame; it does not
 * reconstruct MapConversion, CRS, RTC, or point-cloud alignment matrices.
 * Thus a second ingest route or an ad-hoc test transform cannot make this
 * pass.
 */

import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ViewerState } from '../../apps/viewer/src/store';
import { assertIsolatedRenderedContent, ordinaryGpuSelectControl, snapshotRenderedPointCloud } from './federation-control-triplet.rendering';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

const CONTROL_DIR = 'tests/models/landxml/federation/bonsai-topo-control-v1';
const CONTROL = `${CONTROL_DIR}/control.json`;
const IFC = `${CONTROL_DIR}/terrain.ifc`;
const LANDXML = `${CONTROL_DIR}/terrain.xml`;
const XYZ = `${CONTROL_DIR}/survey.xyz`;
const FIXTURES = [CONTROL, IFC, LANDXML, XYZ] as const;
const LOAD_TIMEOUT_MS = 120_000;
const GPU_STRICT = process.env.E2E_GPU_STRICT !== '0';

type Point3 = readonly [number, number, number];

interface ControlFile {
  toleranceMetres: number;
  coordinateOrder: string;
  ifcMapOrigin: Point3;
  points: Array<{ id: string; local: Point3; projected: Point3 }>;
}

interface ModelSnapshot {
  id: string;
  name: string;
  idOffset: number;
  maxExpressId: number;
  loadPath: string | undefined;
  alignment: string | undefined;
  pointCloudHandleId: number | undefined;
  visible: boolean;
  vertices: Point3[];
}

function point3(value: unknown, label: string): Point3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => typeof component === 'number' && Number.isFinite(component))) {
    throw new Error(`${label} must be three finite numeric coordinates`);
  }
  return [value[0], value[1], value[2]];
}

function controlFile(): ControlFile {
  const value: unknown = JSON.parse(readFileSync(CONTROL, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error(`${CONTROL} is not an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.toleranceMetres !== 'number' || !Number.isFinite(record.toleranceMetres)
    || typeof record.coordinateOrder !== 'string' || !Array.isArray(record.points)) {
    throw new Error(`${CONTROL} lacks numeric tolerance, coordinate order, or points`);
  }
  const points = record.points.map((point, index) => {
    if (typeof point !== 'object' || point === null) throw new Error(`${CONTROL} control point ${index + 1} is not an object`);
    const control = point as Record<string, unknown>;
    if (typeof control.id !== 'string' || control.id.length === 0) {
      throw new Error(`${CONTROL} control point ${index + 1} lacks an id`);
    }
    return { id: control.id, local: point3(control.local, `${control.id}.local`), projected: point3(control.projected, `${control.id}.projected`) };
  });
  return { toleranceMetres: record.toleranceMetres, coordinateOrder: record.coordinateOrder,
    ifcMapOrigin: point3(record.ifcMapOrigin, 'ifcMapOrigin'), points };
}

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Renderer geometry is Y-up; control coordinates are engineering Z-up. */
function renderToCanonical(point: Point3): Point3 {
  return [point[0], -point[2], point[1]];
}

function canonicalToRender(point: Point3): { x: number; y: number; z: number } {
  return { x: point[0], y: point[2], z: -point[1] };
}

function assertIndependentControls(controls: ControlFile): void {
  expect(controls.coordinateOrder).toBe('easting,northing,elevation');
  expect(controls.points, 'the control declaration keeps five stated correspondences').toHaveLength(5);
  expect(new Set(controls.points.map((point) => point.id)).size, 'control ids are independent').toBe(controls.points.length);
  for (const point of controls.points) {
    for (let axis = 0; axis < 3; axis++) {
      expect(point.projected[axis] - controls.ifcMapOrigin[axis], `${point.id}: projected/local axis ${axis}`).toBeCloseTo(point.local[axis], 9);
    }
  }
  for (let index = 0; index < controls.points.length; index++) {
    for (let other = index + 1; other < controls.points.length; other++) {
      expect(distance(controls.points[index]!.local, controls.points[other]!.local),
        `${controls.points[index]!.id}/${controls.points[other]!.id}: controls must remain distinct`).toBeGreaterThan(controls.toleranceMetres);
    }
  }
}

function assertCanonicalCorrespondences(
  controls: ControlFile,
  sourceName: string,
  candidates: readonly Point3[],
): void {
  const matched = new Set<number>();
  for (const point of controls.points) {
    const distances = candidates.map((candidate) => distance(point.local, candidate));
    const candidateIndex = distances.indexOf(Math.min(...distances));
    const error = distances[candidateIndex]!;
    expect(error, `${point.id}: ${sourceName} canonical control correspondence`)
      .toBeLessThanOrEqual(controls.toleranceMetres);
    expect(matched.has(candidateIndex), `${point.id}: ${sourceName} must not reuse a control`)
      .toBe(false);
    matched.add(candidateIndex);
  }
}

async function waitForModels(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const state = globalThis.__ifc_lite_viewer_store__?.getState();
      return Boolean(state)
        && !state.loading
        && !state.geometryStreamingActive
        && state.models.size === expected
        && [...state.models.values()].every((model) => model.pointCloudHandleId !== undefined
          || (model.geometryResult?.meshes.length ?? 0) > 0)
        && [...state.models.values()].every((model) => model.visible)
        && (expected < 3 || state.pointCloudAssetCount >= 1)
        && [...state.models.values()].every((model) => !model.loadState || model.loadState === 'complete');
    },
    count,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

async function loadThroughViewer(page: Page, file: string, expectedCount: number): Promise<void> {
  // Add is intentionally used for both additions so it passes
  // useIfcFederation.addModel → useIfcLoader.loadFile. These ids are stable
  // control contracts, unlike ordinal hidden file-input selectors.
  await page.locator(expectedCount === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(join(process.cwd(), file));
  await waitForModels(page, expectedCount);
}

async function snapshotModels(page: Page): Promise<ModelSnapshot[]> {
  return page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return [...state.models.entries()].map(([id, model]) => {
      const vertices: Array<[number, number, number]> = [];
      for (const mesh of model.geometryResult?.meshes ?? []) {
        const origin = mesh.origin ?? [0, 0, 0];
        for (let index = 0; index < mesh.positions.length; index += 3) {
          const vertex: [number, number, number] = [
            mesh.positions[index] + origin[0],
            mesh.positions[index + 1] + origin[1],
            mesh.positions[index + 2] + origin[2],
          ];
          if (!vertices.some((other) => Math.hypot(
            vertex[0] - other[0], vertex[1] - other[1], vertex[2] - other[2],
          ) < 1e-7)) vertices.push(vertex);
        }
      }
      return {
        id,
        name: model.name,
        idOffset: model.idOffset,
        maxExpressId: model.maxExpressId,
        loadPath: model.loadPath,
        alignment: model.federationAlignmentStatus,
        pointCloudHandleId: model.pointCloudHandleId,
        visible: model.visible,
        vertices,
      };
    });
  });
}

async function assertSingleModelResolution(page: Page, modelId: string): Promise<void> {
  const resolution = await page.evaluate((id) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = state.models.get(id)!;
    const localId = model.geometryResult!.meshes[0]!.expressId - model.idOffset;
    const globalId = state.toGlobalId(id, localId);
    return { localId, globalId, from: state.fromGlobalId(globalId), resolved: state.resolveGlobalIdFromModels(globalId) };
  }, modelId);
  expect(resolution.globalId, 'single-model global id retains express id').toBe(resolution.localId);
  expect(resolution.from).toEqual({ modelId, expressId: resolution.localId });
  expect(resolution.resolved).toEqual({ modelId, expressId: resolution.localId });
}

async function assertFederatedResolution(page: Page, models: readonly ModelSnapshot[]): Promise<void> {
  const resolution = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return [...state.models.values()].map((model) => {
      const localId = model.maxExpressId;
      const globalId = state.toGlobalId(model.id, localId);
      return { modelId: model.id, localId, globalId, from: state.fromGlobalId(globalId),
        owner: state.findModelForGlobalId(globalId), resolved: state.resolveGlobalIdFromModels(globalId) };
    });
  });
  expect(resolution).toHaveLength(models.length);
  expect(new Set(resolution.map((entry) => entry.globalId)).size, 'N-model control ids do not alias').toBe(models.length);
  for (const entry of resolution) {
    expect(entry.from).toEqual({ modelId: entry.modelId, expressId: entry.localId });
    expect(entry.owner).toBe(entry.modelId);
    expect(entry.resolved).toEqual({ modelId: entry.modelId, expressId: entry.localId });
  }
}

interface PlacementSnapshot {
  modelId: string;
  translation: Point3;
  rotation: { angle: number; pivot: Point3 };
  locked: boolean;
}

interface PickedControl {
  source: { modelId: string; point: Point3 } | null;
  target: { modelId: string; point: Point3 } | null;
  delta: Point3;
  modelIds: readonly string[];
  before: PlacementSnapshot[];
  placements: PlacementSnapshot[];
}

async function pickControlThroughRenderer(
  page: Page, control: { id: string; local: Point3 }, movingModelId: string, referenceModelId: string,
): Promise<PickedControl> {
  await page.evaluate((movingId) => globalThis.__ifc_lite_viewer_store__.getState().openReposition([movingId]), movingModelId);
  await page.getByLabel('Reference model', { exact: true }).selectOption(referenceModelId);
  await page.getByRole('button', { name: 'Frame both', exact: true }).click();
  const projected = await page.evaluate((point) => globalThis.__ifc_lite_viewer_store__.getState()
    .cameraCallbacks.projectToScreen!(point), canonicalToRender(control.local));
  expect(projected, `${control.id}: control projects into the viewer`).not.toBeNull();
  const canvas = await page.locator('canvas').first().boundingBox();
  expect(canvas, 'viewer canvas').not.toBeNull();
  await page.getByRole('button', { name: 'Pick source point', exact: true }).click();
  await page.mouse.click(canvas!.x + projected!.x, canvas!.y + projected!.y);
  await expect(page.getByRole('button', { name: 'Pick target point', exact: true })).toBeEnabled();
  await page.mouse.click(canvas!.x + projected!.x, canvas!.y + projected!.y);
  const picked = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const preview = state.modelPlacement.preview;
    return {
      source: preview?.source ?? null,
      target: preview?.target ?? null,
      delta: preview?.delta ?? [0, 0, 0],
      modelIds: preview?.modelIds ?? [],
      before: [...(preview?.before ?? new Map()).entries()].map(([modelId, placement]) => ({ modelId, ...placement })),
      placements: [...state.models.keys()].map((modelId) => ({ modelId, ...(state.modelPlacement.placements.get(modelId)
        ?? { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }) })),
    };
  });
  return picked;
}

function assertPickedControl(
  control: { id: string; local: Point3 }, picked: PickedControl, movingModelId: string, referenceModelId: string, tolerance: number,
): void {
  expect(picked.modelIds).toEqual([movingModelId]);
  expect(picked.before).toEqual([{
    modelId: movingModelId, translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false,
  }]);
  expect(picked.source, `${control.id}: moving source is picked from its requested model`).not.toBeNull();
  expect(picked.target, `${control.id}: fixed target is picked from its requested model`).not.toBeNull();
  expect(picked.source!.modelId).toBe(movingModelId);
  expect(picked.target!.modelId).toBe(referenceModelId);
  expect(distance(picked.source!.point, control.local), `${control.id}: source canonical point`).toBeLessThanOrEqual(tolerance);
  expect(distance(picked.target!.point, control.local), `${control.id}: target canonical point`).toBeLessThanOrEqual(tolerance);
  expect(Math.hypot(...picked.delta), `${control.id}: aligned pair has no preview compensation`).toBeLessThanOrEqual(tolerance);
  for (const placement of picked.placements) {
    expect(placement, `${control.id}: preview leaves committed ${placement.modelId} placement unchanged`).toEqual({
      modelId: placement.modelId, translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false,
    });
  }
}

test('canonical IFC + LandXML + XYZ federation keeps five independent bonsai-topo controls within tolerance (#5051)', async ({ page }, testInfo) => {
  const absent = FIXTURES.filter((fixture) => !existsSync(fixture));
  test.skip(absent.length > 0, `${absent.join(', ')} missing — run \`pnpm fixtures\``);
  const controls = controlFile();
  expect(controls.toleranceMetres, 'the control declaration remains a 1 mm acceptance').toBe(0.001);
  assertIndependentControls(controls);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await loadThroughViewer(page, IFC, 1);
  const primary = (await snapshotModels(page)).find((model) => model.name === 'terrain.ifc');
  expect(primary, 'IFC model registered from the primary load').toBeDefined();
  await assertSingleModelResolution(page, primary!.id);
  await loadThroughViewer(page, LANDXML, 2);
  await loadThroughViewer(page, XYZ, 3);

  const models = await snapshotModels(page);
  expect(models).toHaveLength(3);
  const ifc = models.find((model) => model.name === 'terrain.ifc');
  const landxml = models.find((model) => model.name === 'terrain.xml');
  const xyz = models.find((model) => model.name === 'survey.xyz');
  expect(ifc, 'IFC model registered from the primary load').toBeDefined();
  expect(landxml, 'LandXML model registered from the same federated load path').toBeDefined();
  expect(xyz, 'XYZ model registered from the same federated load path').toBeDefined();

  expect(ifc!.loadPath).toBe('wasm');
  expect(landxml!.loadPath).toBe('landxml');
  expect(xyz!.loadPath).toBe('point-cloud');
  expect(ifc!.alignment).toBe('anchor');
  expect(landxml!.alignment).toBe('same-crs');
  expect(xyz!.pointCloudHandleId, 'XYZ reached the streamed point-cloud renderer').toBeDefined();
  expect(models.every((model) => model.visible), 'every control source is visibly enabled').toBe(true);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().pointCloudAssetCount),
    'the renderer reports the XYZ streamed asset as ready').toBeGreaterThanOrEqual(1);
  await assertFederatedResolution(page, models);

  // The product has already performed CRS/MapConversion/RTC alignment. Only
  // undo its documented Y-up render frame before comparing independent control
  // coordinates; this test contains no fixture-local origin or CRS transform.
  expect(ifc!.vertices).toHaveLength(controls.points.length);
  expect(landxml!.vertices).toHaveLength(controls.points.length);
  assertCanonicalCorrespondences(controls, 'IFC', ifc!.vertices.map(renderToCanonical));
  assertCanonicalCorrespondences(controls, 'LandXML', landxml!.vertices.map(renderToCanonical));

  // Streamed XYZ positions are deliberately absent from GeometryResult: they
  // are transformed by the production point renderer after decode. The
  // viewport hook reads the retained production sample through that exact live
  // renderer matrix, so none of the MapConversion/RTC alignment is recreated
  // in this test. All five stated correspondences must survive independently.
  const renderedXyz = await snapshotRenderedPointCloud(page, xyz!.pointCloudHandleId!, LOAD_TIMEOUT_MS);
  expect(renderedXyz.pointCount, 'XYZ stream contains all five declared controls').toBe(controls.points.length);
  expect(renderedXyz.points, 'XYZ renderer sample contains all five declared controls').toHaveLength(controls.points.length);
  assertCanonicalCorrespondences(controls, 'XYZ renderer', renderedXyz.points.map(renderToCanonical));

  // Hide the overlapping sources one at a time and assert that each one
  // actually paints. The PNG density is an assertion, not a screenshot-only
  // attachment, and Frame moving is the normal production model framing path.
  const renderedContent = [
    await assertIsolatedRenderedContent(page, ifc!.id, GPU_STRICT),
    await assertIsolatedRenderedContent(page, landxml!.id, GPU_STRICT),
    await assertIsolatedRenderedContent(page, xyz!.id, GPU_STRICT),
  ];

  // In addition to magnetic placement picks below, prove normal viewport
  // clicks reach the ordinary GPU pick/selection channel while model isolation
  // removes the ambiguity of three coincident control representations.
  const ordinarySelections = {
    ifc: await ordinaryGpuSelectControl(page, ifc!.id, controls.points[0]!, canonicalToRender, GPU_STRICT),
    landxml: await ordinaryGpuSelectControl(page, landxml!.id, controls.points[0]!, canonicalToRender, GPU_STRICT),
    xyz: await ordinaryGpuSelectControl(page, xyz!.id, controls.points[0]!, canonicalToRender, GPU_STRICT),
  };
  if (GPU_STRICT) {
    expect(ordinarySelections.ifc.selectedEntityId, 'ordinary IFC GPU pick supplies a renderer highlight id').not.toBeNull();
    expect(ordinarySelections.ifc.selectedEntity?.modelId, 'ordinary IFC GPU pick retains federation owner').toBe(ifc!.id);
    expect(ordinarySelections.landxml.selectedEntityId, 'LandXML uses its source-selection channel, not an invented IFC id').toBeNull();
    expect(ordinarySelections.landxml.selectedLandXmlSource?.modelId, 'ordinary LandXML GPU pick retains its source owner').toBe(landxml!.id);
    expect(ordinarySelections.landxml.selectedModelId, 'ordinary LandXML GPU pick selects its model').toBe(landxml!.id);
    expect(ordinarySelections.xyz.selectedEntityId, 'ordinary XYZ GPU pick supplies the synthetic renderer id').not.toBeNull();
    expect(ordinarySelections.xyz.selectedEntity?.modelId, 'ordinary XYZ GPU pick retains federation owner').toBe(xyz!.id);
  }

  // Restore the federated visual state before model-to-model placement picks.
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.clearEntitySelection();
    state.setModelsVisibility(state.models.keys(), true);
  });
  await waitForModels(page, 3);

  // These are real magnetic picks, constrained by the production Reposition
  // panel to the named moving/reference models. Every XYZ control must be
  // independently picked against IFC; the source model constraint prevents a
  // coincident IFC/LandXML vertex from making the scan path pass by accident.
  const ifcToLandxml = await pickControlThroughRenderer(page, controls.points[0]!, ifc!.id, landxml!.id);
  assertPickedControl(controls.points[0]!, ifcToLandxml, ifc!.id, landxml!.id, controls.toleranceMetres);
  await page.keyboard.press('Escape');
  const xyzToIfc: Record<string, PickedControl> = {};
  for (const control of controls.points) {
    const picked = await pickControlThroughRenderer(page, control, xyz!.id, ifc!.id);
    assertPickedControl(control, picked, xyz!.id, ifc!.id, controls.toleranceMetres);
    xyzToIfc[control.id] = picked;
    await page.keyboard.press('Escape');
  }
  await page.keyboard.press('Escape');
  const placementState = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return {
      preview: state.modelPlacement.preview,
      placements: [...state.models.keys()].map((modelId) => ({ modelId, ...(state.modelPlacement.placements.get(modelId)
        ?? { translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false }) })),
    };
  });
  expect(placementState.preview, 'closing the panel clears preview placement state').toBeNull();
  for (const placement of placementState.placements) {
    expect(placement, `no manual or test-injected placement compensates ${placement.modelId}`).toEqual({
      modelId: placement.modelId, translation: [0, 0, 0], rotation: { angle: 0, pivot: [0, 0, 0] }, locked: false,
    });
  }
  await testInfo.attach('bonsai-topo-control-correspondence', {
    body: JSON.stringify({ toleranceMetres: controls.toleranceMetres, controls: controls.points,
      renderedXyz, renderedContent, ordinarySelections,
      previews: { ifcToLandxml, xyzToIfc }, placementState }),
    contentType: 'application/json',
  });
});
