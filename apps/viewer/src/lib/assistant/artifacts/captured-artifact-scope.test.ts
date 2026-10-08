/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { evaluateAutoColorLens, evaluateLens } from '@ifc-lite/lens';
import { useViewerStore } from '@/store';
import { entityRefToString } from '@/store/entity-ref';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { ARCH, WALL, seedArtifactModels } from '@/test/artifact-models-fixture';
import { parseArtifactProposal, type ArtifactKind } from './proposal-kinds';
import { previewArtifact, previewFilterGroups } from './artifact-preview';
import { artifactCapturedScope, type PreviewArtifact } from './preview-shared';
import { saveArtifact } from './artifact-save';
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

const original = useViewerStore.getState();
const groups = [{ combinator: 'AND' as const, rules: [{ kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall', 'IfcWallStandardCase'] }] }];
beforeEach(async () => {
  localStorage.clear();
  useViewerStore.setState(original, true);
  await seedArtifactModels({ federated: true });
  const models = new Map(useViewerStore.getState().models);
  for (const [id, model] of models) {
    const bytes = model.ifcDataStore!.source.slice();
    const sourceContentHash = await placementSourceIdentity(new Blob([bytes]), undefined, bytes);
    assert.ok(sourceContentHash, 'the actual native fixture obtains the same full-content identity as the loader');
    models.set(id, { ...model, sourceContentHash });
  }
  useViewerStore.setState({ models });
});
afterEach(() => { useViewerStore.setState(original, true); localStorage.clear(); });

/** Replay native persisted definitions through their native engines, never a metadata-only readback. */
async function replaySaved(artifact: PreviewArtifact): Promise<number> {
  const outcome = saveArtifact(artifact);
  assert.ok(outcome.ok, 'the real native library accepts the reviewed artifact');
  const state = useViewerStore.getState();
  switch (artifact.kind) {
    case 'filter.proposal': {
      const saved = loadSavedFilters().find(row => row.name === outcome.saved.name);
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
const cases: Array<{ kind: ArtifactKind; label: string; body: Record<string, unknown> }> = [
  { kind: 'filter.proposal', label: 'filter', body: { name: 'Captured walls', groups } },
  { kind: 'list.proposal', label: 'list', body: { list: { name: 'Captured wall names', entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  { kind: 'lens.proposal', label: 'manual lens', body: { lens: { name: 'Captured manual wall colors', rules: [{ name: 'Walls', groups, action: 'colorize', color: '#223344' }] } } },
  { kind: 'lens.proposal', label: 'auto-color lens', body: { lens: { name: 'Captured automatic colors', autoColor: { source: 'ifcType' } } } },
];
for (const mode of ['selected', 'visible'] as const) for (const entry of cases) {
  test(`#7186 ${mode} ${entry.kind} ${entry.label} captures exactly one real federated member`, async () => {
    const state = useViewerStore.getState();
    const walls = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), groups, { limit: Infinity });
    const selected = walls.find(row => row.modelId === ARCH);
    assert.ok(selected); assert.ok(walls.length > 1, 'the actual native unscoped population is wider than this selected member');
    useViewerStore.setState({ selectedEntities: [{ modelId: ARCH, expressId: selected.expressId }], selectedEntitiesSet: new Set([entityRefToString({ modelId: ARCH, expressId: selected.expressId })]), selectedEntity: { modelId: ARCH, expressId: selected.expressId } });
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
    useViewerStore.getState().setSelectedEntity({ modelId: WALL, expressId: foreign.expressId });
    if (mode === 'visible') useViewerStore.setState({ hiddenEntities: new Set([toGlobalIdFromModels(useViewerStore.getState().models, ARCH, selected.expressId)]) });
    const rerun = await previewArtifact(proposal, useViewerStore.getState(), undefined, pinned);
    assert.deepEqual(rerun.population.map(row => [row.modelId, row.count]), [[ARCH, 1], [WALL, 0]], 'a native review rerun keeps the original capture despite a changed selection');
    assert.equal(await replaySaved(preview.artifact), 1, 'native persistence or Lens JSON export/import retains the captured engine population');
  });
}
