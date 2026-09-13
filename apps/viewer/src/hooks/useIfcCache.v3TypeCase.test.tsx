/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A cache entry with no EntityIndex section (the v3 shape) makes
 * `loadFromCache` rebuild the entity index from the STEP source. STEP entity
 * keywords are case-insensitive, and the tokenizer hands back the file's own
 * spelling, so that rebuild must key `byType` in upper case the way a fresh
 * parse does (`getTypeUpper` in the parser). Before #4712 it keyed on the raw
 * spelling, so every `byType.get('IFC...')` lookup missed for a file that
 * writes `IfcPropertySet(...)` or `Ifcpropertyset(...)`, and the reloaded
 * model showed no property sets or quantities.
 *
 * Drives the real hook against a real cache buffer written without an
 * EntityIndex section, once per keyword spelling. The upper-case row is the
 * control: it passes with or without the fix, so a failure in the other rows
 * is the spelling and not the fixture. There is no all-lowercase row here:
 * the TypeScript scanners accept one only from #4713 on.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  RelationshipType,
} from '@ifc-lite/data';
import { BinaryCacheReader, BinaryCacheWriter, SectionType, type CacheDataStore } from '@ifc-lite/cache';
import { useViewerStore } from '@/store';
import { useIfcCache, type CacheResult } from './useIfcCache.js';

const WALL = 4;
const PSET = 20;
const QSET = 21;

const CAMEL: Record<string, string> = {
  IFCPROJECT: 'IfcProject',
  IFCWALL: 'IfcWall',
  IFCPROPERTYSET: 'IfcPropertySet',
  IFCELEMENTQUANTITY: 'IfcElementQuantity',
  IFCRELDEFINESBYPROPERTIES: 'IfcRelDefinesByProperties',
};

type Spell = (upper: string) => string;
const SPELLINGS: Array<[string, Spell]> = [
  ['UPPER (control)', (t) => t],
  ['CamelCase', (t) => CAMEL[t]],
  ['Capitalised', (t) => t[0] + t.slice(1).toLowerCase()],
];

function sourceText(spell: Spell): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    'ENDSEC;',
    'DATA;',
    `#1=${spell('IFCPROJECT')}('guid-project');`,
    `#${WALL}=${spell('IFCWALL')}('guid-wall');`,
    `#${PSET}=${spell('IFCPROPERTYSET')}('guid-pset',$,'Pset_WallCommon',$,());`,
    `#${QSET}=${spell('IFCELEMENTQUANTITY')}('guid-qset',$,'Qto_WallBaseQuantities',$,$,());`,
    `#30=${spell('IFCRELDEFINESBYPROPERTIES')}('guid-rel-p',$,$,$,(#${WALL}),#${PSET});`,
    `#31=${spell('IFCRELDEFINESBYPROPERTIES')}('guid-rel-q',$,$,$,(#${WALL}),#${QSET});`,
    'ENDSEC;',
    'END-ISO-10303-21;',
  ].join('\n');
}

function cacheStore(): CacheDataStore {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(4, strings);
  entities.add(1, 'IfcProject', 'guid-project', 'Project', '', '', false, false);
  entities.add(WALL, 'IfcWall', 'guid-wall', 'Wall', '', '', true, false);
  const relationships = new RelationshipGraphBuilder();
  relationships.addEdge(PSET, WALL, RelationshipType.DefinesByProperties, 30);
  relationships.addEdge(QSET, WALL, RelationshipType.DefinesByProperties, 31);
  return {
    schema: 1,
    entityCount: 2,
    strings,
    entities: entities.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: relationships.build(),
  };
}

async function v3Entry(spell: Spell): Promise<CacheResult> {
  const sourceBuffer = new TextEncoder().encode(sourceText(spell)).buffer as ArrayBuffer;
  const buffer = await new BinaryCacheWriter().write(cacheStore(), undefined, sourceBuffer, {
    includeGeometry: false,
    omitSourceHash: true,
  });
  return { buffer, sourceBuffer };
}

let root: Root | null = null;
let loadFromCache: ReturnType<typeof useIfcCache>['loadFromCache'] | null = null;

function Probe() {
  loadFromCache = useIfcCache().loadFromCache;
  return null;
}

beforeEach(async () => {
  loadFromCache = null;
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  assert.ok(loadFromCache, 'the hook must expose loadFromCache');
});

afterEach(async () => {
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  useViewerStore.setState({ ifcDataStore: null, geometryResult: null, geometryStreamingActive: false });
});

describe('loadFromCache v3 entity-index rebuild keys byType in upper case (#4712)', () => {
  for (const [label, spell] of SPELLINGS) {
    it(`${label} keywords: property and quantity sets survive the cached reload`, async () => {
      const entry = await v3Entry(spell);
      const header = new BinaryCacheReader().readHeader(entry.buffer as ArrayBuffer);
      assert.equal(
        header.sections.some((s) => s.type === SectionType.EntityIndex),
        false,
        'the fixture must lack an EntityIndex section, or the v3 rebuild never runs',
      );

      await act(async () => {
        const result = await loadFromCache!(entry, 'cased.ifc', 'model-cased', undefined, undefined, () => false);
        assert.equal(result.success, true, 'the cache hit must be served');
      });

      const store = useViewerStore.getState().ifcDataStore;
      assert.ok(store, 'the data store must be written');
      assert.deepEqual(store.onDemandPropertyMap?.get(WALL), [PSET], 'the wall lost its property set');
      assert.deepEqual(store.onDemandQuantityMap?.get(WALL), [QSET], 'the wall lost its quantity set');
      const byTypeKeys = [...store.entityIndex.byType.keys()].sort();
      assert.deepEqual(
        byTypeKeys,
        ['IFCELEMENTQUANTITY', 'IFCPROJECT', 'IFCPROPERTYSET', 'IFCRELDEFINESBYPROPERTIES', 'IFCWALL'],
        'byType must be keyed the way a fresh parse keys it',
      );
    });
  }
});
