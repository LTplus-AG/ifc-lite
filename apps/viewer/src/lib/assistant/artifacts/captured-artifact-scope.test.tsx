/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { captureArtifactScope } from '@/lib/captured-artifact-scope';
import { evaluateAutoColorLens, evaluateLens } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import type { EntityRef } from '@/store/types';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { ARCH, WALL, seedArtifactModels } from '@/test/artifact-models-fixture';
import { parseArtifactProposal, type ArtifactKind } from './proposal-kinds';
import { previewArtifact, previewFilterGroups } from './artifact-preview';
import { artifactCapturedScope, type PreviewArtifact } from './preview-shared';
import { saveArtifact, type SavedArtifact } from './artifact-save';
import { loadSavedFilters } from '@/lib/search/saved-filters';
import { encodeSavedLens, migrateSavedLens } from '@/lib/lens/migrate-saved-lens';
import { encodeSavedList, decodeSavedList } from '@/lib/lists/saved-list-codec';
import { loadListDefinitions, importListDefinition } from '@/lib/lists/persistence';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { createLensDataProvider } from '@/lib/lens';
import { evaluateLensGroups } from '@/lib/lens/evaluate-lens-groups';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { toGlobalIdFromModels } from '@/store/globalId';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import { act } from 'react';
import { cleanup, click, render, type, waitFor } from '@/test/render';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { ArtifactProposalReview } from '@/components/viewer/assistant/ArtifactProposalReview';
import { resolveCapturedEntityScope } from '@ifc-lite/rules';
import { importLensFile } from '@/components/viewer/lens-import';
import { LensEditor } from '@/components/viewer/LensEditor';
import { AutoColorEditor } from '@/components/viewer/AutoColorEditor';
import { ListBuilder } from '@/components/viewer/lists/ListBuilder';
import { SearchModalFilterBuilder } from '@/components/viewer/SearchModal.filter.builder';
import { filterCandidates } from '@/lib/search/filter-candidates';
import { fixtureModels } from '@/test/store-fixture';

const original = useViewerStore.getState();
const groups = [{ combinator: 'AND' as const, rules: [{ kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall', 'IfcWallStandardCase'] }] }];
const cases: Array<{ kind: ArtifactKind; label: string; body: Record<string, unknown> }> = [
  { kind: 'filter.proposal', label: 'filter', body: { name: 'Captured walls', groups } },
  { kind: 'list.proposal', label: 'list', body: { list: { name: 'Captured wall names', entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  { kind: 'lens.proposal', label: 'manual lens', body: { lens: { name: 'Captured manual wall colors', rules: [{ name: 'Walls', groups, action: 'colorize', color: '#223344' }] } } },
  { kind: 'lens.proposal', label: 'auto-color lens', body: { lens: { name: 'Captured automatic colors', autoColor: { source: 'ifcType' } } } },
];
async function loadActualSources() {
  await seedArtifactModels({ federated: true });
  const models = new Map(useViewerStore.getState().models);
  for (const [id, model] of models) {
    const source = model.ifcDataStore!.source;
    const bytes = new Uint8Array(source.slice(0, source.byteLength));
    const sourceContentHash = await placementSourceIdentity(new Blob([bytes]), undefined, bytes);
    assert.ok(sourceContentHash, 'the actual native fixture obtains the same full-content identity as the loader');
    models.set(id, { ...model, sourceContentHash });
  }
  useViewerStore.setState({ models });
}
beforeEach(async () => {
  localStorage.clear();
  useViewerStore.setState(original, true);
  await loadActualSources();
});
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState({ messages: [], snapshot: null, archived: null, status: 'idle', error: null }); useViewerStore.setState(original, true); localStorage.clear(); });

/** Replay native persisted definitions through their native engines, never a metadata-only readback. */
const savedIdentities = new WeakMap<PreviewArtifact, SavedArtifact>();
async function replaySaved(artifact: PreviewArtifact): Promise<number> {
  let identity = savedIdentities.get(artifact);
  if (!identity) {
    const outcome = saveArtifact(artifact);
    assert.ok(outcome.ok, 'the real native library accepts the reviewed artifact');
    identity = outcome.saved;
    savedIdentities.set(artifact, identity);
  }
  const savedName = identity.name;
  const state = useViewerStore.getState();
  switch (artifact.kind) {
    case 'filter.proposal': {
      const saved = loadSavedFilters().find(row => row.name === savedName);
      assert.ok(saved);
      return (await previewFilterGroups(saved.name, saved.groups, state, undefined, saved.capturedScope)).matched;
    }
    case 'list.proposal': {
      const persisted = loadListDefinitions().find(row => row.id === artifact.definition.id);
      assert.ok(persisted);
      const saved = await importListDefinition(new File([JSON.stringify(encodeSavedList(persisted))], 'captured.list.json', { type: 'application/json' }));
      assert.ok(saved);
      const { pairs } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
      return (await runListFederated(saved, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) })).rows.length;
    }
    case 'lens.proposal': {
      const exported = state.exportLenses().find(row => row.id === artifact.lens.id);
      assert.ok(exported);
      assert.ok(state.setSavedLenses([]).ok);
      assert.ok((await importLensFile(new File([JSON.stringify([encodeSavedLens(exported)])], 'captured.lenses.json'), rows => useViewerStore.getState().importLenses(rows))).ok);
      const importedState = useViewerStore.getState();
      const saved = importedState.savedLenses.find(row => row.id === exported.id);
      assert.ok(saved);
      const provider = createLensDataProvider(importedState.models, importedState.ifcDataStore, importedState.mutationViews,
        id => importedState.resolveGlobalIdFromModels(id));
      if (saved.autoColor) return evaluateAutoColorLens(saved.autoColor, provider, saved.capturedScope).colorMap.size;
      const matches = await evaluateLensGroups(saved, evaluatorModelsFromState(importedState), importedState.models, new Set(importedState.modelTags.keys()));
      return evaluateLens(saved, provider, matches).colorMap.size;
    }
    case 'chart.proposal': throw new Error('Charts use their independent native dashboard scope.');
  }
}

function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const found = [...ui.querySelectorAll('button')].find(row => row.textContent?.trim() === label);
  assert.ok(found, `native editor exposes ${label}`);
  return found;
}

function selectRef(ref: EntityRef): void {
  act(() => {
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.setSelectedEntity(ref);
    state.setSelectedEntityId(toGlobalIdFromModels(state.models, ref.modelId, ref.expressId));
  });
}

test('#7186 native authored selection captures current record provenance and refuses tokenless replacement history', async () => {
  const state = useViewerStore.getState();
  const source = state.models.get(ARCH)!.ifcDataStore!;
  const view = new MutablePropertyView(source.properties, ARCH);
  view.setExpressIdWatermark(100000);
  const authored = view.createEntity('IfcWall', ['authored-scope-native-guid', null, 'Captured authored wall', null, null, null, null, null, '.NOTDEFINED.']);
  useViewerStore.setState({ mutationViews: new Map([[ARCH, view]]), mutationVersion: 1 });
  selectRef({ modelId: ARCH, expressId: authored.expressId });
  const scope = captureArtifactScope('selected', useViewerStore.getState());
  assert.equal(scope.sources[0].members[0].creationId, authored.creationId);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Authored scope identity', kind: 'filter.proposal', scope: 'selected', name: 'Captured authored wall', groups }), 'filter.proposal');
  const preview = await previewArtifact(proposal, useViewerStore.getState(), undefined, scope);
  assert.equal(preview.matched, 1, 'native criteria execute against the actual currently authored wall');
  view.deleteEntity(authored.expressId);
  view.restoreNewEntity({ expressId: authored.expressId, type: authored.type, attributes: structuredClone(authored.attributes) });
  assert.equal(view.getMutations().find(row => row.type === 'CREATE_ENTITY')?.id, authored.creationId);
  assert.throws(() => captureArtifactScope('selected', useViewerStore.getState()), /original identity is unavailable/,
    'a new capture cannot borrow detached original history for the tokenless current record');
  await assert.rejects(previewArtifact(proposal, useViewerStore.getState(), undefined, scope), /identity changed/,
    'an existing saved capture cannot bind the tokenless replacement either');
  view.restoreNewEntity(structuredClone(authored));
  assert.equal((await previewArtifact(proposal, useViewerStore.getState(), undefined, scope)).matched, 1,
    'native restoration of the original provenance-bearing record retains its captured population');
});

async function selectWall() {
  const rows = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), groups, { limit: Infinity });
  const wall = rows.find(row => row.modelId === ARCH);
  assert.ok(wall); assert.ok(rows.length > 1);
  selectRef({ modelId: ARCH, expressId: wall.expressId });
  return wall;
}

test('#7186 native Filter group editing retains capture; clear and recapture change native population explicitly', async () => {
  const wall = await selectWall();
  useViewerStore.getState().setSearchFilter({ groups, limit: Infinity });
  const ui = render(<SearchModalFilterBuilder />);
  click(button(ui, 'Capture selected'));
  assert.match(ui.textContent ?? '', /1 selected element captured from 1 file/);
  click(button(ui, 'Add group'));
  const run = async () => {
    const state = useViewerStore.getState(), models = evaluatorModelsFromState(state);
    return evaluateFilterGroupsFederated(models, state.searchFilter.groups, { limit: Infinity,
      candidateExpressIdsByModel: filterCandidates(models, state.searchIndexes, '', state.searchFilter.capturedScope) });
  };
  assert.deepEqual((await run()).map(row => [row.modelId, row.expressId]), [[ARCH, wall.expressId]], 'an empty OR group cannot widen captured membership');
  click(button(ui, 'Clear capture'));
  assert.ok((await run()).length > 1, 'explicitly clearing capture restores the native unscoped criteria population');
  click(button(ui, 'Capture selected'));
  assert.equal((await run()).length, 1, 'explicit recapture restricts the current native criteria again');
});

for (const entry of cases.filter(row => row.kind !== 'filter.proposal')) test(`#7186 native ${entry.label} editor saves captured membership with an ordinary edited name`, async () => {
  await selectWall();
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Pinned native editing', kind: entry.kind, scope: 'selected', ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  const state = useViewerStore.getState();
  const artifact = preview.artifact;
  let ui: HTMLElement;
  if (artifact.kind === 'list.proposal') {
    const prepared = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
    ui = render(<ListBuilder providers={prepared.providers} stores={prepared.stores} modelIds={prepared.pairs.map(row => row.modelId)}
      initial={artifact.definition} onSave={definition => state.addListDefinition(definition)} onCancel={() => cleanup()}
      onExecute={() => { throw new Error('This acceptance path must Save, not Run.'); }} />);
  } else {
    assert.ok(artifact.kind === 'lens.proposal');
    const onSave = (lens: typeof artifact.lens) => { assert.ok(state.createLens(lens).ok); };
    ui = artifact.lens.autoColor
      ? render(<AutoColorEditor initial={{ ...artifact.lens, autoColor: artifact.lens.autoColor }} onSave={onSave} onCancel={() => cleanup()}
        discovered={null} onRequestDiscovery={() => { throw new Error('IFC type editing needs no property discovery.'); }} />)
      : render(<LensEditor initial={artifact.lens} onSave={onSave} onCancel={() => cleanup()} />);
  }
  assert.match(ui.textContent ?? '', /1 selected element captured from 1 file/);
  const input = ui.querySelector<HTMLInputElement>('input'); assert.ok(input); assert.equal(input.type, 'text');
  type(input, `${entry.label} edited`);
  act(() => useViewerStore.getState().clearEntitySelection());
  click(button(ui, 'Save'));
  const savedState = useViewerStore.getState();
  if (artifact.kind === 'list.proposal') {
    const persisted = loadListDefinitions().find(row => row.id === artifact.definition.id);
      assert.ok(persisted);
      const saved = await importListDefinition(new File([JSON.stringify(encodeSavedList(persisted))], 'captured.list.json', { type: 'application/json' })); assert.ok(saved);
    const { pairs } = prepareListProviders(savedState, resolveRenderFrame(savedState.models, savedState.geometryResult));
    assert.equal((await runListFederated(saved, pairs, savedState, { evaluatorModels: evaluatorModelsFromState(savedState) })).rows.length, 1);
  } else {
    assert.ok(artifact.kind === 'lens.proposal');
    const saved = savedState.savedLenses.find(row => row.id === artifact.lens.id); assert.ok(saved);
    const provider = createLensDataProvider(savedState.models, savedState.ifcDataStore, savedState.mutationViews, id => savedState.resolveGlobalIdFromModels(id));
    const result = saved.autoColor ? evaluateAutoColorLens(saved.autoColor, provider, saved.capturedScope)
      : evaluateLens(saved, provider, await evaluateLensGroups(saved, evaluatorModelsFromState(savedState), savedState.models, new Set(savedState.modelTags.keys())));
    assert.equal(result.colorMap.size, 1, 'the native editor Save preserves the original captured membership after selection clears');
  }
});
for (const mode of ['selected', 'visible'] as const) for (const entry of cases) {
  test(`#7186 ${mode} ${entry.kind} ${entry.label} captures exactly one real federated member`, async () => {
    const state = useViewerStore.getState();
    const walls = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), groups, { limit: Infinity });
    const selected = walls.find(row => row.modelId === ARCH);
    assert.ok(selected); assert.ok(walls.length > 1, 'the actual native unscoped population is wider than this selected member');
    selectRef({ modelId: ARCH, expressId: selected.expressId });
    if (mode === 'visible') {
      // Visibility reads the renderer's resident EXPRESS IDs and IFC types,
      // not mesh coordinates. These empty mesh buffers exercise that protocol
      // with actual parsed wall identities; this is not a rendering claim.
      const models = new Map([...state.models].map(([id, model]) => {
        assert.ok(model.geometryResult);
        return [id, { ...model, geometryResult: { ...model.geometryResult,
          meshes: walls.filter(row => row.modelId === id).map(row => ({
            expressId: toGlobalIdFromModels(state.models, id, row.expressId), ifcType: row.ifcType,
            positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), color: [1, 1, 1, 1] as [number, number, number, number],
          })),
        } }] as const;
      }));
      const selectedId = toGlobalIdFromModels(models, ARCH, selected.expressId);
      useViewerStore.setState({ models, hiddenEntities: new Set(walls.map(row => toGlobalIdFromModels(models, row.modelId, row.expressId)).filter(id => id !== selectedId)),
        lensHiddenIds: new Set(), isolatedEntities: null, classFilter: null, selectedStoreys: new Set() });
      assert.deepEqual(getVisibleBasketEntityRefsFromStore(), [{ modelId: ARCH, expressId: selected.expressId }], 'native visibility resolves the fixture resident IDs and hidden set before capture');
    }
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'One captured wall', kind: entry.kind, scope: mode, ...entry.body }), entry.kind);
    const preview = await previewArtifact(proposal, useViewerStore.getState());
    assert.equal(preview.matched, 1, 'native engine evaluates only the captured selected member');
    assert.deepEqual(preview.population.map(row => [row.modelId, row.count]), [[ARCH, 1], [WALL, 0]], 'native population evidence keeps an explicit empty count for the other loaded model');
    const pinned = artifactCapturedScope(preview.artifact);
    assert.ok(pinned);
    const foreign = walls.find(row => row.modelId === WALL);
    assert.ok(foreign);
    selectRef({ modelId: WALL, expressId: foreign.expressId });
    if (mode === 'visible') useViewerStore.setState({ hiddenEntities: new Set([toGlobalIdFromModels(useViewerStore.getState().models, ARCH, selected.expressId)]) });
    const rerun = await previewArtifact(proposal, useViewerStore.getState(), undefined, pinned);
    assert.deepEqual(rerun.population.map(row => [row.modelId, row.count]), [[ARCH, 1], [WALL, 0]], 'a native review rerun keeps the original capture despite a changed selection');
    assert.equal(await replaySaved(preview.artifact), 1, 'native persistence or Lens JSON export/import retains the captured engine population');
    await loadActualSources(); // Fresh native IfcParser stores from the original files.
    act(() => useViewerStore.setState(fixtureModels(...[...useViewerStore.getState().models].map(([id, model]) => ({ ...model, id: `reloaded-${id}` })))));
    const reloaded = await previewArtifact(proposal, useViewerStore.getState(), undefined, pinned);
    assert.deepEqual(reloaded.population.map(row => [row.modelId, row.count]), [[`reloaded-${ARCH}`, 1], [`reloaded-${WALL}`, 0]],
      'fresh source stores with new runtime model IDs resolve the original native capture');
    assert.equal(await replaySaved(preview.artifact), 1, 'the actual persisted native definition replays against freshly parsed sources and new runtime model IDs');
    act(() => useViewerStore.getState().removeModel(`reloaded-${ARCH}`));
    await assert.rejects(previewArtifact(proposal, useViewerStore.getState(), undefined, pinned), /Captured scope source is missing, replaced, or ambiguous/,
      'unloading the captured file must refuse instead of evaluating the remaining loaded file');
  });
}

// #7186 A damaged versioned file must never become an unscoped native artifact.
test('#7186 native scoped codecs refuse future and malformed captured envelopes', async () => {
  const entry = cases.find(row => row.label === 'manual lens')!;
  await selectWall();
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Codec control', kind: entry.kind, scope: 'selected', ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.equal(preview.artifact.kind, 'lens.proposal');
  if (preview.artifact.kind !== 'lens.proposal') throw new Error('Unexpected artifact');
  const lens = preview.artifact.lens;
  assert.equal(migrateSavedLens(encodeSavedLens(lens))?.capturedScope?.sources[0].members.length, 1);
  const futureLens = { format: 'ifc-lite-captured-lens', version: 2, lens };
  assert.equal(migrateSavedLens(futureLens), null);
  const before = useViewerStore.getState().savedLenses;
  const outcome = await importLensFile(new File([JSON.stringify([futureLens])], 'future.lenses.json'), rows => useViewerStore.getState().importLenses(rows));
  assert.equal(outcome.ok, false);
  assert.equal(useViewerStore.getState().savedLenses, before, 'refusal does not mutate the native saved library');
  assert.equal(migrateSavedLens({ format: 'ifc-lite-captured-lens', version: 1, lens: { ...lens, capturedScope: undefined } }), null);
  const listEntry = cases.find(row => row.label === 'list')!;
  const listProposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Codec list', kind: listEntry.kind, scope: 'selected', ...listEntry.body }), listEntry.kind);
  const listPreview = await previewArtifact(listProposal, useViewerStore.getState());
  if (listPreview.artifact.kind !== 'list.proposal') throw new Error('Unexpected artifact');
  const definition = listPreview.artifact.definition;
  assert.equal(decodeSavedList(encodeSavedList(definition)).capturedScope?.sources[0].members.length, 1);
  for (const envelope of [
    { format: 'ifc-lite-captured-list', version: 2, definition },
    { format: 'ifc-lite-captured-list', version: 1, definition: { ...definition, capturedScope: undefined } },
  ]) {
    assert.throws(() => decodeSavedList(envelope), /captured population cannot be read/);
    await assert.rejects(importListDefinition(new File([JSON.stringify(envelope)], 'unreadable.list.json')));
  }
});

test('#7186 native Flavor file export/import preserves captured Lens output and reports unreadable versions', async () => {
  const { ExtensionHostService } = await import('@/services/extensions/host');
  const { IdbFlavorStorage } = await import('@/services/extensions/idb-flavor-storage');
  const { createBimContext } = await import('@ifc-lite/sdk');
  await new IdbFlavorStorage().clear();
  const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
    send: () => Promise.reject(new Error('No SDK request belongs to native flavor population restore')),
    subscribe: () => () => {}, close: () => {},
  } }) });
  try {
    await selectWall();
    const entry = cases.find(row => row.label === 'manual lens')!;
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Flavor captured wall', kind: entry.kind, scope: 'selected', ...entry.body }), entry.kind);
    const preview = await previewArtifact(proposal, useViewerStore.getState());
    if (preview.artifact.kind !== 'lens.proposal') throw new Error('Unexpected artifact');
    const lens = preview.artifact.lens;
    const stamp = new Date().toISOString();
    const flavor = {
      schemaVersion: 1 as const, id: 'local.captured-native', name: 'Captured native', description: '', createdAt: stamp, updatedAt: stamp,
      extensions: [], lenses: [{ id: lens.id, name: lens.name, definition: encodeSavedLens(lens) as import('@ifc-lite/extensions').Flavor['lenses'][number]['definition'] }],
      savedQueries: [], keybindings: [], layout: { state: {} }, settings: {},
    };
    await host.flavors.put(flavor);
    const bytes = await host.flavors.exportFlavor(flavor.id);
    assert.ok(bytes.length > 0);
    const unpacked = await host.flavors.preview(bytes);
    const imported = await host.flavors.importFlavor(unpacked, { strategy: 'save-as-new', newId: 'local.captured-imported' });
    const outcome = await host.switchFlavor(imported.id);
    assert.equal(outcome.unapplied.some(part => part.part === 'lenses'), false);
    const state = useViewerStore.getState();
    const saved = state.savedLenses.find(row => row.id === lens.id);
    assert.ok(saved);
    const provider = createLensDataProvider(state.models, state.ifcDataStore, state.mutationViews, id => state.resolveGlobalIdFromModels(id));
    const matches = await evaluateLensGroups(saved, evaluatorModelsFromState(state), state.models, new Set(state.modelTags.keys()));
    assert.equal(evaluateLens(saved, provider, matches).colorMap.size, 1, 'actual file roundtrip and flavor activation preserve native captured output');
    const unreadable = { ...flavor, id: 'local.unreadable-capture', lenses: [{ id: lens.id, name: lens.name,
      definition: { format: 'ifc-lite-captured-lens', version: 2, lens } as unknown as import('@ifc-lite/extensions').Flavor['lenses'][number]['definition'] }] };
    await host.flavors.put(unreadable);
    const prior = state.savedLenses;
    const refused = await host.switchFlavor(unreadable.id);
    assert.ok(refused.unapplied.some(part => part.part === 'lenses' && /population.*cannot be read/.test(part.message)));
    assert.equal(useViewerStore.getState().savedLenses, prior, 'an unreadable population does not replace the native Lens library');
  } finally { await host.dispose(); }
});

test('#7186 native Document captured List replays through file, durable storage and existing Document backup; versions1..12 remain readable', async () => {
  const { clearContentDatabase } = await import('@/test/content-fixture');
  const { coverSheetDocument } = await import('@/lib/document/presets');
  const { DOCUMENT_VERSION, listCopyForDocument } = await import('@/lib/document/types');
  const { parseDocumentFile, loadDocuments } = await import('@/lib/document/persistence');
  const { createContentBackup, parseContentBackup } = await import('@/lib/storage/content-backup');
  await clearContentDatabase();
  await selectWall();
  const entry = cases.find(row => row.label === 'list')!;
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Document scope', kind: entry.kind, scope: 'selected', ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  if (preview.artifact.kind !== 'list.proposal') throw new Error('Unexpected artifact');
  const definition = preview.artifact.definition;
  const document = { ...coverSheetDocument(), blocks: [{ kind: 'table' as const, id: 'captured-table',
    source: { kind: 'list' as const, list: listCopyForDocument(definition, 'document-list-copy') }, maxRows: 10 }] };
  assert.equal(document.version, 13, 'native document compatibility version protects executable captured List semantics');
  const run = async (doc: import('@/lib/document/types').DocumentSpec) => {
    const block = doc.blocks[0];
    if (block.kind !== 'table' || block.source.kind !== 'list') throw new Error('Expected native table');
    const state = useViewerStore.getState();
    const { pairs } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
    return (await runListFederated(block.source.list, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) })).rows.length;
  };
  const imported = parseDocumentFile(JSON.stringify(document));
  assert.equal(await run(imported), 1);
  assert.ok(await useViewerStore.getState().initializeDocuments());
  assert.ok(await useViewerStore.getState().upsertDocument(imported));
  const stored = (await loadDocuments()).find(row => row.id === imported.id);
  assert.ok(stored); assert.equal(await run(stored), 1);
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ document: [stored], validation: [], comparison: [] })));
  assert.equal(await run(backup.libraries.document[0]), 1, 'existing Document backup codec keeps its executable captured List population');
  for (let version = 1; version < DOCUMENT_VERSION; version++) {
    const legacy = { ...document, version, blocks: document.blocks.map(block => ({ ...block,
      source: { kind: 'list', list: { ...block.source.list, capturedScope: undefined } } })) };
    const migrated = parseDocumentFile(JSON.stringify(legacy));
    assert.equal(migrated.version, DOCUMENT_VERSION);
    assert.ok(await run(migrated) > 1, `native unscoped version${version} retains its broad criteria population`);
  }
});


test('#7186 mounted review captures original selected population before asynchronous schema discovery', async () => {
  const originalWall = await selectWall();
  const walls = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), groups, { limit: Infinity });
  const replacement = walls.find(row => row.modelId === WALL)!;
  assert.ok(replacement);
  const entry = cases.find(row => row.label === 'filter')!;
  act(() => useAssistant.setState({ status: 'idle', error: null, messages: [{ role: 'assistant', model: 'recorded',
    content: JSON.stringify({ version: 1, title: 'Original selected walls', kind: entry.kind, scope: 'selected', ...entry.body }) }] }));
  const ui = render(<ArtifactProposalReview onAsk={null} />);
  assert.match(ui.textContent ?? '', /Checking the names against the loaded models/, 'actual native schema discovery is still pending');
  selectRef({ modelId: WALL, expressId: replacement.expressId });
  const save = () => [...ui.querySelectorAll('button')].find(row => row.textContent?.trim() === 'Save to saved filters');
  await waitFor(() => !!save() && !save()?.disabled, 'native review completes after initial schema discovery');
  click(save()!);
  const saved = loadSavedFilters().find(row => row.name === 'Captured walls');
  assert.ok(saved?.capturedScope);
  const state = useViewerStore.getState(), models = evaluatorModelsFromState(state);
  const result = await evaluateFilterGroupsFederated(models, saved.groups, {
    limit: Infinity, candidateExpressIdsByModel: resolveCapturedEntityScope(saved.capturedScope, models),
  });
  assert.deepEqual(result.map(row => [row.modelId, row.expressId]), [[ARCH, originalWall.expressId]], 'native saved output uses the selection at review creation rather than a later schema-scan selection');
});

test('#7186 mounted review refuses unavailable capture identity without broadening its native population', async () => {
  await selectWall();
  const state = useViewerStore.getState(), models = new Map(state.models);
  const source = models.get(ARCH); assert.ok(source);
  models.set(ARCH, { ...source, sourceContentHash: undefined });
  useViewerStore.setState({ models });
  const entry = cases.find(row => row.label === 'filter')!;
  act(() => useAssistant.setState({ status: 'idle', error: null, messages: [{ role: 'assistant', model: 'recorded',
    content: JSON.stringify({ version: 1, title: 'Unavailable selected walls', kind: entry.kind, scope: 'selected', ...entry.body }) }] }));
  const ui = render(<ArtifactProposalReview onAsk={null} />);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /original file identity is unavailable/);
  await waitFor(() => !(ui.textContent ?? '').includes('Checking the names against the loaded models'), 'actual schema discovery finishes despite a refused capture');
  assert.ok(![...ui.querySelectorAll('button')].some(row => row.textContent?.trim() === 'Save to saved filters'), 'native save never becomes available for an unproved captured population');
  assert.deepEqual(loadSavedFilters(), []);
});
