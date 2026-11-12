/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The whole-model shape walk behind the status bar's element count and the
 * model metadata panel's "Elements with Geometry" is one memo: after a load
 * settles it runs once, not once per consumer, and both read the same number.
 */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { sharedEffectivePhysicalEntityIds } from './physical-objects.js';
import { computeModelStats } from '@/components/viewer/properties/modelMetadataStats';
import { ownedAggregationRelationships } from '@/utils/entity-ownership';

/** Loaded at runtime so a build without the shared selector fails these assertions instead of failing to load (revert oracle). */
async function shared() {
  const mod = (await import('./object-count.js')) as Record<string, unknown>;
  assert.equal(typeof mod.sharedShapedObjectCount, 'function', 'object-count.ts must export sharedShapedObjectCount');
  assert.equal(typeof mod.modelLocalIdResolver, 'function', 'object-count.ts must export modelLocalIdResolver');
  return mod as unknown as typeof import('./object-count.js');
}

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000aa',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building000000000000a',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('0Storey00000000000000a',$,'00',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);
#6=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',());
#7=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#10=IFCWALL('0Wall10000000000000000',$,'W1',$,$,$,#7,$,$);
#11=IFCWALL('0Wall11000000000000000',$,'W2',$,$,$,#7,$,$);
#12=IFCWALL('0Wall12000000000000000',$,'W3',$,$,$,#7,$,$);
#20=IFCRELAGGREGATES('0Agg200000000000000000',$,$,$,#1,(#2));
#21=IFCRELAGGREGATES('0Agg210000000000000000',$,$,$,#2,(#3));
#22=IFCRELAGGREGATES('0Agg220000000000000000',$,$,$,#3,(#4));
#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont30000000000000000',$,$,$,(#10,#11,#12),#4);
ENDSEC;
END-ISO-10303-21;`;

const OFFSET = 1000;
function geometry(globalIds: readonly number[]): GeometryResult {
  const meshes = globalIds.map((expressId) => ({
    expressId, positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  }) as MeshData);
  return { meshes, totalTriangles: meshes.length, totalVertices: meshes.length * 3 } as GeometryResult;
}
async function parse(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(STEP).buffer, { disableWorkerScan: true });
}

it('the status bar count and the panel statistics share one walk and agree', async () => {
  const { sharedShapedObjectCount, modelLocalIdResolver } = await shared();
  const store = await parse();
  // A federated model at an id offset; one id belongs to another model.
  const geo = geometry([10 + OFFSET, 11 + OFFSET, 99_999]);
  let resolveCalls = 0;
  const resolveInModel = (id: number) => {
    resolveCalls++;
    return id >= OFFSET && id < OFFSET + 100 ? { modelId: 'model_b', expressId: id - OFFSET } : { modelId: 'model_a', expressId: id };
  };
  const physicalIds = sharedEffectivePhysicalEntityIds(store, null, 0);

  // The panel reads first.
  const stats = computeModelStats(store, geo, {
    physicalIds, geometryReady: true, modelId: 'model_b', toLocalId: modelLocalIdResolver('model_b', { resolveGlobalIdInModel: () => null, fromGlobalId: resolveInModel }),
  });
  const afterPanel = resolveCalls;
  assert.equal(stats.elementsWithGeometry, 2, 'W1 and W2 have meshes; the foreign id is not this model\'s');
  assert.equal(afterPanel, 3, 'one resolution per mesh');

  // The status bar reads the same model with its own resolver closure.
  const total = sharedShapedObjectCount({
    modelId: 'model_b', physicalIds, geometryResult: geo, geometryReady: true,
    relationships: ownedAggregationRelationships(store, null), toLocalId: modelLocalIdResolver('model_b', { resolveGlobalIdInModel: () => null, fromGlobalId: resolveInModel }),
  });
  assert.equal(total, stats.elementsWithGeometry, 'both consumers read the same number');
  assert.equal(resolveCalls, afterPanel, 'the second consumer did not walk again');
});

it('an edit (a new physical-id set) or new geometry recomputes; nothing else does', async () => {
  const { sharedShapedObjectCount, modelLocalIdResolver } = await shared();
  const store = await parse();
  let calls = 0;
  const toLocalId = modelLocalIdResolver('legacy', { resolveGlobalIdInModel: () => null, fromGlobalId: () => null });
  const counting = (id: number) => { calls++; return toLocalId(id); };
  const read = (ids: ReadonlySet<number>, geo: GeometryResult) => sharedShapedObjectCount({
    modelId: 'legacy', physicalIds: ids, geometryResult: geo, geometryReady: true, toLocalId: counting,
  });
  const geoA = geometry([10, 11]);
  const v0 = sharedEffectivePhysicalEntityIds(store, null, 0);
  assert.equal(read(v0, geoA), 2);
  assert.equal(read(v0, geoA), 2);
  assert.equal(calls, 2, 'the repeat read is a hit');

  const geoB = geometry([10, 11, 12]);
  assert.equal(read(v0, geoB), 3, 'new geometry: recomputed');
  const v1 = sharedEffectivePhysicalEntityIds(store, null, 1);
  assert.notEqual(v1, v0, 'a mutation version builds a new id set');
  assert.equal(read(v1, geoB), 3, 'an edit: recomputed against the new set');
  assert.equal(calls, 5, 'geometry B was mapped once, then reused for the edited set');
});

it('a repeat read of the same model is a hit: the shape walk does not run again', async () => {
  const { sharedShapedObjectCount, modelLocalIdResolver } = await shared();
  const store = await parse();
  const owned = ownedAggregationRelationships(store, null)!;
  let walks = 0;
  const relationships = { ...owned, getRelated: (...args: Parameters<typeof owned.getRelated>) => { walks++; return owned.getRelated(...args); } };
  const read = () => sharedShapedObjectCount({
    modelId: 'walk', physicalIds: sharedEffectivePhysicalEntityIds(store, null, 7), geometryResult: geo, geometryReady: true,
    relationships, toLocalId: modelLocalIdResolver('legacy', { resolveGlobalIdInModel: () => null, fromGlobalId: () => null }),
  });
  const geo = geometry([10]);
  assert.equal(read(), 1);
  const first = walks;
  assert.ok(first > 0, 'the unmeshed walls were checked for aggregated geometry');
  assert.equal(read(), 1);
  assert.equal(walks, first, 'the second read did not walk');
});

it('a federated model named like a legacy id still resolves its offset (review: default at idOffset 1000)', async () => {
  const { modelLocalIdResolver } = await shared();
  const toLocalId = modelLocalIdResolver('default', {
    resolveGlobalIdInModel: (modelId, id) => (modelId === 'default' && id >= 1000 ? { expressId: id - 1000 } : null),
    fromGlobalId: () => null,
  });
  assert.equal(toLocalId(1010), 10, 'renderer id 1010 is local wall #10, not 1010');
  const legacy = modelLocalIdResolver('legacy', { resolveGlobalIdInModel: () => null, fromGlobalId: () => null });
  assert.equal(legacy(10), 10, 'a legacy store with no federation entry keeps its ids');
  const federated = modelLocalIdResolver('model_b', { resolveGlobalIdInModel: () => null, fromGlobalId: () => null });
  assert.equal(federated(10), undefined, 'an unresolved id is not a federated model\'s');
});
