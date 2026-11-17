/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { positionCompletion } from '@/lib/geo/complete-position';
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

const NO_GEOREF = CRS_ONLY.replace(/#40=.*\n/, '');
const parse = (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
const flows: Array<[string, Array<{ field: string; value: number }>, Record<string, number>]> = [
  ['map pick without terrain height', [{ field: 'eastings', value: 2600000 }, { field: 'northings', value: 1200000 }], { eastings: 2600000, northings: 1200000, orthogonalHeight: 0 }],
  ['angle edit', [{ field: 'xAxisAbscissa', value: 0 }, { field: 'xAxisOrdinate', value: 1 }], { eastings: 0, northings: 0, orthogonalHeight: 0, xAxisAbscissa: 0, xAxisOrdinate: 1 }],
  ['single-field save', [{ field: 'orthogonalHeight', value: 12 }], { eastings: 0, northings: 0, orthogonalHeight: 12 }],
];

async function withModel(run: (dataStore: IfcDataStore) => Promise<void>, text = CRS_ONLY) {
  const store = useViewerStore;
  const before = store.getState();
  const dataStore = await parse(text);
  store.setState({ models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]) as never, editEnabled: true, georefMutations: new Map(), undoStacks: new Map(), redoStacks: new Map() });
  try { await run(dataStore); } finally {
    store.setState({ editEnabled: before.editEnabled, models: before.models, georefMutations: before.georefMutations, undoStacks: before.undoStacks, redoStacks: before.redoStacks });
  }
}

const exported = async (dataStore: IfcDataStore, mutations: GeorefMutationData | undefined, mutationView?: MutablePropertyView) => extractGeoreferencingOnDemand(await parse(new TextDecoder().decode(
  (await exportModelStep({ modelId: 'm', dataStore, mutationView, options: { schema: 'IFC4', applyMutations: true, georefMutations: mutations as never }, scheduleState: null })).content as Uint8Array)));

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

it('creating a CRS on a file with no georeferencing stores a position with it, and the export keeps both', async () => {
  await withModel(async (dataStore) => {
    useViewerStore.getState().setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:2056' }, { field: 'mapUnit', value: 'METRE' }]);
    const stored = useViewerStore.getState().georefMutations.get('m');
    assert.deepEqual([stored?.mapConversion?.eastings, stored?.mapConversion?.northings, stored?.mapConversion?.orthogonalHeight], [0, 0, 0]);
    const geo = await exported(dataStore, stored);
    assert.equal(geo?.projectedCRS?.name, 'EPSG:2056');
    assert.equal(geo?.mapConversion?.eastings, 0);
    useViewerStore.getState().undo('m');
    assert.equal(useViewerStore.getState().georefMutations.get('m'), undefined, 'the CRS and its position are one undo step');
  }, NO_GEOREF);
});

it('the EPSG pick (CRS fields, then the conversion defaults, one batch id) undoes as one step and never leaves a CRS without a position', async () => {
  await withModel(async () => {
    const batch = 'epsg-batch';
    const s = useViewerStore.getState();
    s.setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:2056' }], batch);
    useViewerStore.getState().setGeorefFields('m', 'mapConversion', [{ field: 'eastings', value: 0 }, { field: 'northings', value: 0 }, { field: 'orthogonalHeight', value: 0 }, { field: 'scale', value: 1 }], batch);
    useViewerStore.getState().undo('m');
    assert.equal(useViewerStore.getState().georefMutations.get('m'), undefined);
  }, NO_GEOREF);
});

it('a received CRS without a conversion arrives with an explicit zero position (a recipient with no CRS record exports it whole)', async () => {
  const { receivedGeorefMutations } = await import('@/lib/collab/room-spatial-context');
  const crs = { id: 0, name: 'EPSG:2056' };
  const received = receivedGeorefMutations({ projectedCRS: crs as never });
  assert.deepEqual(received.mapConversion, { eastings: 0, northings: 0, orthogonalHeight: 0 });
  await withModel(async (dataStore) => {
    const geo = await exported(dataStore, received as never);
    assert.equal(geo?.projectedCRS?.name, 'EPSG:2056');
    assert.equal(geo?.mapConversion?.northings, 0);
  }, NO_GEOREF);
  assert.equal(receivedGeorefMutations({ projectedCRS: crs as never, mapConversion: { eastings: 7 } as never }).mapConversion?.eastings, 7, 'a received conversion is kept');
});

it('a deleted source conversion needs complete replacement coordinates (#10382 review)', async () => {
  const dataStore = await parse(CRS_ONLY.replace('ENDSEC;\nEND-ISO', '#41=IFCMAPCONVERSION(#20,#40,10.,20.,30.,$,$,$);\nENDSEC;\nEND-ISO'));
  const view = new MutablePropertyView(dataStore.properties, 'm');
  const pending = { mapConversion: { eastings: 99 } };
  assert.deepEqual(positionCompletion(dataStore, pending, view), []);
  view.deleteEntity(41);
  const complete = positionCompletion(dataStore, pending, view);
  assert.deepEqual(complete, [{ field: 'northings', value: 20 }, { field: 'orthogonalHeight', value: 30 }]);
  const mapConversion = { ...pending.mapConversion, ...Object.fromEntries(complete.map(({ field, value }) => [field, value])) };
  const geo = await exported(dataStore, { mapConversion }, view);
  assert.notEqual(geo?.mapConversion?.id, 41, 'the deleted conversion is replaced, not edited in place');
  assert.deepEqual([geo?.mapConversion?.eastings, geo?.mapConversion?.northings, geo?.mapConversion?.orthogonalHeight], [99, 20, 30]);
});

it('a deleted source CRS needs a complete replacement position (#10382 review)', async () => {
  const dataStore = await parse(CRS_ONLY);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  const pending = { projectedCRS: { name: 'EPSG:2056' } };
  assert.deepEqual(positionCompletion(dataStore, pending, view), []);
  view.deleteEntity(40);
  const completion = positionCompletion(dataStore, pending, view);
  assert.deepEqual(completion, [
    { field: 'eastings', value: 0 },
    { field: 'northings', value: 0 },
    { field: 'orthogonalHeight', value: 0 },
  ]);
  const mapConversion = Object.fromEntries(completion.map(({ field, value }) => [field, value]));
  const geo = await exported(dataStore, { ...pending, mapConversion }, view);
  assert.notEqual(geo?.projectedCRS?.id, 40, 'the deleted CRS is replaced');
  assert.equal(geo?.projectedCRS?.name, 'EPSG:2056');
  assert.deepEqual([geo?.mapConversion?.eastings, geo?.mapConversion?.northings, geo?.mapConversion?.orthogonalHeight], [0, 0, 0]);
});

it('a complete multi-field write undoes atomically before a later edit/export (#10382 review)', async () => {
  await withModel(async (dataStore) => {
    useViewerStore.getState().setGeorefFields('m', 'mapConversion', [
      { field: 'eastings', value: 5 }, { field: 'northings', value: 6 }, { field: 'orthogonalHeight', value: 7 },
    ]);
    useViewerStore.getState().undo('m');
    assert.equal(useViewerStore.getState().georefMutations.get('m'), undefined);
    useViewerStore.getState().setGeorefFields('m', 'mapConversion', [{ field: 'scale', value: 2 }]);
    const geo = await exported(dataStore, useViewerStore.getState().georefMutations.get('m'));
    assert.deepEqual([geo?.mapConversion?.eastings, geo?.mapConversion?.northings, geo?.mapConversion?.orthogonalHeight], [0, 0, 0]);
    assert.equal(geo?.mapConversion?.scale, 2);
  });
});

for (const projectPrefix of ['$', '.MILLI.']) {
  for (const projectedFirst of [false, true]) {
    it(`angular site fallback never supplies projected position or height (${projectPrefix}, partial first=${projectedFirst}) (#10382 review)`, async () => {
      const site = NO_GEOREF.replace('.LENGTHUNIT.,$,.METRE.', `.LENGTHUNIT.,${projectPrefix},.METRE.`)
        .replace('ENDSEC;\nEND-ISO', "#45=IFCSITE('0Site00000000000000001',$,'Site',$,$,$,$,$,.ELEMENT.,(47,22,0,0),(8,32,0,0),123000.,$,$);\nENDSEC;\nEND-ISO");
      await withModel(async (dataStore) => {
        assert.equal(extractGeoreferencingOnDemand(dataStore)?.source, 'siteLocation');
        const fields = [{ field: 'eastings', value: 2600000 }, { field: 'northings', value: 1200000 }];
        if (projectedFirst) useViewerStore.getState().setGeorefFields('m', 'mapConversion', fields);
        useViewerStore.getState().setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:2056' }, { field: 'mapUnit', value: 'METRE' }]);
        const geo = await exported(dataStore, useViewerStore.getState().georefMutations.get('m'));
        assert.equal(geo?.projectedCRS?.name, 'EPSG:2056');
        assert.deepEqual([geo?.mapConversion?.eastings, geo?.mapConversion?.northings, geo?.mapConversion?.orthogonalHeight], projectedFirst ? [2600000, 1200000, 0] : [0, 0, 0]);
      }, site);
    });
  }
}

it('a received CRS-only source preserves sender absence on the same native receiver (#10382 review)', async () => {
  const { receivedGeorefMutations } = await import('@/lib/collab/room-spatial-context');
  const sender = await parse(CRS_ONLY), receiver = await parse(CRS_ONLY);
  const sent = await exported(sender, undefined);
  assert.ok(sent?.projectedCRS);
  assert.equal(sent.mapConversion, undefined);
  const mutations = receivedGeorefMutations(sent, receiver);
  assert.equal(mutations.mapConversion, undefined);
  const received = await exported(receiver, mutations);
  assert.equal(received?.projectedCRS?.name, sent.projectedCRS.name);
  assert.equal(received?.mapConversion, undefined);
  const view = new MutablePropertyView(receiver.properties, 'm');
  view.deleteEntity(40);
  const replacement = receivedGeorefMutations(sent, receiver, view);
  assert.deepEqual(replacement.mapConversion, { eastings: 0, northings: 0, orthogonalHeight: 0 });
  assert.deepEqual((await exported(receiver, replacement, view))?.mapConversion?.eastings, 0);
});
