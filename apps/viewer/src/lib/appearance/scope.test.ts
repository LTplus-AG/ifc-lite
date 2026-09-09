/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store';
import type { MeshData } from '@ifc-lite/geometry';
import { appearanceOwners, appearanceScope } from './scope.js';
import type { AppearanceCatalog } from './planner-types.js';
import { appearanceMapping, DEFAULT_APPEARANCE_SETTINGS } from './settings.js';

async function model(id: string, idOffset: number): Promise<FederatedModel> {
  const source = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Scope fixture'),'2;1');
FILE_NAME('scope.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0Wall00000000000000001',$,'Wall A',$,$,$,$,$,.NOTDEFINED.);
#11=IFCWALL('0Wall00000000000000002',$,'Wall B',$,$,$,$,$,.NOTDEFINED.);
#12=IFCSLAB('0Slab00000000000000001',$,'Slab',$,$,$,$,$,.FLOOR.);
#20=IFCWALLTYPE('0Type00000000000000001',$,'Same name',$,$,$,$,$,$,.NOTDEFINED.);
#21=IFCWALLTYPE('0Type00000000000000002',$,'Same name',$,$,$,$,$,$,.NOTDEFINED.);
#30=IFCRELDEFINESBYTYPE('0Rel000000000000000001',$,$,$,(#10),#20);
#31=IFCRELDEFINESBYTYPE('0Rel000000000000000002',$,$,$,(#11),#21);
ENDSEC;
END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(source.buffer);
  const meshes: MeshData[] = [10, 11, 12].map(local => ({ expressId: local + idOffset,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }));
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  return { id, idOffset, maxExpressId: 31, name: id, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: source.length, ifcDataStore: store,
    geometryResult: { meshes, totalTriangles: 3, totalVertices: 9,
      coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } } };
}

// Native/actual-WASM tests establish effective IFC metadata. These values
// exercise only the UI's identity-based choice over that catalog contract.
const catalog: AppearanceCatalog = {
  sourceRevision: 'scope-fixture', missingProductIds: [],
  products: [{ productId: 10, ifcClass: 'IfcWall', typeIds: [20] },
    { productId: 11, ifcClass: 'IfcWall', typeIds: [21] }, { productId: 12, ifcClass: 'IfcSlab', typeIds: [] }],
  types: [{ typeId: 20, ifcClass: 'IfcWallType', Name: 'Same name' },
    { typeId: 21, ifcClass: 'IfcWallType', Name: 'Same name' }],
};

describe('appearance scope and physical mapping #4243', () => {
  it('isolates federation selection and distinguishes types with identical names', async () => {
    const a = await model('a', 0), b = await model('b', 1_000_000);
    useViewerStore.setState({ models: new Map([['a', a], ['b', b]]), mutationViews: new Map(),
      selectedEntityIds: new Set([10, 1_000_011]), selectedEntityId: 1_000_011 });
    const state = useViewerStore.getState();
    assert.deepEqual(appearanceScope(catalog, appearanceOwners(state, 'a').selectedProductIds, { kind: 'selection' }).productIds, [10]);
    assert.deepEqual(appearanceScope(catalog, appearanceOwners(state, 'b').selectedProductIds, { kind: 'selection' }).productIds, [11]);
    assert.deepEqual(appearanceScope(catalog, [], { kind: 'class', ifcClass: 'IfcWall' }).productIds, [10, 11]);
    const scope = appearanceScope(catalog, [], { kind: 'type', typeId: 21 });
    assert.deepEqual(scope.productIds, [11]);
    assert.deepEqual(scope.types.map(type => type.id), [20, 21]);
  });
  it('honors deleted owners and zero-offset single-model selection', async () => {
    const a = await model('a', 0);
    const view = new MutablePropertyView(a.ifcDataStore!.properties, 'a');
    view.deleteEntity(11);
    useViewerStore.setState({ models: new Map([['a', a]]), mutationViews: new Map([['a', view]]),
      selectedEntityIds: new Set([10, 11]), selectedEntityId: 10 });
    assert.deepEqual(appearanceOwners(useViewerStore.getState(), 'a').productIds, [10, 12]);
    assert.deepEqual(appearanceOwners(useViewerStore.getState(), 'a').selectedProductIds, [10]);
  });
  it('keeps a rotated projection frame orthonormal and preserves physical tile dimensions', () => {
    for (const plane of ['xy', 'xz', 'yz'] as const) {
      const mapping = appearanceMapping({ ...DEFAULT_APPEARANCE_SETTINGS, plane,
        rotationDegrees: 37, tileWidth: 2, tileHeight: 3 });
      assert.equal(mapping.kind, 'planar');
      if (mapping.kind !== 'planar') throw new Error('Expected planar mapping');
      assert.ok(Math.abs(mapping.axisU.reduce((sum, value, i) => sum + value * mapping.axisV[i], 0)) < 1e-12);
      assert.ok(Math.abs(Math.hypot(...mapping.axisU) - 1) < 1e-12);
      assert.ok(Math.abs(Math.hypot(...mapping.axisV) - 1) < 1e-12);
      assert.deepEqual(mapping.metresPerTile, [2, 3]);
    }
  });
});
