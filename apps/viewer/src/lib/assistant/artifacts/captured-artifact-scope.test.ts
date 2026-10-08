/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { entityRefToString } from '@/store/entity-ref';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { ARCH, seedArtifactModels } from '@/test/artifact-models-fixture';
import { parseArtifactProposal, type ArtifactKind } from './proposal-kinds';
import { previewArtifact } from './artifact-preview';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';

const original = useViewerStore.getState();
const groups = [{ combinator: 'AND' as const, rules: [{ kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall', 'IfcWallStandardCase'] }] }];
beforeEach(async () => {
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
afterEach(() => useViewerStore.setState(original, true));
const cases: Array<{ kind: ArtifactKind; label: string; body: Record<string, unknown> }> = [
  { kind: 'filter.proposal', label: 'filter', body: { name: 'Captured walls', groups } },
  { kind: 'list.proposal', label: 'list', body: { list: { name: 'Captured wall names', entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  { kind: 'lens.proposal', label: 'manual lens', body: { lens: { name: 'Captured manual wall colors', rules: [{ name: 'Walls', groups, action: 'colorize', color: '#223344' }] } } },
  { kind: 'lens.proposal', label: 'auto-color lens', body: { lens: { name: 'Captured automatic colors', autoColor: { source: 'ifcType' } } } },
];
for (const entry of cases) {
  test(`#7186 selected ${entry.kind} ${entry.label} captures exactly one real federated member`, async () => {
    const state = useViewerStore.getState();
    const walls = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), groups, { limit: Infinity });
    const selected = walls.find(row => row.modelId === ARCH);
    assert.ok(selected); assert.ok(walls.length > 1, 'the actual native unscoped population is wider than this selected member');
    useViewerStore.setState({ selectedEntities: [{ modelId: ARCH, expressId: selected.expressId }], selectedEntitiesSet: new Set([entityRefToString({ modelId: ARCH, expressId: selected.expressId })]), selectedEntity: { modelId: ARCH, expressId: selected.expressId } });
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'One selected wall', kind: entry.kind, scope: 'selected', ...entry.body }), entry.kind);
    const preview = await previewArtifact(proposal, useViewerStore.getState());
    assert.equal(preview.matched, 1, 'native engine evaluates only the captured selected member');
    assert.deepEqual(preview.population.map(row => [row.modelId, row.count]), [[ARCH, 1]], 'the other loaded model cannot fall back to an unscoped population');
  });
}
