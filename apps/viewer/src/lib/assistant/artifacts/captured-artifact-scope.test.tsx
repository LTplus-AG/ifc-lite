/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
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
import { loadListDefinitions } from '@/lib/lists/persistence';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { createLensDataProvider } from '@/lib/lens';
import { evaluateLensGroups } from '@/lib/lens/evaluate-lens-groups';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { toGlobalIdFromModels } from '@/store/globalId';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import { act } from 'react';
import { cleanup, click, render, type } from '@/test/render';
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
    const bytes = model.ifcDataStore!.source.slice();
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
afterEach(() => { cleanup(); useViewerStore.setState(original, true); localStorage.clear(); });

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
      const saved = loadListDefinitions().find(row => row.id === artifact.definition.id);
      assert.ok(saved);
      const { pairs } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
      return (await runListFederated(saved, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) })).rows.length;
    }
    case 'lens.proposal': {
      const exported = state.exportLenses().find(row => row.id === artifact.lens.id);
      assert.ok(exported);
      assert.ok(state.setSavedLenses([]).ok);
      assert.ok(useViewerStore.getState().importLenses(JSON.parse(JSON.stringify([exported]))).ok);
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
    const saved = loadListDefinitions().find(row => row.id === artifact.definition.id); assert.ok(saved);
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
