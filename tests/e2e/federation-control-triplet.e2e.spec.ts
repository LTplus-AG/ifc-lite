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
 * The oracle deliberately does not reproduce MapConversion, CRS, Y-up, RTC,
 * or point-cloud matrix maths. It compares the already-rendered IFC/LandXML
 * vertices, then reads XYZ positions through the product's magnetic point
 * picker. Thus a second ingest route or an ad-hoc test transform cannot make
 * this pass.
 */

import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ViewerState } from '../../apps/viewer/src/store';

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

type Point3 = readonly [number, number, number];

interface ControlFile {
  toleranceMetres: number;
  points: Array<{ id: string }>;
}

interface ModelSnapshot {
  id: string;
  name: string;
  loadPath: string | undefined;
  alignment: string | undefined;
  pointCloudHandleId: number | undefined;
  vertices: Point3[];
}

function controlFile(): ControlFile {
  const value: unknown = JSON.parse(readFileSync(CONTROL, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error(`${CONTROL} is not an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.toleranceMetres !== 'number' || !Array.isArray(record.points)) {
    throw new Error(`${CONTROL} lacks toleranceMetres or points`);
  }
  const points = record.points.map((point, index) => {
    if (typeof point !== 'object' || point === null || typeof (point as Record<string, unknown>).id !== 'string') {
      throw new Error(`${CONTROL} control point ${index + 1} lacks an id`);
    }
    return { id: (point as Record<string, unknown>).id as string };
  });
  return { toleranceMetres: record.toleranceMetres, points };
}

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Every asymmetric control must land on a different source vertex. */
function assertDistinctCorrespondences(
  controls: ControlFile,
  sourceName: string,
  points: readonly Point3[],
  candidates: readonly Point3[],
): void {
  const matched = new Set<number>();
  for (const [index, point] of points.entries()) {
    const distances = candidates.map((candidate) => distance(point, candidate));
    const candidateIndex = distances.indexOf(Math.min(...distances));
    const error = distances[candidateIndex]!;
    expect(error, `${controls.points[index]!.id}: ${sourceName} rendered control correspondence`)
      .toBeLessThanOrEqual(controls.toleranceMetres);
    expect(matched.has(candidateIndex), `${controls.points[index]!.id}: ${sourceName} must not reuse a control`)
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
        && [...state.models.values()].every((model) => !model.loadState || model.loadState === 'complete');
    },
    count,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

async function loadThroughViewer(page: Page, file: string, expectedCount: number): Promise<void> {
  // Input zero is Open; input one is Add model. The latter is intentionally
  // used for both additions so it passes useIfcFederation.addModel → loadFile.
  await page.locator('input[type=file]').nth(expectedCount === 1 ? 0 : 1).setInputFiles(join(process.cwd(), file));
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
        loadPath: model.loadPath,
        alignment: model.federationAlignmentStatus,
        pointCloudHandleId: model.pointCloudHandleId,
        vertices,
      };
    });
  });
}

test('canonical IFC + LandXML + XYZ federation keeps five independent bonsai-topo controls within tolerance (#5051)', async ({ page }, testInfo) => {
  const absent = FIXTURES.filter((fixture) => !existsSync(fixture));
  test.skip(absent.length > 0, `${absent.join(', ')} missing — run \`pnpm fixtures\``);
  const controls = controlFile();
  expect(controls.points, 'the control declaration keeps its five independently stated correspondences').toHaveLength(5);
  expect(controls.toleranceMetres, 'the control declaration remains a 1 mm acceptance').toBe(0.001);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await loadThroughViewer(page, IFC, 1);
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

  // The source files contribute exactly the independently stated controls:
  // no fixture-local offset or expected viewer-axis conversion appears here.
  expect(ifc!.vertices).toHaveLength(controls.points.length);
  expect(landxml!.vertices).toHaveLength(controls.points.length);
  assertDistinctCorrespondences(controls, 'IFC ↔ LandXML', ifc!.vertices, landxml!.vertices);

  // Keep the established camera framing while hiding the triangle sources.
  // The scan remains at the already-aligned render positions; opening the
  // Reposition tool only exposes its production magnetic picker and makes no
  // placement write.
  await page.evaluate(({ ifcId, landxmlId, xyzId }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.cameraCallbacks.frameEntities?.(
      [...state.models.get(ifcId)!.geometryResult!.meshes, ...state.models.get(landxmlId)!.geometryResult!.meshes]
        .map((mesh) => mesh.expressId),
    );
    state.setModelVisibility(ifcId, false);
    state.setModelVisibility(landxmlId, false);
    state.openReposition([xyzId]);
  }, { ifcId: ifc!.id, landxmlId: landxml!.id, xyzId: xyz!.id });
  await page.getByRole('button', { name: 'Frame both', exact: true }).click();

  const canvas = await page.locator('canvas').first().boundingBox();
  expect(canvas, 'viewer canvas').not.toBeNull();
  const scanPoints: Point3[] = [];
  for (const [index, control] of controls.points.entries()) {
    const projected = await page.evaluate((point) => globalThis.__ifc_lite_viewer_store__.getState()
      .cameraCallbacks.projectToScreen!({ x: point[0], y: point[1], z: point[2] }), ifc!.vertices[index]);
    expect(projected, `${control.id}: control projects into the viewer`).not.toBeNull();
    await page.getByRole('button', { name: 'Pick source point', exact: true }).click();
    await page.mouse.click(canvas!.x + projected!.x, canvas!.y + projected!.y);
    const picked = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.preview?.source ?? null);
    expect(picked, `${control.id}: magnetic picker finds the visible XYZ control`).not.toBeNull();
    expect(picked!.modelId, `${control.id}: picked source belongs to XYZ`).toBe(xyz!.id);
    scanPoints.push(picked!.point);
  }
  assertDistinctCorrespondences(controls, 'XYZ ↔ IFC', scanPoints, ifc!.vertices);
  assertDistinctCorrespondences(controls, 'XYZ ↔ LandXML', scanPoints, landxml!.vertices);
  const placements = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return [...state.models.keys()].map((id) => state.modelPlacement.placements.get(id)?.translation ?? [0, 0, 0]);
  });
  expect(placements, 'no manual or test-injected placement compensates the federation').toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  await testInfo.attach('bonsai-topo-control-correspondence', {
    body: JSON.stringify({ toleranceMetres: controls.toleranceMetres, controls: controls.points.map((control, index) => ({ id: control.id, xyz: scanPoints[index] })) }),
    contentType: 'application/json',
  });
});
