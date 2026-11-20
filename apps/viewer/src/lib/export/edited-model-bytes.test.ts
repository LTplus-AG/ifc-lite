/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CSV exports read the model as edited (#5397). `editedModelBytes` is the
 * byte source both CSV entry points hand to the Rust exporter. Re-parse what
 * it returns: a deleted wall must be gone, a created one present, and a rename
 * applied. With no edits it must return the loaded bytes unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { QuantityType } from '@ifc-lite/data';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createMutateAdapter } from '@/sdk/adapters/mutate-adapter';
import { resolveTerrainSelection } from './landXmlTerrainExport';
import { storesWithMutationViews } from '@/components/viewer/lists/list-builder-discovery';
import { zoneQuantitySourceIdentity, zoneQuantitySources } from '@/lib/assistant/adapters/zone-volume-bases';
import { configureMutationView } from '@/utils/configureMutationView';
import { fixtureModel } from '@/test/store-fixture';
import { selectedEntityActionTarget } from '@/components/viewer/selected-entity-actions';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const modulePath = './edited-model-bytes.js';
const mod: typeof import('./edited-model-bytes.js') | null = await import(modulePath).catch(() => null);

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000011',$,'Wall B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

describe('editedModelBytes (#5397)', () => {
  it('returns the loaded bytes when nothing was edited', async () => {
    assert.ok(mod, 'edited-model-bytes must exist');
    const store = await parse(new TextEncoder().encode(FIXTURE));
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    configureMutationView(view, store);
    assert.deepEqual(mod!.editedModelBytes(store, view), store.source.materialize());
    assert.deepEqual(mod!.editedModelBytes(store, null), store.source.materialize());
  });

  it('re-serializes an edited model: deleted out, created in, rename applied', async () => {
    assert.ok(mod, 'edited-model-bytes must exist');
    const store = await parse(new TextEncoder().encode(FIXTURE));
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    configureMutationView(view, store);
    view.setExpressIdWatermark(11);
    view.deleteEntity(11);
    view.setAttribute(10, 'Name', 'Wall A renamed', 'Wall A');
    const created = view.createEntity('IfcWall', ['2Wall00000000000000012', null, 'Wall C']).expressId;

    const edited = await parse(mod!.editedModelBytes(store, view));
    assert.equal(edited.entityIndex.byId.has(11), false, 'the deleted wall is not in the bytes');
    assert.equal(edited.entities.getName(10), 'Wall A renamed');
    assert.equal(edited.entities.getName(created), 'Wall C');
    assert.equal(edited.entities.getGlobalId(created), '2Wall00000000000000012');
  });
});

it('LandXML preflight sees pending edits in the legacy single-model session (#10676)', async () => {
  assert.ok(mod, 'edited-model-bytes must exist');
  const store = await parse(new TextEncoder().encode(FIXTURE.replace(
    "#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);",
    "#10=IFCGEOGRAPHICELEMENT('0Wall00000000000000010',$,'Terrain',$,$,$,$,$,.TERRAIN.);",
  )));
  const snapshot = useViewerStore.getState();
  useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map() });
  try {
    const view = getOrCreateMutationView(useViewerStore, 'legacy');
    assert.ok(view);
    view.setAttribute(10, 'Name', 'Edited terrain', 'Terrain');
    const selection = resolveTerrainSelection({
      refs: [{ modelId: 'legacy', expressId: 10 }],
      models: useViewerStore.getState().models,
      legacyStore: store,
    });
    assert.equal(selection.kind, 'ready');
    const bytes = mod.editedModelBytes(selection.store, useViewerStore.getState().getMutationView(selection.modelId));
    const exported = await parse(bytes);
    assert.equal(exported.entities.getName(10), 'Edited terrain');

    // A pre-existing default-key overlay still exists in some legacy sessions.
    const prior = new MutablePropertyView(store.properties ?? null, 'default');
    configureMutationView(prior, store);
    prior.setAttribute(10, 'Name', 'Earlier terrain', 'Terrain');
    prior.setAttribute(11, 'Name', 'Distinct historical edit', 'Wall B');
    useViewerStore.getState().registerMutationView('default', prior);
    const read = async (modelId: string, expressId = 10): Promise<string> => {
      const current = useViewerStore.getState().getMutationView(modelId);
      return (await parse(mod!.editedModelBytes(selection.store, current))).entities.getName(expressId);
    };
    assert.equal(await read('default'), 'Edited terrain', 'the canonical overlay wins over an earlier alias');
    assert.equal(await read('legacy'), 'Edited terrain');
    assert.equal(await read('default', 11), 'Distinct historical edit', 'nonoverlapping alias edits must survive export');
    useViewerStore.getState().setAttribute('default', 11, 'Name', 'Visible with both overlays', 'Distinct historical edit');
    assert.equal(await read('legacy', 11), 'Visible with both overlays');
    useViewerStore.getState().undo('default');
    assert.equal(await read('legacy', 11), 'Distinct historical edit');
    useViewerStore.getState().clearMutationView('legacy');
    assert.equal(await read('legacy'), 'Terrain', 'clear discards the canonical overlay through an alias');
    assert.equal(await read('default'), 'Terrain', 'clear also discards the earlier alias overlay');

    for (const storedId of ['default', 'legacy']) {
      const existing = new MutablePropertyView(store.properties ?? null, storedId);
      configureMutationView(existing, store);
      existing.setAttribute(10, 'Name', 'Pending terrain', 'Terrain');
      useViewerStore.getState().registerMutationView(storedId, existing);
      const alias = storedId === 'default' ? 'legacy' : 'default';
      assert.equal(await read(alias), 'Pending terrain', 'all aliases read the pending rename');
      useViewerStore.setState({ editEnabled: true });
      const mutate = createMutateAdapter(useViewerStore);
      const ref = { modelId: alias, expressId: 11 };
      await mutate.setAttribute(ref, 'Name', 'Second edit');
      assert.equal(await read(alias), 'Pending terrain', 'the SDK write preserves the earlier edit');
      assert.equal(await read(alias, 11), 'Second edit');
      assert.equal(await mutate.undo(alias), true);
      assert.equal(await read(alias, 11), 'Wall B');
      assert.equal(await mutate.redo(alias), true);
      assert.equal(await read(alias, 11), 'Second edit');
      const state = useViewerStore.getState();
      assert.ok(state.createPropertySet('__legacy__', 10, 'Pset_Alias', [{ name: 'Marker', value: 'Legacy' }]));
      assert.ok(state.createQuantitySet('__legacy__', 10, 'Qto_Alias', [{ name: 'ItemCount', value: 3, quantityType: QuantityType.Count }]));
      assert.ok(state.setQuantity('__legacy__', 10, 'Qto_Alias', 'ItemCount', 4));
      const listSources = storesWithMutationViews([store], state.models, state.mutationViews);
      assert.equal(listSources[0].view?.getAttributeMutationsForEntity(10)[0]?.value, 'Pending terrain');
      const bytesWithSets = new TextDecoder().decode(mod.editedModelBytes(store, state.getMutationView(alias)));
      assert.match(bytesWithSets, /'Pset_Alias'/);
      assert.match(bytesWithSets, /'Qto_Alias'/);
      assert.ok(state.deletePropertySet('__legacy__', 10, 'Pset_Alias'));
      const bytesWithoutSet = new TextDecoder().decode(mod.editedModelBytes(store, state.getMutationView(alias)));
      assert.doesNotMatch(bytesWithoutSet, /'Pset_Alias'/);
      useViewerStore.getState().clearMutationView(alias);
    }
  } finally {
    useViewerStore.setState(snapshot);
  }
});

it('an older legacy overlay survives registration of the canonical overlay and remains undoable (#10676)', async () => {
  assert.ok(mod);
  const store = await parse(new TextEncoder().encode(FIXTURE));
  const initial = useViewerStore.getState();
  const historical = new MutablePropertyView(store.properties, 'default');
  const canonical = new MutablePropertyView(store.properties, '__legacy__');
  configureMutationView(historical, store);
  configureMutationView(canonical, store);
  useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map(), undoStacks: new Map() });
  try {
    useViewerStore.getState().registerMutationView('default', historical);
    useViewerStore.getState().setAttribute('default', 11, 'Name', 'Historical wall', 'Wall B');
    canonical.setAttribute(10, 'Name', 'Canonical wall', 'Wall A');
    useViewerStore.getState().registerMutationView('__legacy__', canonical);

    const bake = async () => parse(mod!.editedModelBytes(store, useViewerStore.getState().getMutationView('legacy')));
    const exported = await bake();
    assert.equal(exported.entities.getName(10), 'Canonical wall');
    assert.equal(exported.entities.getName(11), 'Historical wall');
    assert.equal(useViewerStore.getState().getMutationView('default'), canonical);
    useViewerStore.getState().undo('default');
    assert.equal((await bake()).entities.getName(11), 'Wall B');
    assert.equal((await bake()).entities.getName(10), 'Canonical wall');
  } finally {
    useViewerStore.setState(initial);
  }
});

it('undoing an obsolete historical field cannot overwrite the winning legacy edit (#10676)', async () => {
  assert.ok(mod);
  const store = await parse(new TextEncoder().encode(FIXTURE));
  const initial = useViewerStore.getState();
  const historical = new MutablePropertyView(store.properties, 'default');
  const canonical = new MutablePropertyView(store.properties, '__legacy__');
  configureMutationView(historical, store);
  configureMutationView(canonical, store);
  useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map(), undoStacks: new Map() });
  try {
    const s = useViewerStore.getState();
    s.registerMutationView('default', historical);
    s.setAttribute('default', 10, 'Name', 'Obsolete wall rename', 'Wall A');
    canonical.setAttribute(10, 'Name', 'Canonical wall rename', 'Wall A');
    s.registerMutationView('__legacy__', canonical);
    const read = async () => {
      const view = s.getMutationView('legacy');
      return (await parse(mod!.editedModelBytes(store, view))).entities.getName(10);
    };
    assert.equal(await read(), 'Canonical wall rename');
    s.undo('default');
    assert.equal(await read(), 'Canonical wall rename', 'obsolete alias history cannot erase the winning edit');
  } finally {
    useViewerStore.setState(initial);
  }
});

it('registration with an overlapping allocated EXPRESS ID preserves both input views (#10676)', async () => {
  const store = await parse(new TextEncoder().encode(FIXTURE));
  const initial = useViewerStore.getState();
  const historical = new MutablePropertyView(store.properties, 'default');
  const canonical = new MutablePropertyView(store.properties, '__legacy__');
  configureMutationView(historical, store);
  configureMutationView(canonical, store);
  const legacyEntity = historical.createEntity('IfcWall', ['0Wall00000000000000012', null, 'Legacy allocation']);
  const canonicalEntity = canonical.createEntity('IfcWall', ['0Wall00000000000000013', null, 'Canonical allocation']);
  assert.equal(legacyEntity.expressId, canonicalEntity.expressId);
  useViewerStore.setState({ models: new Map(), ifcDataStore: store, mutationViews: new Map() });
  try {
    const s = useViewerStore.getState();
    s.registerMutationView('default', historical);
    assert.throws(() => s.registerMutationView('__legacy__', canonical), /Conflicting overlay edits on entity/);
    assert.equal(s.getMutationView('legacy'), historical);
    assert.equal(historical.getNewEntity(legacyEntity.expressId)?.attributes[2], 'Legacy allocation');
    assert.equal(canonical.getNewEntity(canonicalEntity.expressId)?.attributes[2], 'Canonical allocation');
  } finally {
    useViewerStore.setState(initial);
  }
});

it('registration refuses to merge edited aliases bound to different sources (#10676)', async () => {
  const sourceA = await parse(new TextEncoder().encode(FIXTURE));
  const sourceB = await parse(new TextEncoder().encode(FIXTURE.replace('Wall A', 'Other source')));
  const initial = useViewerStore.getState();
  const historical = new MutablePropertyView(sourceA.properties, 'default');
  const incoming = new MutablePropertyView(sourceB.properties, '__legacy__');
  configureMutationView(historical, sourceA);
  configureMutationView(incoming, sourceB);
  historical.setAttribute(11, 'Name', 'Source A edit');
  incoming.setAttribute(10, 'Name', 'Source B edit');
  useViewerStore.setState({ models: new Map(), ifcDataStore: sourceA, mutationViews: new Map() });
  try {
    const state = useViewerStore.getState();
    state.registerMutationView('default', historical);
    assert.throws(() => state.registerMutationView('__legacy__', incoming), /same source/);
    assert.equal(useViewerStore.getState().getMutationView('legacy'), historical);
    assert.deepEqual(incoming.getAttributeMutationsForEntity(11), []);
    assert.equal(historical.getAttributeMutationsForEntity(11)[0]?.value, 'Source A edit');
  } finally {
    useViewerStore.setState(initial);
  }
});

it('merges and clears only the legacy source while an alias-named model is federated (#10762)', async () => {
  assert.ok(mod);
  const source = await parse(new TextEncoder().encode(FIXTURE));
  const otherSource = await parse(new TextEncoder().encode(FIXTURE.replace('Wall A', 'Other source')));
  const initial = useViewerStore.getState();
  const canonical = new MutablePropertyView(source.properties, '__legacy__');
  const historical = new MutablePropertyView(source.properties, 'legacy');
  const federated = new MutablePropertyView(otherSource.properties, 'default');
  configureMutationView(canonical, source);
  configureMutationView(historical, source);
  configureMutationView(federated, otherSource);
  canonical.setAttribute(10, 'Name', 'Canonical rename');
  historical.setAttribute(11, 'Name', 'Historical rename');
  federated.setAttribute(11, 'Name', 'Federated rename');
  const other = { ...fixtureModel('default'), ifcDataStore: otherSource };

  useViewerStore.setState({ models: new Map([['default', other]]), ifcDataStore: source, mutationViews: new Map([['default', federated]]) });
  try {
    const state = useViewerStore.getState();
    state.registerMutationView('__legacy__', canonical);
    state.registerMutationView('legacy', historical);
    const merged = await parse(mod.editedModelBytes(source, state.getMutationView('legacy')));
    assert.equal(merged.entities.getName(10), 'Canonical rename');
    assert.equal(merged.entities.getName(11), 'Historical rename');
    state.clearMutationView('legacy');
    assert.equal(state.getMutationView('__legacy__'), null);
    const untouched = await parse(mod.editedModelBytes(otherSource, state.getMutationView('default')));
    assert.equal(untouched.entities.getName(11), 'Federated rename');
  } finally {
    useViewerStore.setState(initial);
  }
});

it('selected entity actions reject a deleted legacy target during federation (#10676)', async () => {
  const store = await parse(new TextEncoder().encode(FIXTURE));
  const initial = useViewerStore.getState();
  const offset = federationRegistry.registerModel('legacy', 11);
  const other = fixtureModel('federated', { idOffset: offset + 1_000_000 });
  const view = new MutablePropertyView(store.properties, '__legacy__');
  configureMutationView(view, store);
  useViewerStore.setState({
    models: new Map([[other.id, other]]), ifcDataStore: store,
    mutationViews: new Map([['__legacy__', view]]),
    selectedEntityId: federationRegistry.toGlobalId('legacy', 10), selectedEntityIds: new Set(),
  });
  try {
    assert.equal(selectedEntityActionTarget(), offset + 10);
    view.deleteEntity(10);
    assert.equal(selectedEntityActionTarget(), null);
  } finally {
    federationRegistry.unregisterModel('legacy');
    useViewerStore.setState(initial);
  }
});

it('legacy zone evidence sees quantities stored under the default alias (#10676)', async () => {
  const store = await parse(new TextEncoder().encode(FIXTURE));
  const snapshot = useViewerStore.getState();
  const view = new MutablePropertyView(store.properties ?? null, 'default');
  configureMutationView(view, store);
  view.createQuantitySet(10, 'Qto_WallBaseQuantities', [
    { name: 'GrossVolume', value: 8, quantityType: QuantityType.Volume },
  ]);
  useViewerStore.setState({
    models: new Map(), ifcDataStore: store, mutationViews: new Map([['default', view]]),
  });
  try {
    const evidence = zoneQuantitySources(useViewerStore.getState())({ modelId: 'legacy', expressId: 10 });
    const quantities = evidence.quantities.find(qset => qset.name === 'Qto_WallBaseQuantities')?.quantities;
    assert.equal(quantities?.find(quantity => quantity.name === 'GrossVolume')?.value, 8);
  } finally {
    useViewerStore.setState(snapshot);
  }
});

it('legacy zone evidence uses the loaded source during a mixed-model transition (#10676)', async () => {
  const store = await parse(new TextEncoder().encode(FIXTURE));
  const other = fixtureModel('federated', { idOffset: 1_000_000 });
  const snapshot = useViewerStore.getState();
  const view = new MutablePropertyView(store.properties, 'default');
  configureMutationView(view, store);
  view.createQuantitySet(10, 'Qto_WallBaseQuantities', [
    { name: 'GrossVolume', value: 8, quantityType: QuantityType.Volume },
  ]);
  useViewerStore.setState({
    models: new Map([[other.id, other]]), ifcDataStore: store, mutationViews: new Map([['default', view]]),
  });
  try {
    const state = useViewerStore.getState();
    const evidence = zoneQuantitySources(state)({ modelId: 'legacy', expressId: 10 });
    assert.equal(evidence.status, 'available');
    const quantities = evidence.quantities.find(qset => qset.name === 'Qto_WallBaseQuantities')?.quantities;
    assert.equal(quantities?.find(quantity => quantity.name === 'GrossVolume')?.value, 8);
    assert.ok(zoneQuantitySourceIdentity(state, new Set(['legacy'])).includes(view));
    assert.ok(!zoneQuantitySourceIdentity(state, new Set(['federated'])).includes(view));
    const defaultEvidence = zoneQuantitySources(state)({ modelId: 'default', expressId: 10 });
    assert.equal(defaultEvidence.quantities[0]?.quantities[0]?.value, 8);
    assert.ok(zoneQuantitySourceIdentity(state, new Set(['default'])).includes(view));

    state.clearMutationView('legacy');
    const created = getOrCreateMutationView(useViewerStore, 'legacy');
    assert.ok(created, 'the SDK can create a legacy view while another model is registered');
    created.setAttribute(10, 'Name', 'First SDK edit');
    assert.ok(mod);
    const edited = await parse(mod.editedModelBytes(store, useViewerStore.getState().getMutationView('default')));
    assert.equal(edited.entities.getName(10), 'First SDK edit');


    const federatedStore = await parse(new TextEncoder().encode(FIXTURE.replace('Wall A', 'Federated wall')));
    const defaultModel = { ...fixtureModel('default', { idOffset: 1_000_000 }), ifcDataStore: federatedStore };
    const federatedView = new MutablePropertyView(federatedStore.properties, 'default');
    configureMutationView(federatedView, federatedStore);
    federatedView.createQuantitySet(10, 'Qto_WallBaseQuantities', [
      { name: 'GrossVolume', value: 99, quantityType: QuantityType.Volume },
    ]);
    useViewerStore.setState({
      models: new Map([['default', defaultModel]]),
      mutationViews: new Map([['default', federatedView], ['__legacy__', view]]),
    });
    const mixed = zoneQuantitySources(useViewerStore.getState());
    assert.equal(mixed({ modelId: 'legacy', expressId: 10 }).quantities[0]?.quantities[0]?.value, 8);
    assert.equal(mixed({ modelId: 'default', expressId: 10 }).quantities[0]?.quantities[0]?.value, 99);

    const loadingLegacyModel = { ...fixtureModel('legacy', { idOffset: 2_000_000 }), ifcDataStore: null };
    useViewerStore.setState({ models: new Map([['legacy', loadingLegacyModel]]) });
    const loadingState = useViewerStore.getState();
    const unavailable = zoneQuantitySources(loadingState)({ modelId: 'legacy', expressId: 10 });
    assert.equal(unavailable.status, 'unavailable-model');
    assert.deepEqual(unavailable.quantities, []);
    assert.equal(unavailable.scale, null);
    assert.ok(!zoneQuantitySourceIdentity(loadingState, new Set(['legacy'])).includes(store));
  } finally {
    useViewerStore.setState(snapshot);
  }
});

describe('editedModelBytes on an IFC2X3 model (#5397 review)', () => {
  it('re-serializes an edited IFC2X3 model too: only IFC5 has no STEP to regenerate', async () => {
    assert.ok(mod, 'edited-model-bytes must exist');
    const store = await parse(new TextEncoder().encode(FIXTURE.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))")));
    assert.equal(store.schemaVersion, 'IFC2X3');
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    configureMutationView(view, store);
    view.deleteEntity(11);

    const edited = await parse(mod!.editedModelBytes(store, view));
    assert.equal(edited.schemaVersion, 'IFC2X3');
    assert.equal(edited.entityIndex.byId.has(11), false, 'the IFC2X3 deletion reaches the bytes');
    assert.equal(edited.entityIndex.byId.has(10), true);
  });
});
