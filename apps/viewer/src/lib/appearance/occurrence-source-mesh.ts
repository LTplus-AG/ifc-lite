/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import type { AppearancePlan } from './planner-types';
import { nativeMeshFrame } from './native-mesh-frame';

type Conversion = NonNullable<AppearancePlan['conversions']>[number];

/** Reserve the complete native payload before any per-occurrence typed allocation. */
export function validateOccurrenceSourceBudget(conversions: readonly Conversion[]): void {
  if (conversions.length > 10_000) throw new Error('Occurrence source geometry exceeds the appearance budget.');
  let vertices = 0, corners = 0;
  const reserve = (positions: readonly number[], indices: readonly number[]) => {
    const count = positions.length / 3;
    vertices += count; corners += indices.length;
    if (!Number.isSafeInteger(count) || count <= 0 || count > 1_000_000
      || vertices > 2_000_000 || corners > 1_500_000) throw new Error('Occurrence source geometry exceeds the appearance budget.');
  };
  for (const conversion of conversions) {
    if ((conversion.sourceRemovedMeshes?.length ?? 0) > 10_000) throw new Error('Companion source count exceeds the appearance budget.');
    for (const mesh of conversion.sourceRemovedMeshes ?? []) reserve(mesh.positions, mesh.indices);
    // Old planners still support existing resident flat geometry, but cannot
    // supply canonical materialization for an instanced occurrence.
    if (conversion.sourcePositions === undefined) continue;
    reserve(conversion.sourcePositions, conversion.sourceIndices);
  }
}

export function occurrenceSourceMesh(state: ViewerState, modelId: string, conversion: Conversion): MeshData {
  validateOccurrenceSourceBudget([conversion]);
  const { sourcePositions: positions, sourceNormals: normals, sourceOrigin: origin,
    sourceColor: color, rtcOffset: rtc, sourceIndices } = conversion;
  if (!positions || !normals || normals.length !== positions.length
    || !origin || origin.length !== 3 || !rtc || rtc.length !== 3 || !color || color.length !== 4
    || !sourceIndices.length || sourceIndices.length % 3
    || !positions.every(Number.isFinite) || !normals.every(Number.isFinite)
    || !origin.every(Number.isFinite) || !rtc.every(Number.isFinite) || !color.every(Number.isFinite)
    || sourceIndices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= positions.length / 3)) {
    throw new Error('The native planner did not provide valid canonical occurrence geometry. Reload with the current runtime.');
  }
  const frame = nativeMeshFrame(state, modelId, positions, normals, origin, rtc);
  if (!frame.positions.every(Number.isFinite) || !frame.normals.every(Number.isFinite)) {
    throw new Error('Occurrence source coordinates exceed the renderer range.');
  }
  const indices = new Uint32Array(sourceIndices);
  return { ...frame, expressId: state.toGlobalId(modelId, conversion.productId),
    geometryItemId: state.toGlobalId(modelId, conversion.sourceGeometryItemId), indices, color: [...color],
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
}
