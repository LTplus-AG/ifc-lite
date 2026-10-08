/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan-to-BIM frames of #6894 at `models.size` 1 and N. Proposals are
 * made in the workspace world; creation goes back to the render frame and
 * through the target storey's workplane. The oracle is that workplane, the
 * map every Model workspace command writes through: a storey-local point
 * drawn in the render frame, seen by the scan there, must come back to the
 * same storey-local point, whatever RTC, origin shift, rotation and
 * placement the target and the anchor carry.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore, type ViewerState } from '@/store';
import type { FederatedModel } from '@/store/types';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { testPlacement } from '@/lib/model-placement/test-fixtures';
import { composeStoreyWorkplane } from '@/lib/commands/modeling/workplane';
import { invertAffine, scanToModelMatrix, sectionBoxToScanRegion, workspaceToRender } from './scan-model-frame';

type V3 = [number, number, number];
const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };

function info(originShift: V3, wasmRtcOffset?: V3): CoordinateInfo {
  const [x, y, z] = originShift;
  return {
    originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: true, originShift: { x, y, z },
    ...(wasmRtcOffset ? { wasmRtcOffset: { x: wasmRtcOffset[0], y: wasmRtcOffset[1], z: wasmRtcOffset[2] } } : {}),
  } as CoordinateInfo;
}

function model(id: string, loadedAt: number, coordinateInfo?: CoordinateInfo, extra: Partial<FederatedModel> = {}): FederatedModel {
  const geometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0, ...(coordinateInfo ? { coordinateInfo } : {}) };
  return { ...fixtureModel(id), loadedAt, geometryResult, ...extra } as FederatedModel;
}

function stateWith(models: FederatedModel[], placements: Array<[string, V3]> = []): ViewerState {
  return {
    ...useViewerStore.getState(),
    models: new Map(models.map((m) => [m.id, m])),
    modelPlacement: { ...emptyPlacementState(), placements: new Map(placements.map(([id, t]) => [id, testPlacement(t)])) },
  };
}

/** Column-major point cloud matrix: rotate `degrees` about the render up (Y), then translate. */
function cloudMatrix(degrees: number, t: V3): number[] {
  const r = (degrees * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, t[0], t[1], t[2], 1];
}

const applyColumnMajor = (m: ArrayLike<number>, p: V3): V3 =>
  [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) as V3;
const applyRowMajor = (m: number[], p: V3): V3 =>
  [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]) as V3;

function assertClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-6): void {
  for (let a = 0; a < 3; a++) assert.ok(Math.abs(actual[a] - expected[a]) <= tolerance, `${Array.from(actual)} vs ${Array.from(expected)}`);
}

/** The target storey's workplane, as `buildStoreyWorkplane` composes it. */
function storeyPlane(state: ViewerState, target: FederatedModel, plan: { origin: [number, number]; degrees: number }, elevation: number) {
  const r = (plan.degrees * Math.PI) / 180;
  const placement = state.modelPlacement.placements.get(target.id);
  return composeStoreyWorkplane({
    modelId: target.id,
    spec: { kind: 'storey', storeyId: 40, offset: 0 },
    plan: { origin: plan.origin, axisX: [Math.cos(r), Math.sin(r)] },
    elevation,
    coordinateInfo: target.geometryResult?.coordinateInfo,
    alignment: null,
    placement: { translation: placement?.translation ?? [0, 0, 0], rotation: placement?.rotation ?? { angle: 0, pivot: [0, 0, 0] } },
  });
}

/** Storey-local `local` -> rendered -> seen by the scan -> workspace world -> render -> storey-local. */
function roundTrip(state: ViewerState, cloud: number[], plane: ReturnType<typeof storeyPlane>, local: V3): { world: V3; back: V3 } {
  const rendered = plane.localToRender(local) as V3;
  const sample = applyColumnMajor(invertAffine(cloud)!, rendered);
  const world = applyRowMajor(scanToModelMatrix(state, cloud), sample);
  return { world, back: plane.renderToLocal(workspaceToRender(state, world)) as V3 };
}

describe('scan to model frame (#6894)', () => {
  const local: V3 = [12.5, -3.25, 2.7];

  it('models.size 1: a lone IFC model with no offsets maps the scan by the axis swap alone', () => {
    const ifc = model('ifc', 1);
    const state = stateWith([ifc]);
    const cloud = cloudMatrix(0, [0, 0, 0]);
    assert.deepEqual(scanToModelMatrix(state, cloud), [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    const { world, back } = roundTrip(state, cloud, storeyPlane(state, ifc, { origin: [0, 0], degrees: 0 }, 0), local);
    assertClose(world, local, 1e-9);
    assertClose(back, local);
  });

  it('models.size N: an RTC anchor, a shifted, rotated, placed target and an aligned scan round-trip through the storey workplane', () => {
    const anchor = model('anchor', 1, info([0, 0, 0], [2_600_000, 1_200_000, 410]));
    const target = model('target', 2, info([10, 20, 30], [2_600_000, 1_200_000, 410]));
    const scan = model('scan', 3, undefined, { pointCloudHandleId: 7 });
    const state = stateWith([anchor, target, scan], [['target', [1, 2, 3]]]);
    const cloud = cloudMatrix(30, [5, -1.5, 8]);
    const plane = storeyPlane(state, target, { origin: [2_600_010, 1_200_005], degrees: 17 }, 3.2);
    const { world, back } = roundTrip(state, cloud, plane, local);
    assertClose(back, local, 1e-5);
    // The workspace world is georeferenced: the anchor's RTC is restored.
    assert.ok(Math.abs(world[0] - 2_600_000) < 100 && Math.abs(world[1] - 1_200_000) < 100, `${world}`);
    // The composed map stays a proper rotation: Rust refuses anything else.
    const m = scanToModelMatrix(state, cloud);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
    assert.ok(Math.abs(det - 1) < 1e-6, `det ${det}`);
    // A second IFC model in the same federation: same scan, its own storey frame.
    const other = model('other', 4, info([-7, 4, 0.5], [2_600_000, 1_200_000, 410]));
    const four = stateWith([anchor, target, scan, other], [['target', [1, 2, 3]], ['other', [0, -4, 0]]]);
    assertClose(roundTrip(four, cloud, storeyPlane(four, other, { origin: [2_599_990, 1_200_000], degrees: -40 }, 0), local).back, local, 1e-5);
  });

  it('the workspace world is the georeferenced IFC world: plan position plus storey height plus the RTC height', () => {
    const anchor = model('anchor', 1, info([0, 0, 0], [2_600_000, 1_200_000, 410]));
    const scan = model('scan', 2, undefined, { pointCloudHandleId: 7 });
    const state = stateWith([anchor, scan]);
    const cloud = cloudMatrix(-25, [3, 0.5, -4]);
    const plane = storeyPlane(state, anchor, { origin: [2_600_010, 1_200_005], degrees: 0 }, 3.2);
    // Storey elevation is building-relative, net of the RTC height (workplane.ts).
    assertClose(roundTrip(state, cloud, plane, local).world, [2_600_022.5, 1_200_001.75, 410 + 3.2 + 2.7], 1e-5);
  });

  it('the section box maps back into the sample frame as a region that holds every point inside it', () => {
    const cloud = cloudMatrix(30, [5, -1.5, 8]);
    const box = { min: [4, -2, 6] as V3, max: [7, 1, 9] as V3 };
    const region = sectionBoxToScanRegion(box, cloud)!;
    for (const x of [4.1, 5.5, 6.9]) for (const y of [-1.9, 0, 0.9]) for (const z of [6.1, 7.5, 8.9]) {
      const sample = applyColumnMajor(invertAffine(cloud)!, [x, y, z]);
      for (let a = 0; a < 3; a++) assert.ok(sample[a] >= region.min[a] - 1e-9 && sample[a] <= region.max[a] + 1e-9);
    }
    // Unrotated, the region is exactly the box shifted back.
    const exact = sectionBoxToScanRegion(box, cloudMatrix(0, [5, -1.5, 8]))!;
    assertClose(exact.min, [-1, -0.5, -2]);
    assertClose(exact.max, [2, 2.5, 1]);
  });
});
