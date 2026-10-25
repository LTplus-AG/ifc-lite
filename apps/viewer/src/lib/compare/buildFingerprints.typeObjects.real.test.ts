/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { diffModels } from '@ifc-lite/diff';
import type { FederatedModel } from '../../store/types.js';
import { buildEntityFingerprints } from './buildFingerprints.js';
import { describeChange } from './describeChange.js';

const fixture = process.env.IFC_8040_MODEL ?? fileURLToPath(
  new URL('../../../../../tests/models/various/rvt01.ifc', import.meta.url),
);
const typeGuid = '3BXQEa_kf3dBltyGr7bwKt';

// #8040: original Revit 24.0.5.432 export. Only a type-owned property is
// changed in memory; the occurrence's separate FireRating (#6041) stays intact.
it('reports the geometry-less Revit wall type FireRating edit and nothing else (#8040)', async (t) => {
  if (!existsSync(fixture)) {
    t.skip('Real Revit fixture missing; run pnpm fixtures (or set IFC_8040_MODEL).');
    return;
  }
  const original = readFileSync(fixture, 'utf8');
  const record = "#6058=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('60'),$);";
  assert.equal(original.split(record).length, 2, 'the pinned property record occurs exactly once');
  const revised = original.replace(record, record.replace("'60'", "'90'"));
  const parse = (source: string) => new IfcParser().parseColumnar(
    new TextEncoder().encode(source).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const baseStore = await parse(original);
  const headStore = await parse(revised);
  const ref = baseStore.entityIndex.byId.get(6036);
  assert.ok(ref, 'the original export contains the wall type');
  const type = new EntityExtractor(baseStore.source).extractEntity(ref);
  assert.ok(type);
  assert.equal(type.type.toUpperCase(), 'IFCWALLTYPE');
  assert.equal(type.attributes[0], typeGuid);
  assert.deepEqual(type.attributes[5], [6060, 6065], 'type owns its sets through HasPropertySets');
  assert.equal(type.attributes[6], null, 'original RepresentationMaps is absent');

  const base = await buildEntityFingerprints({ modelId: 'base', store: baseStore, meshes: [], idOffset: 0 });
  const head = await buildEntityFingerprints({ modelId: 'head', store: headStore, meshes: [], idOffset: 1_000_000 });
  const diff = diffModels(base, head, { scope: 'both' });
  const entry = diff.byKey.get(typeGuid);
  assert.ok(entry, 'a geometry-less type must reach the viewer comparison');
  assert.equal(entry.state, 'modified');
  assert.deepEqual(entry.changeKinds, ['data']);
  assert.deepEqual(entry.changedComponents, ['pset:Pset_WallCommon']);
  assert.equal(base.find((item) => item.key === typeGuid)?.ref.meshed, false);
  assert.equal(head.find((item) => item.key === typeGuid)?.ref.meshed, false);
  assert.deepEqual(diff.entries.filter((item) => item.state !== 'unchanged').map((item) => item.key), [typeGuid]);
  assert.ok(diff.counts.unchanged > 0, 'the real model supplies unchanged controls');

  const models = new Map<string, FederatedModel>([
    ['base', { ifcDataStore: baseStore, geometryResult: null } as FederatedModel],
    ['head', { ifcDataStore: headStore, geometryResult: null } as FederatedModel],
  ]);
  const detail = describeChange(entry, models);
  assert.ok(detail);
  assert.deepEqual(detail.data, [{
    category: 'property', group: 'Pset_WallCommon', name: 'FireRating',
    before: '60', after: '90', kind: 'changed',
  }]);
  t.diagnostic(JSON.stringify({
    fixture: 'various/rvt01.ifc', authoringTool: 'Autodesk Revit 24.0.5.432',
    typeGuid, typeExpressId: 6036, changedPropertyId: 6058,
    representationMaps: null, counts: diff.counts, detail: detail.data,
  }));
});
