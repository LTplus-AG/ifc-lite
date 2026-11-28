/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { setGlobalRendererRef } from '../hooks/useBCF.js';
import { resolveInstancedExportGate, withInstancedMeshes } from './instancedExport.js';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';

function mesh(expressId: number, verts: number, tris: number): MeshData {
  return {
    expressId,
    ifcType: 'IfcWall',
    positions: new Float32Array(verts * 3),
    normals: new Float32Array(verts * 3),
    indices: new Uint32Array(tris * 3),
    color: [1, 1, 1, 1],
  };
}

function baseGeometry(): GeometryResult {
  return {
    meshes: [mesh(1, 3, 1)],
    totalTriangles: 1,
    totalVertices: 3,
    // coordinateInfo is irrelevant to this helper.
    coordinateInfo: {} as GeometryResult['coordinateInfo'],
  };
}

/** Install a fake global renderer whose scene returns `instanced` (or no scene
 *  when `instanced` is null). */
function setRenderer(instanced: MeshData[] | null): void {
  const scene = instanced === null ? undefined : { getAllInstancedMeshData: () => instanced };
  const fake = { getScene: () => scene } as unknown as Renderer;
  setGlobalRendererRef({ current: fake } as RefObject<Renderer | null>);
}

describe('withInstancedMeshes', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  // CALIBRATION (#2865/#2878 follow-up): proves the id-range filter actually
  // excludes another loaded model's instanced occurrences — not that the gate
  // was simply removed. `mesh(2, ...)`'s global id (2) falls OUTSIDE this
  // model's declared bracket (idOffset 100, so ids 101..150), the way a
  // DIFFERENT federated model's occurrence would.
  it('excludes an instanced occurrence outside this model\'s id-range bracket', () => {
    const geom = baseGeometry();
    setRenderer([mesh(2, 3, 1)]);
    assert.equal(withInstancedMeshes(geom, { idOffset: 100, maxExpressId: 50 }), geom);
  });

  // The federated-gap counterpart: an occurrence INSIDE this model's own
  // bracket IS adopted — the id-range filter is a scope, not a second
  // primary-only gate in disguise.
  it('appends an instanced occurrence inside this model\'s id-range bracket', () => {
    const geom = baseGeometry();
    setRenderer([mesh(107, 4, 2)]);
    const out = withInstancedMeshes(geom, { idOffset: 100, maxExpressId: 50 });
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 107]);
  });

  // A model-scoped call materializes only its own entities: the placement index calls this once
  // per model, and building every model's occurrences each time made an N-model federation
  // build N copies of all of them (4-5 model local federations sat in back-to-back major GCs).
  it('materializes only the entities inside the model range when the scene can enumerate them', () => {
    const geom = baseGeometry();
    const materialized: number[] = [];
    const scene = {
      getAllInstancedMeshData: () => { throw new Error('a scoped call must not materialize every model'); },
      getInstancedEntityIds: () => [2, 101, 107, 150, 151, 9000][Symbol.iterator](),
      getInstancedMeshDataPieces: (id: number) => { materialized.push(id); return [mesh(id, 3, 1), mesh(id, 3, 1)]; },
    };
    setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
    const out = withInstancedMeshes(geom, { idOffset: 100, maxExpressId: 50 });
    assert.deepEqual(materialized, [101, 107, 150], 'only ids idOffset+1 .. idOffset+maxExpressId are built');
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 101, 101, 107, 107, 150, 150]);
    assert.equal(out.totalTriangles, 1 + 6, 'totals count every appended piece');
  });

  it('still materializes every model when no model range is given', () => {
    const geom = baseGeometry();
    const scene = {
      getAllInstancedMeshData: () => [mesh(2, 3, 1), mesh(9000, 3, 1)],
      getInstancedEntityIds: () => { throw new Error('an unscoped call reads the whole scene'); },
      getInstancedMeshDataPieces: () => { throw new Error('an unscoped call reads the whole scene'); },
    };
    setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>);
    assert.deepEqual(withInstancedMeshes(geom, null).meshes.map((m) => m.expressId), [1, 2, 9000]);
  });

  it('returns the geometryResult unchanged when the scene has no instanced meshes', () => {
    const geom = baseGeometry();
    setRenderer([]);
    assert.equal(withInstancedMeshes(geom, null), geom);
  });

  it('appends instanced occurrences and recomputes totals, unfiltered when modelRange is null', () => {
    const geom = baseGeometry();
    setRenderer([mesh(2, 4, 2), mesh(3, 5, 3)]);
    const out = withInstancedMeshes(geom, null);

    assert.notEqual(out, geom); // a copy, not mutated in place
    assert.equal(geom.meshes.length, 1); // original untouched
    assert.equal(out.meshes.length, 3);
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 2, 3]);
    // 1 (base) + 2 + 3 instanced triangles; 3 + 4 + 5 vertices.
    assert.equal(out.totalTriangles, 6);
    assert.equal(out.totalVertices, 12);
  });

  it('appends instanced occurrences and recomputes totals, filtered to a model-id-range bracket', () => {
    const geom = baseGeometry();
    setRenderer([mesh(2, 4, 2), mesh(3, 5, 3)]);
    const out = withInstancedMeshes(geom, { idOffset: 0, maxExpressId: 10 });

    assert.notEqual(out, geom); // a copy, not mutated in place
    assert.equal(geom.meshes.length, 1); // original untouched
    assert.equal(out.meshes.length, 3);
    assert.deepEqual(out.meshes.map((m) => m.expressId), [1, 2, 3]);
    // 1 (base) + 2 + 3 instanced triangles; 3 + 4 + 5 vertices.
    assert.equal(out.totalTriangles, 6);
    assert.equal(out.totalVertices, 12);
  });

  it('is a no-op when the renderer scene is unavailable', () => {
    const geom = baseGeometry();
    setRenderer(null);
    assert.equal(withInstancedMeshes(geom, null), geom);
  });
});

describe('resolveInstancedExportGate', () => {
  // CALIBRATION (PR #2878 review): before this helper existed,
  // `GeoreferencingPanel` fell through to `instancedModelRange: null` (no
  // filter) whenever its own `modelId` didn't resolve — INCLUDING while a
  // federation of other models was loaded. Pin the leaky case: an unresolved
  // model id with more than one model loaded must withhold the export, not
  // return `null`.
  it('withholds the export when the model id is unresolved and other models are loaded', () => {
    const models = new Map([
      ['a', { idOffset: 0, maxExpressId: 50 }],
      ['b', { idOffset: 50, maxExpressId: 30 }],
    ]);
    const result = resolveInstancedExportGate(undefined, models);
    assert.equal(result.canExport, false);
    assert.equal(result.instancedModelRange, null);
  });

  it('withholds the export when the model id no longer matches a loaded model, federated', () => {
    const models = new Map([
      ['a', { idOffset: 0, maxExpressId: 50 }],
      ['b', { idOffset: 50, maxExpressId: 30 }],
    ]);
    const result = resolveInstancedExportGate('stale-id', models);
    assert.equal(result.canExport, false);
    assert.equal(result.instancedModelRange, null);
  });

  it('resolves the model\'s own bracket and allows the export when the id matches', (t) => {
    const initial = useViewerStore.getState();
    t.after(() => useViewerStore.setState(initial, true));
    const federation = fixtureModels(
      { ...fixtureModel('a'), maxExpressId: 50 },
      { ...fixtureModel('b', { idOffset: 50 }), maxExpressId: 30 },
    );
    useViewerStore.setState(federation);
    const { models } = federation;
    const owner = modelIndices(models).get('b');
    assert.notEqual(owner, undefined);
    const result = resolveInstancedExportGate('b', models);
    assert.equal(result.canExport, true);
    assert.deepEqual(result.instancedModelRange, { modelId: 'b', idOffset: 50, maxExpressId: 30, rendererModelIndex: owner });
  });

  // `null` (no filter) is safe ONLY when this is provably the sole loaded
  // model — an unresolved id here has nothing else to wrongly include.
  it('allows an unfiltered export when the unresolved model is provably the only one loaded', () => {
    const models = new Map([['__legacy__', { idOffset: 0, maxExpressId: 50 }]]);
    const result = resolveInstancedExportGate(undefined, models);
    assert.equal(result.canExport, true);
    assert.equal(result.instancedModelRange, null);
  });

  it('allows an unfiltered export when zero models are loaded', () => {
    const result = resolveInstancedExportGate(undefined, new Map());
    assert.equal(result.canExport, true);
    assert.equal(result.instancedModelRange, null);
  });
});

describe('instanced range owner (#10695)', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('the KMZ range keeps an overlapping-id model\'s instanced occurrences out', (t) => {
    // A collab model can share the id bracket; only the renderer model index tells its occurrences apart.
    const initial = useViewerStore.getState();
    t.after(() => useViewerStore.setState(initial, true));
    const federation = fixtureModels(
      { ...fixtureModel('A'), maxExpressId: 10 },
      { ...fixtureModel('B'), maxExpressId: 10 },
    );
    useViewerStore.setState(federation);
    const { models } = federation;
    const index = modelIndices(models);
    assert.equal(index.size, 2);
    setRenderer([{ ...mesh(5, 3, 1), modelIndex: index.get('A') }, { ...mesh(5, 3, 1), modelIndex: index.get('B') }]);
    const { instancedModelRange } = resolveInstancedExportGate('A', models);
    const out = withInstancedMeshes(baseGeometry(), instancedModelRange);
    assert.deepEqual(out.meshes.map(m => m.modelIndex), [undefined, index.get('A')]);
  });
});
