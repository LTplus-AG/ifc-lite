/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateIDS, type IDSDocument } from '@ifc-lite/ids';
import { runRuleSet } from '@ifc-lite/rules';
import { useViewerStore, type FederatedModel } from '@/store';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { SAMPLE_MODEL, seedAuthoringSample, parseIfc } from '@/test/authoring-sample-fixture';
import { SAMPLE_IDS_PROPOSAL, SAMPLE_RULES_PROPOSAL, json } from '@/test/check-authoring-fixture';
import { fixtureModel } from '@/test/store-fixture';
import { buildIdsDraft, parseIdsProposal } from './ids-proposal';
import { parseRulesProposal } from './rules-proposal';
import { dryRunIds, dryRunRules, isDryRunCurrent } from './dry-run';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

async function directCounts(document: IDSDocument, modelId: string) {
  const state = useViewerStore.getState();
  const store = state.models.get(modelId)!.ifcDataStore!;
  const report = await validateIDS(document, createDataAccessor(store, modelId, state.getMutationView(modelId)),
    { modelId, schemaVersion: 'IFC4', entityCount: store.entityCount });
  return report.specificationResults.map(result => ({ applicable: result.applicableCount, passed: result.passedCount, failed: result.failedCount }));
}
const runCounts = (checks: Array<{ applicable: number; passed: number; failed: number }>) =>
  checks.map(({ applicable, passed, failed }) => ({ applicable, passed, failed }));

// #6915: dry-run counts are the native validator's own, on one model and summed over a federation.
test('IDS dry-run counts equal the native validator on the committed sample, at 1 and N models', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const draft = buildIdsDraft(parseIdsProposal(json(SAMPLE_IDS_PROPOSAL)));
  const direct = await directCounts(draft.document, SAMPLE_MODEL);
  const run = await dryRunIds(draft.document);
  assert.deepEqual(runCounts(run.checks), direct);
  assert.deepEqual(run.checkedModels, [SAMPLE_MODEL]);
  assert.ok(direct.some(count => count.failed > 0) && direct.some(count => count.applicable > 0), 'the sample has applicable and failing elements');
  const failing = run.checks.find(check => check.failures.length > 0)!;
  assert.ok(failing.failures.every(failure => failure.modelId === SAMPLE_MODEL && failure.expressId > 0));
  assert.ok(failing.failures.length <= Math.min(5, failing.failed));
  assert.ok(failing.failures.every(failure => failure.reason), 'each sample says which requirement failed');
  assert.equal(useViewerStore.getState().idsValidationReport, null, 'a dry run publishes no report');

  const state = useViewerStore.getState();
  const second = { ...fixtureModel('copy', { idOffset: 1_000_000 }), ifcDataStore: state.models.get(SAMPLE_MODEL)!.ifcDataStore } as FederatedModel;
  useViewerStore.setState({ models: new Map([...state.models, ['copy', second]]) });
  const federated = await dryRunIds(draft.document);
  assert.deepEqual(federated.checkedModels, [SAMPLE_MODEL, 'copy']);
  assert.deepEqual(runCounts(federated.checks), direct.map(count => ({ applicable: count.applicable * 2, passed: count.passed * 2, failed: count.failed * 2 })));
});

test('a dry run authorises saving only for the same draft on unchanged models', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const draft = buildIdsDraft(parseIdsProposal(json(SAMPLE_IDS_PROPOSAL)));
  const run = await dryRunIds(draft.document);
  assert.equal(isDryRunCurrent(run, draft.document), true);
  const edited = { ...draft.document, specifications: draft.document.specifications.map((spec, i) => i === 0 ? { ...spec, name: 'Renamed' } : spec) };
  assert.equal(isDryRunCurrent(run, edited), false, 'an edit needs a new dry run');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(isDryRunCurrent(run, draft.document), false, 'a model edit needs a new dry run');
});

test('a specification nothing applies to is reported as an empty population', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const draft = buildIdsDraft(parseIdsProposal(json({ ...SAMPLE_IDS_PROPOSAL, specifications: [{ name: 'Ramps', cardinality: 'optional',
    applicability: [{ type: 'entity', name: 'IFCRAMP' }], requirements: [{ type: 'attribute', name: 'Name' }] }] })));
  const [check] = (await dryRunIds(draft.document)).checks;
  assert.deepEqual(runCounts([check]), [{ applicable: 0, passed: 0, failed: 0 }]);
});

test('rules dry-run counts equal the native rule engine run directly', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const proposal = parseRulesProposal(json(SAMPLE_RULES_PROPOSAL));
  const run = await dryRunRules(proposal.ruleSet);
  const report = await runRuleSet({ ruleSet: proposal.ruleSet, models: evaluatorModelsFromState(useViewerStore.getState()) });
  assert.deepEqual(runCounts(run.checks), report.specificationResults.map(r => ({ applicable: r.applicableCount, passed: r.passedCount, failed: r.failedCount })));
  assert.equal(run.checks[1].failedSets, (report.specificationResults[1].setResults ?? []).filter(set => !set.passed).length);
  assert.ok(run.checks[0].applicable > 0);
});

// Real ArchiCAD export (#6813 oracle model): a drafted check is counted exactly as the native engine counts it.
test('IDS dry run on AC20-FZK-Haus equals the native validator', async context => {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  let bytes: Buffer;
  try { bytes = await readFile(resolve(process.cwd(), '../../tests/models/ara3d/AC20-FZK-Haus.ifc')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { context.skip('Run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const store = await parseIfc(Uint8Array.from(bytes));
  useViewerStore.setState({ models: new Map([['archicad', { ...fixtureModel('archicad'), ifcDataStore: store } as FederatedModel]]), activeModelId: 'archicad' });
  const draft = buildIdsDraft(parseIdsProposal(json({ version: 1, kind: 'ids.specifications', title: 'AC20 walls', specifications: [
    { name: 'External walls are flagged', applicability: [{ type: 'entity', name: 'IFCWALLSTANDARDCASE' }],
      requirements: [{ type: 'property', propertySet: 'Pset_WallCommon', baseName: 'IsExternal', dataType: 'IFCBOOLEAN', value: true }] },
    { name: 'Slabs are at least 200 mm thick', applicability: [{ type: 'entity', name: 'IFCSLAB' }],
      requirements: [{ type: 'property', propertySet: 'Qto_SlabBaseQuantities', baseName: 'Width', dataType: 'IFCLENGTHMEASURE', unit: 'mm', value: { type: 'bounds', minInclusive: 200 } }] },
  ] })));
  const run = await dryRunIds(draft.document);
  assert.deepEqual(runCounts(run.checks), await directCounts(draft.document, 'archicad'));
  assert.ok(run.checks[0].applicable > 0 && run.checks[1].applicable > 0, 'both checks select real ArchiCAD elements');
});
