/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5189: `getProperties`/`getQuantities` used to read straight off
 * `ifcDataStore`, never consulting the `MutablePropertyView` overlay. A
 * script that called `bim.mutate.setProperty()` (or `setQuantity`) and then
 * read back with `bim.query.properties()`/`quantities()` in the SAME session
 * got the PRE-EDIT value — the CLI (`overlayProperties`/`overlayQuantities`
 * in `packages/cli/src/query-overlay.ts`) and MCP (`properties()`/
 * `quantities()` in `packages/mcp/src/backend-query.ts`) both fold the
 * overlay; only the viewer skipped it.
 *
 * Also covers the MCP-only detail #5189 calls out: a deleted entity answers
 * `[]` for both `properties()` and `quantities()`, not just "unedited".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { createQueryAdapter } from './query-adapter.js';
import type { StoreApi } from './types.js';

function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

// Wall #3 carries a base Pset_Test.Grade = 'Original' and a base
// Qto_Test.NetWidth = 0.25 — asymmetric, distinguishable values so a test
// that read the pre-edit value back could never be confused with reading
// the post-edit one.
const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('${guid('PROJ')}',$,'Project',$,$,$,$,$,$);
#3=IFCWALL('${guid('WALA')}',$,'Wall A',$,$,$,$,$,$);
#10=IFCPROPERTYSINGLEVALUE('Grade',$,IFCLABEL('Original'),$);
#11=IFCPROPERTYSET('${guid('PST1')}',$,'Pset_Test',$,(#10));
#12=IFCRELDEFINESBYPROPERTIES('${guid('RDP1')}',$,$,$,(#3),#11);
#20=IFCQUANTITYLENGTH('NetWidth',$,$,0.25,$);
#21=IFCELEMENTQUANTITY('${guid('QTO1')}',$,'Qto_Test',$,$,(#20));
#22=IFCRELDEFINESBYPROPERTIES('${guid('RDP2')}',$,$,$,(#3),#21);
ENDSEC;END-ISO-10303-21;`;

async function harness() {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  // Wired the same way `getOrCreateMutationView` (mutation-view.ts) wires a
  // real viewer session's overlay: on-demand property/quantity extraction
  // over the parsed source, not the raw columnar table directly.
  if (dataStore.onDemandPropertyMap && dataStore.source?.length) {
    view.setOnDemandExtractor((entityId: number) => extractPropertiesOnDemand(dataStore, entityId));
  }
  if (dataStore.onDemandQuantityMap && dataStore.source?.length) {
    view.setQuantityExtractor((entityId: number) => extractQuantitiesOnDemand(dataStore, entityId));
  }
  const state = {
    models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]),
    activeModelId: 'm',
    ifcDataStore: dataStore,
    mutationViews: new Map([['m', view]]),
    getMutationView: (id: string) => (id === 'm' ? view : null),
  };
  const store = { getState: () => state, subscribe: () => () => {} } as unknown as StoreApi;
  return { adapter: createQueryAdapter(store), view };
}

test('setProperty then query.properties() returns the NEW value, not the pre-edit one (#5189)', async () => {
  const { adapter, view } = await harness();
  const ref = { modelId: 'm', expressId: 3 };

  const before = adapter.properties(ref);
  assert.equal(before[0]?.properties[0]?.value, 'Original', 'sanity: base value read correctly before any edit');

  view.setProperty(3, 'Pset_Test', 'Grade', 'Modified', PropertyValueType.String);
  const after = adapter.properties(ref);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.properties[0]?.value, 'Modified', 'must read back the edit, not the stale base value');
});

test('setQuantity then query.quantities() returns the NEW value, not the pre-edit one (#5189)', async () => {
  const { adapter, view } = await harness();
  const ref = { modelId: 'm', expressId: 3 };

  const before = adapter.quantities(ref);
  assert.equal(before[0]?.quantities[0]?.value, 0.25, 'sanity: base quantity read correctly before any edit');

  view.setQuantity(3, 'Qto_Test', 'NetWidth', 9.75, QuantityType.Length);
  const after = adapter.quantities(ref);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.quantities[0]?.value, 9.75, 'must read back the edit, not the stale base value');
});

test('query.properties() on a deleted entity returns [] (#5189, MCP parity)', async () => {
  const { adapter, view } = await harness();
  const ref = { modelId: 'm', expressId: 3 };

  assert.notEqual(adapter.properties(ref).length, 0, 'sanity: the entity has properties before deletion');
  view.deleteEntity(3);
  assert.deepEqual(adapter.properties(ref), [], 'a deleted entity must answer nothing, not its stale base properties');
});

test('query.quantities() on a deleted entity returns [] (#5189, MCP parity)', async () => {
  const { adapter, view } = await harness();
  const ref = { modelId: 'm', expressId: 3 };

  assert.notEqual(adapter.quantities(ref).length, 0, 'sanity: the entity has quantities before deletion');
  view.deleteEntity(3);
  assert.deepEqual(adapter.quantities(ref), [], 'a deleted entity must answer nothing, not its stale base quantities');
});
