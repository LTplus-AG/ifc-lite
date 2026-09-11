/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAppearanceCorners, type Renderer } from '@ifc-lite/renderer';
import type { ViewerState } from '@/store';
import { bindAppearancePreview } from './preview.js';
import type { AppearancePlan } from './planner-types.js';

function plan(conversion: Partial<NonNullable<AppearancePlan['conversions']>[number]>): AppearancePlan {
  const indices = [0, 1, 2];
  return { sourceRevision: 'r', nextExpressId: 100, nextAvailableExpressId: 104, created: [], edits: [], removed: [], exclusions: [],
    items: [{ productId: 25, geometryItemId: 101, texCoords: [], texCoordIndex: [], sourceIndices: indices, targetIndices: indices,
      targetVertexCount: 3, previewCornerUvs: [0, 0, 1, 0, 0, 1], targetCornerNormals: [0, 1, 0, 0, 1, 0, 0, 1, 0] }],
    conversions: [{ productId: 25, representationId: 23, sourceGeometryItemId: 11, geometryItemId: 101, sourceIndices: indices,
      sourcePositions: [0, 0, 0, 1, 0, 0, 0, 1, 0], sourceNormals: [0, 0, 1, 0, 0, 1, 0, 0, 1], sourceOrigin: [0, 0, 0],
      sourceColor: [1, 1, 1, 1], rtcOffset: [0, 0, 0], surfaceFingerprint: 'f'.repeat(64), ...conversion }] };
}
// The renderer preview replaces an owner's parts one-to-one; a masked plan
// splits one part in two, so the binder refuses it before touching the scene.
const state = { toGlobalId: (_model: string, id: number) => id } as unknown as ViewerState;
const renderer = { getScene: () => ({ getMeshDataPieces: () => undefined, isInstancedEntity: () => false }) } as unknown as Renderer;
const bind = (masked: AppearancePlan) => bindAppearancePreview(state, renderer, 'model', masked, {} as ImageBitmap, 'textures/a.png', true, true, expandAppearanceCorners);

test('a face-masked conversion is refused explicitly by the preview binder (#4404)', () => {
  assert.throws(() => bind(plan({ maskedTriangles: [0], retainedGeometryItemId: 102 })), /face selection on IFC object #25/);
  assert.throws(() => bind(plan({ retainedGeometryItemId: 102 })), /face selection on IFC object #25/);
  // The same plan without a mask passes the guard and fails only on the absent scene geometry.
  assert.throws(() => bind(plan({})), /Geometry for IFC object #25 is not available/);
});
