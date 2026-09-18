/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `duplicateEntity` failed with `type "Unknown"` on any imported element
 * with an association (pset, type binding, material, ...) attached (#4933).
 * `getTypeName()` answers the literal string `'Unknown'`, not
 * `null`/`undefined`, for association rels the `EntityTable` carries no row
 * for; `getTypeName(id) || fallback` never fell back since `'Unknown'` is
 * truthy, so `StoreEditor.addEntity('Unknown', ...)` threw.
 *
 * Parses the real `hello-wall.ifc` sample rather than a hand-built fixture:
 * the bug is specifically about what the parser's categorisation omits from
 * the `EntityTable`, which a synthetic single-wall STEP string (see
 * `mutationSlice.duplicate-federated-bounds.test.ts`) doesn't reproduce.
 */

// FIRST import, before `@/store`: `useViewerStore` is constructed at module
// load, and `createChartSlice` / `createDocumentSlice` read `localStorage`
// while doing so — same reasoning as the sibling `#4929` duplicate-bounds
// suite (`mutationSlice.duplicate-federated-bounds.test.ts`).
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { modelRotationBaker } from '@/lib/model-placement/rotation-bake';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(__dirname, '../../../public/samples/hello-wall.ifc');
const MODEL = 'imported';

/** A minimal single-quad mesh, just enough for `getEntityBounds` to answer non-null. */
function meshFor(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
    origin: [0, 0, 0],
  } as MeshData;
}

function geometryOf(meshes: MeshData[]): GeometryResult {
  return {
    meshes,
    totalTriangles: 2 * meshes.length,
    totalVertices: 4 * meshes.length,
    coordinateInfo: {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
    },
  } as unknown as GeometryResult;
}

describe('duplicateEntity keeps the source IFC type for imported elements (#4933)', () => {
  it('duplicates a parsed wall with an attached pset and keeps its type + geometry', async () => {
    modelRotationBaker.clear();

    const buf = await readFile(SAMPLE);
    const dataStore = await new IfcParser().parseColumnar(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );

    // The first real IFCWALL instance (not IFCWALLTYPE) — hello-wall.ifc
    // carries a property set on it, which is what actually reproduces
    // #4933 (a bare product with no associations resolves its own type
    // fine; it's the association-rel lookup that broke).
    let wallId: number | null = null;
    for (const [id, ref] of dataStore.entityIndex.byId) {
      if (ref.type === 'IFCWALL' || ref.type === 'IFCWALLSTANDARDCASE') {
        wallId = id;
        break;
      }
    }
    assert.ok(wallId !== null, 'fixture must contain an IfcWall instance');
    const sourceType = dataStore.entities.getTypeName(wallId!);
    assert.notEqual(sourceType, 'Unknown', 'fixture wall must have a resolvable type');
    assert.ok(
      (dataStore.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []).length > 0,
      'fixture must carry at least one property association — that is what reproduces #4933',
    );

    const model = {
      ...fixtureModel(MODEL),
      ifcDataStore: dataStore,
      geometryResult: geometryOf([meshFor(wallId!)]),
      maxExpressId: 100000,
    } as unknown as ReturnType<typeof fixtureModel>;

    useViewerStore.setState({
      ...fixtureModels(model),
      geometryResult: geometryOf([meshFor(wallId!)]),
      modelPlacement: emptyPlacementState(),
      mutationViews: new Map([[MODEL, new MutablePropertyView(dataStore.properties || null, MODEL)]]),
      storeEditors: new Map(),
      undoStacks: new Map(),
      redoStacks: new Map(),
      geometryContentVersion: 0,
    });

    const result = useViewerStore.getState().duplicateEntity(MODEL, wallId!, '+X');
    assert.ok(!('error' in result), `duplicate failed: ${'error' in result ? result.error : ''}`);
    if ('error' in result) return; // unreachable, narrows for TS below

    // The copy keeps the source's IFC type — the #4933 regression: it used
    // to be the literal string 'Unknown'.
    const newEntities = useViewerStore.getState().mutationViews.get(MODEL)!.getNewEntities();
    const copy = newEntities.find((e) => e.expressId === result.expressId);
    assert.ok(copy, 'duplicate must land as a new overlay entity');
    assert.equal(copy!.type, sourceType, "copy's IFC type must match the source's");
    assert.notEqual(copy!.type, 'Unknown', 'copy must never be typed "Unknown"');

    // The copy has geometry: `duplicateEntity` mirrors the source's mesh,
    // offset, into the owning model's geometryResult so it renders.
    const meshes = useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes;
    const copyMesh = meshes.find((m) => m.expressId === result.globalId);
    assert.ok(copyMesh, 'duplicate must have a cloned mesh in the owning model geometry');
  });
});
