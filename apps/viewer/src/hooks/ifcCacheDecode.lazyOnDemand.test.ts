/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane: a cache hit's on-demand property/quantity/material maps are built
// on first read, not before the load is interactive. The first read must return
// exactly what the eager build returned.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StringTable, EntityTableBuilder, PropertyTableBuilder, QuantityTableBuilder, RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { BinaryCacheWriter, type CacheDataStore } from '@ifc-lite/cache';
import { NOOP_LOAD_TRACE, type LoadTrace } from '@ifc-lite/load-trace';
import { decodeCachedMetadata } from './ifcCacheDecode.js';
import { rebuildOnDemandMaps } from '../utils/spatialHierarchy.js';

const WALLS = [10, 11, 12, 13];
const PSETS = [50, 51];
const QSET = 60;

async function entry() {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(16, strings);
  const relationships = new RelationshipGraphBuilder();
  entities.add(1, 'IfcProject', 'p', 'Project', '', '', false, false);
  for (const id of WALLS) entities.add(id, 'IfcWall', `w${id}`, `Wall ${id}`, '', '', true, false);
  // pset 50 -> walls 10, 11; pset 51 -> walls 11, 12; qset 60 -> wall 13
  relationships.addEdge(50, 10, RelationshipType.DefinesByProperties, 100);
  relationships.addEdge(50, 11, RelationshipType.DefinesByProperties, 100);
  relationships.addEdge(51, 11, RelationshipType.DefinesByProperties, 101);
  relationships.addEdge(51, 12, RelationshipType.DefinesByProperties, 101);
  relationships.addEdge(QSET, 13, RelationshipType.DefinesByProperties, 102);
  const store: CacheDataStore = { schema: 1, entityCount: 5, strings, entities: entities.build(), properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(), relationships: relationships.build() };
  const source = ['ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;', "#1=IFCPROJECT('p',$,'Project',$,$,$,$,$,$);",
    ...WALLS.map((id) => `#${id}=IFCWALL('w${id}',$,'Wall ${id}',$,$,$,$,$);`),
    ...PSETS.map((id) => `#${id}=IFCPROPERTYSET('ps${id}',$,'Pset_${id}',$,());`),
    `#${QSET}=IFCELEMENTQUANTITY('q',$,'Qto',$,$,());`, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
  const sourceBuffer = new TextEncoder().encode(source).buffer as ArrayBuffer;
  const buffer = await new BinaryCacheWriter().write(store, undefined, sourceBuffer, { includeGeometry: false, omitSourceHash: true });
  return { buffer, sourceBuffer };
}

function counting(): { trace: LoadTrace; builds: () => number } {
  let builds = 0;
  const trace = { ...NOOP_LOAD_TRACE, enabled: false, loadId: 't', start: 0,
    span<T>(name: string, fn: () => T): T { if (name === 'cache.onDemandMaps') builds++; return fn(); },
    begin: () => -1, end: () => {}, record: () => {}, milestone: () => 0, setAttrs: () => {}, merge: () => {}, finish: () => 0, snapshot: () => null } as LoadTrace;
  return { trace, builds: () => builds };
}

const sorted = (m: Map<number, number[]> | undefined) => [...(m ?? new Map())].map(([k, v]) => `${k}:${[...v].sort((a, b) => a - b).join(',')}`).sort();

describe('cache hit on-demand maps', () => {
  it('are built on first read, once, with the eager build\'s contents', async () => {
    const { trace, builds } = counting();
    const { dataStore } = await decodeCachedMetadata(await entry(), undefined, trace);
    assert.equal(builds(), 0, 'nothing is built while the hit decodes');

    const expected = rebuildOnDemandMaps(dataStore.entities, dataStore.relationships, dataStore.entityIndex);
    assert.ok(expected.onDemandPropertyMap.size > 0 && expected.onDemandQuantityMap.size > 0, 'the fixture has property and quantity links');

    assert.deepEqual(sorted(dataStore.onDemandPropertyMap), sorted(expected.onDemandPropertyMap), 'first read: properties');
    assert.equal(builds(), 1);
    assert.deepEqual(sorted(dataStore.onDemandQuantityMap), sorted(expected.onDemandQuantityMap));
    assert.deepEqual(sorted(dataStore.onDemandMaterialMap), sorted(expected.onDemandMaterialMap));
    assert.deepEqual(sorted(dataStore.onDemandPropertyMap), ['10:50', '11:50,51', '12:51']);
    assert.equal(builds(), 1, 'one build serves all three maps and every later read');
    assert.equal(dataStore.onDemandPropertyMap, dataStore.onDemandPropertyMap, 'a stable value');
  });

  it('a property read through the store accessor triggers the build and answers', async () => {
    const { trace, builds } = counting();
    const { dataStore } = await decodeCachedMetadata(await entry(), undefined, trace);
    dataStore.getProperties(11);
    assert.equal(builds(), 1);
    assert.deepEqual(dataStore.onDemandPropertyMap?.get(11)?.slice().sort(), [50, 51]);
  });

  it('an assignment replaces a map as a plain field', async () => {
    const { trace } = counting();
    const { dataStore } = await decodeCachedMetadata(await entry(), undefined, trace);
    const replacement = new Map([[10, [99]]]);
    dataStore.onDemandPropertyMap = replacement;
    assert.equal(dataStore.onDemandPropertyMap, replacement);
    assert.ok((dataStore.onDemandQuantityMap?.size ?? 0) > 0, 'the others keep their built values');
    assert.ok(Object.keys(dataStore).includes('onDemandMaterialMap'), 'still enumerable (store transport and spreads see it)');
  });
});
