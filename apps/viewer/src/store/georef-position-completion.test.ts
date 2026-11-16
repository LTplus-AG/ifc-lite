/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { exportModelStep } from '@/lib/export/model-step-export';
import { useViewerStore } from './index.js';
import { changeOperations } from '@/lib/changes/change-operations';
import { revertChangeOperation } from '@/lib/changes/revert-change-operation';
import { inverseMutationTargets } from './slices/mutation-inverse-registry.js';
import type { GeorefMutationData } from './slices/mutationSlice.js';

// An IfcProjectedCRS but no IfcMapConversion: the file the panel's map pick, angle edit and single-field saves start from.
const CRS_ONLY = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'Project',$,$,$,$,(#20),#30);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCUNITASSIGNMENT((#2));
#40=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#2);
ENDSEC;
END-ISO-10303-21;`;

const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
const flows: Array<[string, Array<{ field: string; value: number }>, Record<string, number>]> = [
  ['map pick without terrain height', [{ field: 'eastings', value: 2600000 }, { field: 'northings', value: 1200000 }], { eastings: 2600000, northings: 1200000, orthogonalHeight: 0 }],
  ['angle edit', [{ field: 'xAxisAbscissa', value: 0 }, { field: 'xAxisOrdinate', value: 1 }], { eastings: 0, northings: 0, orthogonalHeight: 0, xAxisAbscissa: 0, xAxisOrdinate: 1 }],
  ['single-field save', [{ field: 'orthogonalHeight', value: 12 }], { eastings: 0, northings: 0, orthogonalHeight: 12 }],
];

async function withModel(run: (dataStore: IfcDataStore) => Promise<void>) {
  const store = useViewerStore;
  const before = store.getState();
  const dataStore = await parse(CRS_ONLY);
  store.setState({ models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]) as never, editEnabled: true, georefMutations: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  try { await run(dataStore); } finally {
    store.setState({ editEnabled: before.editEnabled, models: before.models, georefMutations: before.georefMutations, undoStacks: before.undoStacks, redoStacks: before.redoStacks });
  }
}

const exported = async (dataStore: IfcDataStore, mutations: GeorefMutationData | undefined) => extractGeoreferencingOnDemand(await parse(new TextDecoder().decode(
  (await exportModelStep({ modelId: 'm', dataStore, options: { schema: 'IFC4', applyMutations: true, georefMutations: mutations as never }, scheduleState: null })).content as Uint8Array)));

for (const [name, fields, expected] of flows) {
  it(`${name}: the stored position is complete, undoable, and exports the picked values with 0 for the rest`, async () => {
    await withModel(async (dataStore) => {
      const state = useViewerStore.getState();
      state.setGeorefFields('m', 'mapConversion', fields);
      const stored = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
      for (const key of ['eastings', 'northings', 'orthogonalHeight'] as const) assert.equal(typeof stored?.[key], 'number', `${key} is in the store`);
      const geo = await exported(dataStore, useViewerStore.getState().georefMutations.get('m'));
      for (const [key, value] of Object.entries(expected)) assert.equal((geo?.mapConversion as unknown as Record<string, unknown>)?.[key], value, key);
      useViewerStore.getState().undo('m');
      assert.equal(useViewerStore.getState().georefMutations.get('m'), undefined, 'one undo takes the edit and its completion back together');
    });
  });
}

it('the completion keeps a value the user already set, and does nothing when the position is complete', async () => {
  await withModel(async () => {
    const s = useViewerStore.getState();
    s.setGeorefFields('m', 'mapConversion', [{ field: 'eastings', value: 5 }, { field: 'northings', value: 6 }, { field: 'orthogonalHeight', value: 7 }]);
    s.setGeorefFields('m', 'mapConversion', [{ field: 'xAxisAbscissa', value: 1 }]);
    const stored = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
    assert.deepEqual([stored?.eastings, stored?.northings, stored?.orthogonalHeight], [5, 6, 7]);
  });
});

it('reverting the position out from under a later edit is refused instead of leaving a partial one (Changes panel)', async () => {
  await withModel(async () => {
    const s = useViewerStore.getState();
    s.setGeorefFields('m', 'mapConversion', [{ field: 'eastings', value: 9 }, { field: 'northings', value: 8 }]);
    useViewerStore.getState().setGeorefFields('m', 'mapConversion', [{ field: 'scale', value: 1 }]);
    const state = useViewerStore.getState();
    const pick = changeOperations(state.undoStacks, state.mutationBatchTags, inverseMutationTargets(useViewerStore)).find((op) => op.mutations.length === 3)!;
    assert.ok(pick, 'the pick and its completed height are one operation');
    const result = revertChangeOperation(useViewerStore, pick);
    assert.deepEqual(result, { ok: false, reason: 'newer-conflict' });
    const mc = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
    assert.deepEqual([mc?.eastings, mc?.northings, mc?.orthogonalHeight, mc?.scale], [9, 8, 0, 1]);
  });
});

it('the room mirror publishes the effective conversion, so a peer is never sent a partial position', async () => {
  const { createRoomSpatialContext } = await import('@/lib/collab/room-spatial-context');
  const context = createRoomSpatialContext(await parse(CRS_ONLY), undefined, { mapConversion: { eastings: 5 } }) as { georeferencing?: { mapConversion?: Record<string, unknown> } };
  const mc = context.georeferencing?.mapConversion;
  assert.deepEqual([mc?.eastings, mc?.northings, mc?.orthogonalHeight], [5, 0, 0]);
});
