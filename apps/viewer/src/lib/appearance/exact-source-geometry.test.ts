/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Appearance on `?compactGeom` meshes (#11424 known limit): a compact mesh carries no canonical corner
// provenance, so the products a plan binds are re-meshed exactly before the preview binds to them.

import { afterEach, before, beforeEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { adoptCompactMeshes, loadCompactGeometry, type CompactPayload } from '@ifc-lite/geometry/compact';
import { federationRegistry, type Renderer } from '@ifc-lite/renderer';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { installScriptedMesher, triangleFor } from '@/test/scripted-mesher.js';
import { setGlobalRendererRef } from '@/lib/renderer-ref.js';
import { ensureExactSourceGeometry, planProductIds } from './exact-source-geometry.js';

const MODEL = 'm';
/** The model's federation offset: store and scene meshes carry global ids, plans model-local ones. */
let OFFSET = 0;
const FIXTURE = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#10=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,.NOTDEFINED.);
#20=IFCWALL('0Wall00000000000000002',$,'Other',$,$,$,$,$,.NOTDEFINED.);
ENDSEC;END-ISO-10303-21;`;

/** The wall as a compact load delivers it: a shell over its records, naming its IFC item, with no corner provenance. */
function compactWall(expressId: number, geometryItemId: number): MeshData {
  const payload: CompactPayload = {
    records: new Uint8Array(36), indices: Uint16Array.from([0, 1, 2]), table: Uint32Array.from([0, 0, 3, 0, 3, 10]),
    windows: new Float64Array(3), bounds: Float64Array.from([0, 0, 0, 1, 1, 0]), cells: new Int32Array(3),
  };
  const mesh = { expressId, geometryItemId, color: [1, 1, 1, 1], positions: new Float32Array(0), normals: new Float32Array(0),
    indices: new Uint32Array(0), compact: { batch: 0, row: 0 } } as unknown as MeshData;
  adoptCompactMeshes([mesh], [payload]);
  return mesh;
}

/** An exact f32 mesh as the load (and the re-mesh) stamps it. */
function exactMesh(expressId: number, geometryItemId: number): MeshData {
  const mesh = triangleFor(expressId);
  return { ...mesh, geometryItemId, appearanceSource: { kind: 'canonical-item', indices: mesh.indices, sourceIndices: mesh.indices } };
}

const meshesOf = (globalId: number) => useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.filter((mesh) => mesh.expressId === globalId);
const signal = () => new AbortController().signal;

let mesher: ReturnType<typeof installScriptedMesher>;
before(async () => { await loadCompactGeometry(); });
beforeEach(async () => {
  federationRegistry.clear();
  federationRegistry.registerModel('earlier', 500); // a model loaded first, so this one's ids are offset
  OFFSET = federationRegistry.registerModel(MODEL, 100);
  const bytes = new TextEncoder().encode(FIXTURE);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const coordinateInfo = { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false,
    wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } };
  const geometryResult = { meshes: [compactWall(OFFSET + 10, OFFSET + 11), exactMesh(OFFSET + 20, OFFSET + 21)], totalTriangles: 2, totalVertices: 6, coordinateInfo } as unknown as GeometryResult;
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel(MODEL, { idOffset: OFFSET }), ifcDataStore: store, geometryResult, schemaVersion: 'IFC4' } as unknown as FederatedModel),
    geometryResult, editEnabled: true,
    mutationViews: new Map([[MODEL, new MutablePropertyView(store.properties || null, MODEL)]]),
    storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), removedNewEntities: new Map(), removedMeshes: new Map(),
    pendingMeshRemovals: null, pendingMeshEdits: null, mutationVersion: 0,
  });
  // The worker meshes the model-local subgraph; the re-mesh service takes the result to global ids.
  mesher = installScriptedMesher((request) => [...request.targets].map((id) => exactMesh(id, id + 1)));
});
afterEach(() => { mesher.restore(); setGlobalRendererRef(null); federationRegistry.clear(); });

it('re-meshes exactly only the planned products whose meshes lack corner provenance', async () => {
  await ensureExactSourceGeometry(MODEL, planProductIds({ items: [{ productId: 10 }, { productId: 20 }, { productId: 10 }] }), signal());
  assert.deepEqual(mesher.requests.map((request) => [...request.targets]), [[10]], 'the compact wall only; the exact one is left alone');
  const [wall] = meshesOf(OFFSET + 10);
  assert.equal(wall.compact, undefined);
  assert.equal(wall.appearanceSource?.sourceIndices, wall.indices, 'it now carries the canonical corners appearance binds to');

  await ensureExactSourceGeometry(MODEL, [10, 20], signal());
  assert.equal(mesher.requests.length, 1, 'exact meshes are not re-meshed again');
});

it('leaves products outside the plan compact', async () => {
  await ensureExactSourceGeometry(MODEL, [20], signal());
  assert.equal(mesher.requests.length, 0);
  assert.ok(meshesOf(OFFSET + 10)[0].compact);
});

it('waits until the 3D view draws the re-meshed products before the preview binds', async () => {
  // The viewport swaps re-meshed meshes in on its own commit: here, three polls after the store has them.
  let polls = 0;
  // Polls 1-2: still the compact piece; 3: none (the old one removed, the new one not yet added); then exact.
  const scene = { getMeshDataPieces: (id: number) => (id !== OFFSET + 10 ? meshesOf(id)
    : ++polls > 3 ? meshesOf(id) : polls === 3 ? undefined : [compactWall(id, id + 1)]) };
  setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
  await ensureExactSourceGeometry(MODEL, [10], signal());
  assert.ok(polls > 3, 'it did not bind against the compact scene meshes');

  // A later run (the panel re-runs when the re-mesh changes the model) finds the store exact, yet still
  // waits while the scene draws the product from records.
  polls = 0;
  await ensureExactSourceGeometry(MODEL, [10], signal());
  assert.equal(mesher.requests.length, 1, 'not re-meshed again');
  assert.ok(polls > 3, 'the second run waited past the compact pieces and the gap too');
});

it('refuses at once, instead of re-meshing in a loop, when the re-mesh brings no provenance', async () => {
  mesher.restore();
  mesher = installScriptedMesher((request) => [...request.targets].map((id) => ({ ...triangleFor(id), geometryItemId: id + 1 })));
  await assert.rejects(ensureExactSourceGeometry(MODEL, [10], signal()), /carries no corner provenance/);
  assert.equal(mesher.requests.length, 1);
});

it('says why when the exact geometry cannot be prepared', async () => {
  mesher.restore();
  mesher = installScriptedMesher(() => { throw new Error('mesher down'); });
  await assert.rejects(ensureExactSourceGeometry(MODEL, [10], signal()), /could not be prepared for appearance \(mesher down\)/);
});
