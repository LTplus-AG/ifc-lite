/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared control parsing, load-path, and federation-id assertions for #5051. */
import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

export type Point3 = readonly [number, number, number];

export interface ControlFile {
  toleranceMetres: number;
  coordinateOrder: string;
  ifcMapOrigin: Point3;
  points: Array<{ id: string; local: Point3; projected: Point3 }>;
}

export interface ModelSnapshot {
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

export function controlFile(path: string): ControlFile {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error(`${path} is not an object`);
  const record = value as Record<string, unknown>;
  if (typeof record.toleranceMetres !== 'number' || !Number.isFinite(record.toleranceMetres)
    || typeof record.coordinateOrder !== 'string' || !Array.isArray(record.points)) {
    throw new Error(`${path} lacks numeric tolerance, coordinate order, or points`);
  }
  const points = record.points.map((point, index) => {
    if (typeof point !== 'object' || point === null) throw new Error(`${path} control point ${index + 1} is not an object`);
    const control = point as Record<string, unknown>;
    if (typeof control.id !== 'string' || control.id.length === 0) {
      throw new Error(`${path} control point ${index + 1} lacks an id`);
    }
    return { id: control.id, local: point3(control.local, `${control.id}.local`), projected: point3(control.projected, `${control.id}.projected`) };
  });
  return { toleranceMetres: record.toleranceMetres, coordinateOrder: record.coordinateOrder,
    ifcMapOrigin: point3(record.ifcMapOrigin, 'ifcMapOrigin'), points };
}

export function distance(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Renderer geometry is Y-up; control coordinates are engineering Z-up. */
export function renderToCanonical(point: Point3): Point3 {
  return [point[0], -point[2], point[1]];
}

export function canonicalToRender(point: Point3): { x: number; y: number; z: number } {
  return { x: point[0], y: point[2], z: -point[1] };
}

export function assertIndependentControls(controls: ControlFile): void {
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

export function assertCanonicalCorrespondences(
  controls: ControlFile,
  sourceName: string,
  candidates: readonly Point3[],
  expectedCoordinates: (control: ControlFile['points'][number]) => Point3 = (control) => control.local,
): void {
  const matched = new Set<number>();
  for (const point of controls.points) {
    const expected = expectedCoordinates(point);
    const distances = candidates.map((candidate) => distance(expected, candidate));
    const candidateIndex = distances.indexOf(Math.min(...distances));
    const error = distances[candidateIndex]!;
    expect(error, `${point.id}: ${sourceName} canonical control correspondence`)
      .toBeLessThanOrEqual(controls.toleranceMetres);
    expect(matched.has(candidateIndex), `${point.id}: ${sourceName} must not reuse a control`)
      .toBe(false);
    matched.add(candidateIndex);
  }
}

export async function waitForModels(page: Page, count: number, timeout: number): Promise<void> {
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
    { timeout },
  );
}

export async function loadThroughViewer(page: Page, file: string, expectedCount: number, timeout: number): Promise<void> {
  // Add is intentionally used for both additions so it passes
  // useIfcFederation.addModel → useIfcLoader.loadFile. These ids are stable
  // control contracts, unlike ordinal hidden file-input selectors.
  await page.locator(expectedCount === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(join(process.cwd(), file));
  await waitForModels(page, expectedCount, timeout);
}

export async function snapshotModels(page: Page): Promise<ModelSnapshot[]> {
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
        id, name: model.name, idOffset: model.idOffset, maxExpressId: model.maxExpressId,
        loadPath: model.loadPath, alignment: model.federationAlignmentStatus,
        pointCloudHandleId: model.pointCloudHandleId, visible: model.visible, vertices,
      };
    });
  });
}

export async function assertSingleModelResolution(page: Page, modelId: string): Promise<void> {
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

export async function assertFederatedResolution(page: Page, models: readonly ModelSnapshot[]): Promise<void> {
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
