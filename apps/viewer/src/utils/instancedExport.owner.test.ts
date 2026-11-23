/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RefObject } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { setGlobalRendererRef } from '../hooks/useBCF.js';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';
import { withInstancedMeshes } from './instancedExport.js';
import { modelIndices } from '@/lib/model-placement/model-indices';

const tri = (expressId: number, modelIndex?: number): MeshData => ({ expressId, ...(modelIndex === undefined ? {} : { modelIndex }),
  positions: new Float32Array(9), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] });
const flat: GeometryResult = { meshes: [tri(1)], totalTriangles: 1, totalVertices: 3, coordinateInfo: {} as GeometryResult['coordinateInfo'] };

function withScene(occurrences: MeshData[], run: () => void) {
  const scene = { isGeometryDataReleased: () => false, getAllInstancedMeshData: () => occurrences, placeAppearanceSource: (m: MeshData) => m };
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
  try { run(); } finally { setGlobalRendererRef({ current: null } as RefObject<Renderer | null>); }
}

it('#10887 a single model\'s occurrence without a modelIndex is exported under a modelId-only range', () => {
  const initial = useViewerStore.getState();
  useViewerStore.setState({ models: new Map([['solo', { ...fixtureModel('solo'), geometryResult: flat, idOffset: 0, maxExpressId: 100 }]]) } as never);
  try {
    withScene([tri(77)], () => {
      const out = withInstancedMeshes(flat, { modelId: 'solo', idOffset: 0, maxExpressId: 100 });
      assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 77], 'the canonical single-model fallback keeps the occurrence');
    });
  } finally { useViewerStore.setState(initial, true); }
});

it('#10887 in a federation an occurrence without a modelIndex is ambiguous and fails closed for an owner-scoped export', () => {
  const initial = useViewerStore.getState();
  useViewerStore.setState({ models: new Map([
    ['a', { ...fixtureModel('a'), geometryResult: flat, idOffset: 0, maxExpressId: 100 }],
    ['b', { ...fixtureModel('b'), geometryResult: flat, idOffset: 100, maxExpressId: 100 }],
  ]) } as never);
  try {
    withScene([tri(77)], () => {
      assert.throws(() => withInstancedMeshes(flat, { modelId: 'a', idOffset: 0, maxExpressId: 100 }), GeometryUnavailableError);
    });
    withScene([tri(77, modelIndices(useViewerStore.getState().models).get('a'))], () => {
      const out = withInstancedMeshes(flat, { modelId: 'a', idOffset: 0, maxExpressId: 100 });
      assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 77], 'an owned occurrence is kept');
    });
  } finally { useViewerStore.setState(initial, true); }
});
