/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { configureMutationView } from '@/utils/configureMutationView';
import { CLASSIFICATION_SYSTEM_ID, DECLARED_SYSTEM_FIXTURE, UNNAMED_SYSTEM_FIXTURE, installClassificationModels, namedClassificationModel, realClassificationModel, selectorProposal } from '@/test/classification-selector-fixture';
import { effectiveClassificationSystems } from '@/components/viewer/properties/effective-classification-systems';
import { parseArtifactProposal } from './proposal-kinds';
import { isPreviewCurrent, previewArtifact } from './artifact-preview';
import { fieldSites } from './field-refs';
import { resolveFields } from './field-candidates';
import { modelSchemaIndex } from './model-schema';

const pristine = useViewerStore.getState();
afterEach(() => useViewerStore.setState(pristine, true));
const groups = (system?: string, op = 'isNotSet') => [{ combinator: 'AND', rules: [
  { kind: 'ifcType', op: 'in', values: ['IfcWall'] }, { kind: 'classification', ...(system !== undefined ? { system } : {}), op, value: '' },
] }];

for (const kind of ['filter.proposal', 'list.proposal', 'lens.proposal', 'chart.proposal'] as const) {
  test(`#7130 ${kind} refuses an invented explicit system rather than broadening its missing-classification population`, async () => {
    installClassificationModels(await namedClassificationModel());
    await assert.rejects(previewArtifact(selectorProposal(kind, 'InventedSystem7130'), useViewerStore.getState()), /classification system.*unresolved|unresolved.*classification system/i);
  });
}

test('#7130 real CYPE export retains native known-Uniformat absence results and rejects an invented selector', { skip: !existsSync(DECLARED_SYSTEM_FIXTURE) && 'Run pnpm fixtures to fetch ara3d/tested_sample_project.ifc' }, async () => {
  const store = await realClassificationModel(DECLARED_SYSTEM_FIXTURE);
  assert.ok(effectiveClassificationSystems(store, null).names.includes('Uniformat'));
  installClassificationModels(store);
  const known = selectorProposal('filter.proposal', 'Uniformat');
  assert.equal(known.kind, 'filter.proposal');
  if (known.kind !== 'filter.proposal') throw new Error('Expected filter');
  const direct = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), known.groups, { limit: Infinity });
  assert.ok(direct.length > 0, 'real authoring model must exercise absence over actual walls');
  assert.equal((await previewArtifact(known, useViewerStore.getState())).matched, direct.length);
  await assert.rejects(previewArtifact(selectorProposal('filter.proposal', 'UniformatInvented7130'), useViewerStore.getState()), /classification system.*unresolved|unresolved.*classification system/i);
});

test('#7130 real unnamed Archicad classifications preserve native any-system behavior', { skip: !existsSync(UNNAMED_SYSTEM_FIXTURE) && 'Run pnpm fixtures to fetch ara3d/AC20-FZK-Haus.ifc' }, async () => {
  installClassificationModels(await realClassificationModel(UNNAMED_SYSTEM_FIXTURE));
  for (const system of [undefined, '', '   ']) {
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, kind: 'filter.proposal', title: 'Any system', groups: groups(system, 'isSet') }), 'filter.proposal');
    if (proposal.kind !== 'filter.proposal') throw new Error('Expected filter');
    const expected = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), proposal.groups, { limit: Infinity });
    assert.equal((await previewArtifact(proposal, useViewerStore.getState())).matched, expected.length);
    assert.equal(fieldSites(proposal).length, 0, 'native any-system means no invented named selector');
  }
});

test('#7130 exact classification systems resolve per federation; case aliases remain explicit user picks', async () => {
  installClassificationModels(await namedClassificationModel(), await namedClassificationModel('OmniClass'));
  const index = await modelSchemaIndex(useViewerStore.getState());
  const [known] = resolveFields(fieldSites(selectorProposal('filter.proposal', 'Uniclass 2015')), index);
  assert.equal(known?.status, 'exact');
  const [alias] = resolveFields(fieldSites(selectorProposal('filter.proposal', 'uniclass2015')), index);
  assert.equal(alias?.status, 'unresolved');
  if (alias?.status !== 'unresolved') throw new Error('Alias must be a user pick');
  assert.equal(alias.candidates[0]?.name, 'Uniclass 2015');
  assert.equal(alias.candidates[0]?.byModel.size, 1, 'classification inventories retain their real model source');
});

test('#7130 known named associations preserve native counts, including classified refs with absent code/name', async () => {
  installClassificationModels(await namedClassificationModel());
  const state = useViewerStore.getState();
  const known = selectorProposal('filter.proposal', 'Uniclass 2015');
  if (known.kind !== 'filter.proposal') throw new Error('Expected filter');
  const expected = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), known.groups, { limit: Infinity });
  assert.equal(expected.length, 2, 'two of the four actual source walls are genuinely unclassified');
  for (const kind of ['filter.proposal', 'list.proposal', 'lens.proposal', 'chart.proposal'] as const) {
    assert.equal((await previewArtifact(selectorProposal(kind, 'Uniclass 2015'), state)).matched, expected.length, kind);
  }
});

test('#7130 named auto-colour and chart classification dimensions wait for actual discovered systems', async () => {
  installClassificationModels(await namedClassificationModel());
  const lens = parseArtifactProposal(JSON.stringify({ version: 1, kind: 'lens.proposal', title: 'T', lens: { name: 'L', autoColor: { source: 'classification', psetName: 'Unknown7130' } } }), 'lens.proposal');
  const chart = parseArtifactProposal(JSON.stringify({ version: 1, kind: 'chart.proposal', title: 'T', chart: { type: 'bar', elementField: { kind: 'classification', system: 'Unknown7130' }, measure: { agg: 'count' } } }), 'chart.proposal');
  for (const proposal of [lens, chart]) {
    assert.equal(fieldSites(proposal)[0]?.kind, 'classification');
    await assert.rejects(previewArtifact(proposal, useViewerStore.getState()), /classification system.*unresolved/i);
  }
});

test('#7130 model reload cannot reuse an older classification catalog or save authority', async () => {
  installClassificationModels(await namedClassificationModel());
  const proposal = selectorProposal('filter.proposal', 'Uniclass 2015');
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  const previous = await modelSchemaIndex(useViewerStore.getState());
  installClassificationModels(await namedClassificationModel('OmniClass'));
  assert.equal(isPreviewCurrent(preview, useViewerStore.getState()), false);
  assert.notEqual(await modelSchemaIndex(useViewerStore.getState()), previous);
  await assert.rejects(previewArtifact(proposal, useViewerStore.getState()), /classification system.*unresolved/i);
});

test('#7131 native system edits refresh proposal grounding and undo restores the source population', async () => {
  installClassificationModels(await namedClassificationModel());
  const state = useViewerStore.getState();
  const id = [...state.models.keys()][0];
  const store = state.models.get(id)!.ifcDataStore!;
  const view = new MutablePropertyView(store.properties, id);
  configureMutationView(view, store);
  view.setExpressIdWatermark(state.models.get(id)!.maxExpressId);
  state.registerMutationView(id, view);
  useViewerStore.setState({ editEnabled: true, collabRole: null });
  const proposal = selectorProposal('filter.proposal', 'Uniclass 2015');
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(state.setAttribute(id, CLASSIFICATION_SYSTEM_ID, 'Name', 'Renamed7130'));
  assert.equal(isPreviewCurrent(preview, useViewerStore.getState()), false);
  await assert.rejects(previewArtifact(proposal, useViewerStore.getState()), /classification system.*unresolved/i);
  assert.equal((await previewArtifact(selectorProposal('filter.proposal', 'Renamed7130'), useViewerStore.getState())).matched, preview.matched, 'the current effective system retains its native missing-classification population');
  useViewerStore.getState().undo(id);
  assert.equal((await previewArtifact(proposal, useViewerStore.getState())).matched, preview.matched, 'undo removing the live attribute overlay restores native source results despite append-only history');
});

test('#7130 classification list columns cannot claim a system that native columns do not support', async () => {
  installClassificationModels(await namedClassificationModel());
  const payload = (psetName?: string) => JSON.stringify({ version: 1, kind: 'list.proposal', title: 'Classification column', list: {
    name: 'Classification column', entityTypes: ['IfcWall'], columns: [{ id: 'classification', source: 'classification', ...(psetName !== undefined ? { psetName } : {}) }],
  } });
  for (const system of ['InventedSystem7130', 'Uniclass 2015', '']) {
    assert.throws(() => parseArtifactProposal(payload(system), 'list.proposal'), /classification column takes no psetName/, 'even a known system is outside the native column contract');
  }
  const preview = await previewArtifact(parseArtifactProposal(payload(), 'list.proposal'), useViewerStore.getState());
  assert.equal(preview.matched, 4, 'an intentional any-system classification column retains all native wall rows');
});

test('#7131 source-empty live classification edits explicitly refuse an unavailable population', async () => {
  installClassificationModels(await namedClassificationModel());
  const state = useViewerStore.getState();
  const id = [...state.models.keys()][0];
  const model = state.models.get(id)!;
  const store = { ...model.ifcDataStore!, source: new Uint8Array() };
  useViewerStore.setState({ models: new Map([[id, { ...model, ifcDataStore: store }]]) });
  const view = new MutablePropertyView(store.properties, id);
  configureMutationView(view, store);
  view.setExpressIdWatermark(model.maxExpressId);
  useViewerStore.getState().registerMutationView(id, view);
  view.setAttribute(CLASSIFICATION_SYSTEM_ID, 'Name', 'Unavailable rename 7131');
  for (const kind of ['filter.proposal', 'list.proposal', 'lens.proposal', 'chart.proposal'] as const) {
    await assert.rejects(previewArtifact(selectorProposal(kind, 'Uniclass 2015'), useViewerStore.getState()), /no source bytes.*live classification edits/i);
  }
});
