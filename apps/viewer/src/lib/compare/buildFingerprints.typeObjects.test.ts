/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { diffModels } from '@ifc-lite/diff';
import { buildEntityFingerprints } from './buildFingerprints.js';
import { productTypeSplit } from './productTypeCounts.js';
import { describeChange } from './describeChange.js';
import type { FederatedModel } from '../../store/types.js';

const TYPE_GUID = '0aaaaaaaaaaaaaaaaaaaaa';
const schemas = [
  { schema: 'IFC4', ifcType: 'IfcWallType', tail: "'Wall',.STANDARD." },
  { schema: 'IFC2X3', ifcType: 'IfcWindowStyle', tail: '.SINGLE_PANEL.,.WOOD.,.T.,.F.' },
  { schema: 'IFC4X3', ifcType: 'IfcRailType', tail: "'Rail',.RACKRAIL." },
] as const;
type TypeFixture = (typeof schemas)[number];

/** HasPropertySets is a direct type attribute, not an occurrence relationship.
 * No RepresentationMaps, occurrences, or meshes can bring this type into scope. */
function typeStep(
  fixture: TypeFixture,
  { rating = '60', name = 'Type A', tag = 'T-001' } = {},
): string {
  return [
    `#1=${fixture.ifcType.toUpperCase()}('${TYPE_GUID}',$,'${name}',$,$,(#3),$,'${tag}',${fixture.tail});`,
    `#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${rating}'),$);`,
    "#3=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'Pset_TestType',$,(#2,#4));",
    "#4=IFCPROPERTYSINGLEVALUE('Code',$,IFCLABEL('TYPE-001'),$);",
  ].join('\n');
}

async function storeFromStep(body: string, schema: string) {
  const source = [
    'ISO-10303-21;', 'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;', 'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, {
    disableWorkerScan: true,
  });
}

async function fingerprints(body: string, schema: string, modelId: string, idOffset = 0) {
  const store = await storeFromStep(body, schema);
  return buildEntityFingerprints({ modelId, store, meshes: [], idOffset });
}

describe('geometry-less type objects reach viewer Compare (#8040)', () => {
  for (const fixture of schemas) {
    describe(`${fixture.schema} ${fixture.ifcType}`, () => {
      it('reports a direct HasPropertySets edit as a type-object data change', async () => {
        const base = await fingerprints(typeStep(fixture), fixture.schema, 'base');
        const head = await fingerprints(typeStep(fixture, { rating: '90' }), fixture.schema, 'head', 1_000_000);
        assert.equal(base.length, 1, 'the owning type is compared, its property resources are not');
        assert.equal(head.length, 1);
        assert.equal(head[0]!.ifcType, fixture.ifcType);
        assert.deepEqual(head[0]!.ref, {
          modelId: 'head', localId: 1, globalId: 1_000_001, meshed: false,
        });
        assert.equal(base[0]!.geometryHash, undefined, 'a type has no occurrence placement');
        assert.equal(head[0]!.geometryHash, undefined);

        const diff = diffModels(base, head, { scope: 'both' });
        const entry = diff.byKey.get(TYPE_GUID);
        assert.ok(entry, 'the real GlobalId must survive extraction and matching');
        assert.equal(entry.state, 'modified');
        assert.deepEqual(entry.changeKinds, ['data']);
        assert.deepEqual(entry.changedComponents, ['pset:Pset_TestType']);
        assert.deepEqual(productTypeSplit(diff.entries), {
          products: { added: 0, modified: 0, deleted: 0 },
          typeObjects: { added: 0, modified: 1, deleted: 0 },
        });
      });

      for (const edit of [{ name: 'Type B' }, { tag: 'T-002' }]) {
        it(`reports a ${Object.keys(edit)[0]} edit without geometry`, async () => {
          const base = await fingerprints(typeStep(fixture), fixture.schema, 'base');
          const head = await fingerprints(typeStep(fixture, edit), fixture.schema, 'head');
          const entry = diffModels(base, head, { scope: 'both' }).byKey.get(TYPE_GUID);
          assert.ok(entry);
          assert.equal(entry.state, 'modified');
          assert.deepEqual(entry.changeKinds, ['data']);
          assert.deepEqual(entry.changedComponents, ['attr:core']);
        });
      }

      it('keeps an unchanged type unchanged across model identities and offsets', async () => {
        const base = await fingerprints(typeStep(fixture), fixture.schema, 'base');
        const head = await fingerprints(typeStep(fixture), fixture.schema, 'head', 1_000_000);
        const diff = diffModels(base, head, { scope: 'both' });
        assert.equal(diff.byKey.get(TYPE_GUID)?.state, 'unchanged');
        assert.deepEqual(diff.counts, { added: 0, modified: 0, deleted: 0, unchanged: 1 });
      });

      it('reports addition and deletion even when neither revision contains meshes', async () => {
        const present = await fingerprints(typeStep(fixture), fixture.schema, 'present');
        const absent = await fingerprints("#4=IFCCARTESIANPOINT((0.,0.,0.));", fixture.schema, 'absent');
        const added = diffModels(absent, present, { scope: 'both' });
        const deleted = diffModels(present, absent, { scope: 'both' });
        assert.equal(added.byKey.get(TYPE_GUID)?.state, 'added');
        assert.equal(deleted.byKey.get(TYPE_GUID)?.state, 'deleted');
        assert.deepEqual(productTypeSplit(added.entries).typeObjects, { added: 1, modified: 0, deleted: 0 });
        assert.deepEqual(productTypeSplit(deleted.entries).typeObjects, { added: 0, modified: 0, deleted: 1 });
      });

      it('retains property changes through authored-key caching and change details', async () => {
        const a = await storeFromStep(typeStep(fixture), fixture.schema);
        const b = await storeFromStep(typeStep(fixture, { rating: '90' }), fixture.schema);
        const base = await buildEntityFingerprints({
          modelId: 'A', store: a, meshes: [], idOffset: 0, keyProperty: 'Pset_TestType.Code',
        });
        const head = await buildEntityFingerprints({
          modelId: 'B', store: b, meshes: [], idOffset: 1_000_000, keyProperty: 'Pset_TestType.Code',
        });
        assert.equal(base[0]?.key, TYPE_GUID, 'direct type psets do not change the shared CLI key scheme');
        assert.equal(head[0]?.key, TYPE_GUID);
        const entry = diffModels(base, head, { scope: 'both' }).byKey.get(TYPE_GUID);
        assert.ok(entry);
        assert.equal(entry.state, 'modified', 'the key pre-pass must preserve the type property sets');
        assert.deepEqual(entry.changedComponents, ['pset:Pset_TestType']);

        // Same minimal model wrapper as describeChange.test.ts; both stores
        // are real parser output and the entry is produced by the diff engine.
        const models = new Map<string, FederatedModel>([
          ['A', { ifcDataStore: a, geometryResult: null } as FederatedModel],
          ['B', { ifcDataStore: b, geometryResult: null } as FederatedModel],
        ]);
        const detail = describeChange(entry, models);
        assert.ok(detail);
        assert.deepEqual(detail.data.filter((delta) => delta.category === 'property'), [{
          category: 'property', group: 'Pset_TestType', name: 'FireRating',
          before: '60', after: '90', kind: 'changed',
        }]);
        assert.equal(detail.geometry, null);
      });
    });
  }

  it('compares an IfcElementQuantity attached directly to HasPropertySets', async () => {
    const quantityStep = (length: number) => [
      `#1=IFCWALLTYPE('${TYPE_GUID}',$,'Type A',$,$,(#3),$,'T-001','Wall',.STANDARD.);`,
      `#2=IFCQUANTITYLENGTH('Length',$,$,${length}.,$);`,
      "#3=IFCELEMENTQUANTITY('0bbbbbbbbbbbbbbbbbbbbb',$,'Qto_WallBaseQuantities',$,$,(#2));",
    ].join('\n');
    const a = await storeFromStep(quantityStep(2), 'IFC4');
    const b = await storeFromStep(quantityStep(3), 'IFC4');
    const base = await buildEntityFingerprints({ modelId: 'A', store: a, meshes: [], idOffset: 0 });
    const head = await buildEntityFingerprints({ modelId: 'B', store: b, meshes: [], idOffset: 0 });
    const entry = diffModels(base, head, { scope: 'both' }).byKey.get(TYPE_GUID);
    assert.ok(entry);
    assert.equal(entry.state, 'modified');
    assert.deepEqual(entry.changeKinds, ['data']);
    assert.deepEqual(entry.changedComponents, ['qset:Qto_WallBaseQuantities']);
    const detail = describeChange(entry, new Map<string, FederatedModel>([
      ['A', { ifcDataStore: a, geometryResult: null } as FederatedModel],
      ['B', { ifcDataStore: b, geometryResult: null } as FederatedModel],
    ]));
    assert.ok(detail);
    assert.deepEqual(detail.data.filter((delta) => delta.category === 'quantity'), [{
      category: 'quantity', group: 'Qto_WallBaseQuantities', name: 'Length',
      before: '2', after: '3', kind: 'changed',
    }]);
  });

  it('does not widen the panel to non-product objects or property resources', async () => {
    const body = [
      typeStep(schemas[0]),
      "#10=IFCWALL('0ccccccccccccccccccccc',$,'Wall',$,$,$,$,$,.STANDARD.);",
      "#11=IFCGROUP('0ddddddddddddddddddddd',$,'Group',$,$);",
      "#12=IFCTASK('0eeeeeeeeeeeeeeeeeeeee',$,'Task',$,$,$,$,'TASK-1',$,.F.,$,$,.CONSTRUCTION.);",
    ].join('\n');
    const built = await fingerprints(body, 'IFC4', 'model');
    assert.deepEqual(built.map((item) => item.ifcType).sort(), ['IfcWall', 'IfcWallType']);
  });
});
