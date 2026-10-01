/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store/types';
import { configureMutationView } from '@/utils/configureMutationView';
import { prepareComparison, comparePreparedPair } from './run-comparison';

async function parse(): Promise<IfcDataStore> {
  const text = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0WallA0000000000000001',$,'Wall A',$,$,$,$,$,.STANDARD.);\nENDSEC;\nEND-ISO-10303-21;";
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}
function model(id: string, store: IfcDataStore): FederatedModel {
  return { id, name: id, ifcDataStore: store, schemaVersion: 'IFC4',
    geometryResult: { meshes: [] } as unknown as GeometryResult, idOffset: 0, maxExpressId: 1 } as unknown as FederatedModel;
}

describe('explicit comparison execution (#6612)', () => {
  it('compares edited stores and supports cheap explicit scope/exclusion re-diffs', async () => {
    const base = model('A', await parse()), head = model('B', await parse());
    const view = new MutablePropertyView(head.ifcDataStore!.properties ?? null, 'B');
    configureMutationView(view, head.ifcDataStore!);
    view.setAttribute(1, 'Name', 'Edited wall', 'Wall A');
    const built = await prepareComparison({ baseModel: base, headModel: head,
      getMutationView: (id) => id === 'B' ? view : null, mutationVersion: 7, contentVersion: 3 });
    const data = comparePreparedPair(built, { scope: 'data', excludedTypes: [], matchByContent: false });
    assert.equal(data.diff.counts.modified, 1);
    assert.equal(data.comparedStores?.get('B')?.entities.getName(1), 'Edited wall');
    assert.equal(data.mutationVersion, 7);
    const geometry = comparePreparedPair(built, { scope: 'geometry', excludedTypes: [], matchByContent: false });
    assert.equal(geometry.diff.counts.modified, 0);
    const excluded = comparePreparedPair(built, { scope: 'data', excludedTypes: ['IfcWall'], matchByContent: false });
    assert.equal(excluded.diff.entries.length, 0);
  });
  it('allows data checks on fully parsed models without geometry', async () => {
    const base = model('A', await parse()), head = model('B', await parse());
    base.geometryResult = null; head.geometryResult = null;
    const built = await prepareComparison({ baseModel: base, headModel: head, getMutationView: () => null,
      mutationVersion: 0, contentVersion: 0 });
    const result = comparePreparedPair(built, { scope: 'data', excludedTypes: [], matchByContent: false });
    assert.equal(result.diff.counts.unchanged, 1);
  });
  it('rejects cancellation before starting extraction', async () => {
    const controller = new AbortController(); controller.abort();
    const base = model('A', await parse()), head = model('B', await parse());
    await assert.rejects(prepareComparison({ baseModel: base, headModel: head, getMutationView: () => null,
      mutationVersion: 0, contentVersion: 0, signal: controller.signal }), { name: 'AbortError' });
  });
});
