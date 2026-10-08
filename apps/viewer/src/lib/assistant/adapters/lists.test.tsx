/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lists evidence (#6833): the stored `listResult` of a real list run over the
 * committed sample, cited with its executed definition, source units, native
 * totals and run stamp.
 */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { IfcTypeEnum } from '@ifc-lite/data';
import type { ListDefinition } from '@ifc-lite/lists';
import { render, click, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useViewerStore, type FederatedModel } from '@/store';
import { analysisStampOf, captureAnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { carryListRun, recordListRun } from '@/lib/lists/run-provenance';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { cancelAssistant, useAssistant } from '../conversation';

const SAMPLE = new URL('../../../../public/samples/building-architecture.ifc', import.meta.url);
const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

async function parse(patch: (text: string) => string = text => text): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(patch(await readFile(SAMPLE, 'utf8')));
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
}

const model = (id: string, store: IfcDataStore, idOffset = 0): FederatedModel =>
  ({ ...fixtureModel(id, { idOffset }), ifcDataStore: store, maxExpressId: 100_000 });

const WALLS: ListDefinition = {
  id: 'walls-6833', name: 'Walls 6833', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall], groups: [],
  columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' },
    { id: 'len', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'Length' },
    { id: 'vol', source: 'quantity', psetName: 'Qto_WallBaseQuantities', propertyName: 'NetVolume' },
  ],
  grouping: { columnId: 'name', sumColumnIds: ['len', 'vol'] },
};

/** The same run the panel performs, stored the way the panel stores it. */
async function runAndStore(definition: ListDefinition): Promise<void> {
  const state = useViewerStore.getState();
  const stamp = captureAnalysisStamp();
  const { pairs } = prepareListProviders(state, {});
  const result = await runListFederated(definition, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) });
  useViewerStore.getState().setListResult(recordListRun(result, definition, stamp));
}

const payloadOf = (source = captureEvidence('lists')) => ({ snapshot: source, payload: JSON.parse(source.payload) });

test('#6833 lists: no run is unavailable, never an empty list', () => {
  useViewerStore.setState(fixtureModels(fixtureModel('m')));
  const { snapshot, payload } = payloadOf();
  assert.equal(payload.sourceAvailability, 'unavailable');
  assert.equal(snapshot.totalRows, 0);
});

test('#6833 lists: the Lists panel run is stamped, cited with units and native totals, and stale after an edit', async () => {
  const store = await parse();
  useViewerStore.setState({ ...fixtureModels(model('arch', store)), listDefinitions: [WALLS] });
  const ui = render(renderPanelBody('lists', () => undefined));
  const run = ui.querySelector(`button[aria-label="Run list ${WALLS.name}"]`);
  assert.ok(run, 'the library offers the saved list');
  click(run);
  await waitFor(() => useViewerStore.getState().listResult !== null, 'the panel stores its list result');
  const result = useViewerStore.getState().listResult;
  assert.ok(result);
  assert.ok(analysisStampOf(result), 'the panel stamps the run');

  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button);
  click(button);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'lists');
  assert.ok(snapshot);
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, 4, 'the sample has four walls');
  assert.equal(payload.evidence.summary.totalCount, 4);
  assert.equal(payload.evidence.summary.definitionName, WALLS.name);
  const length = payload.evidence.summary.columns.find((column: { id: string }) => column.id === 'len');
  assert.equal(length.unit, 'mm', 'the sample declares millimetres');
  assert.equal(length.quantityKind, 'Length');
  assert.equal(payload.evidence.summary.columns.find((column: { id: string }) => column.id === 'vol').unit, 'm³');
  assert.equal(payload.evidence.summary.nativeSummary.count, 4);
  assert.ok(Math.abs(payload.evidence.summary.nativeSummary.sums.len - 15_800) < 1e-6, 'native sum of wall lengths');
  assert.equal(payload.evidence.summary.groupCount, 4);
  const row = payload.evidence.rows[0].data;
  assert.equal(row.kind, 'list-row');
  assert.equal(row.modelId, 'arch');
  assert.equal(typeof row.expressId, 'number');
  assert.equal(row.globalId, store.entities.getGlobalId(row.expressId));
  assert.equal(typeof row.values.len, 'number');
  assert.equal(evidenceIsCurrent(snapshot), true);

  cleanup();
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(snapshot), false, 'an edit makes the cited list stale');
  // A result that predates the edit stays stale even when captured afterwards.
  assert.equal(evidenceIsCurrent(captureEvidence('lists')), false);
});

test('#6833 lists: federated runs keep model ids, exact totals over a bounded sample, and withhold mixed-unit sums', async () => {
  const millimetres = await parse();
  const metres = await parse(text => text.replace('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)'));
  const models = [model('mm', millimetres), ...Array.from({ length: 30 }, (_, i) => model(`m${i}`, metres, (i + 1) * 100_000))];
  useViewerStore.setState(fixtureModels(...models));
  await runAndStore(WALLS);
  const { snapshot, payload } = payloadOf();
  assert.equal(snapshot.totalRows, 124, '4 walls in each of 31 models');
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.modelCount, 31);
  const length = payload.evidence.summary.columns.find((column: { id: string }) => column.id === 'len');
  assert.equal(length.mixedSourceUnits, true);
  assert.equal(length.unit, null, 'no single unit across mm and m models');
  assert.equal(length.unitsByModel.mm, 'mm');
  assert.equal(length.unitsByModel.m0, 'm');
  assert.equal(payload.evidence.summary.nativeSummary.sums.len, null, 'a sum across units is withheld');
  assert.deepEqual(payload.evidence.summary.sumsWithheldForMixedUnits, ['len']);
  assert.equal(typeof payload.evidence.summary.nativeSummary.sums.vol, 'number', 'volume is m³ in every model');
  assert.ok(new Set(payload.evidence.rows.map((row: { data: { modelId: string } }) => row.data.modelId)).size > 1);
  assert.ok(snapshot.payload.length <= 48_000);
});

test('#6833 lists: replacing the result changes identity; a regrouped result keeps the original run stamp', async () => {
  useViewerStore.setState(fixtureModels(model('arch', await parse())));
  await runAndStore(WALLS);
  const snapshot = captureEvidence('lists');
  assert.equal(evidenceIsCurrent(snapshot), true);
  const current = useViewerStore.getState().listResult;
  assert.ok(current);
  const regrouped = carryListRun(current, { ...current, groups: undefined, summary: undefined }, { ...WALLS, grouping: undefined });
  useViewerStore.getState().setListResult(regrouped);
  assert.equal(evidenceIsCurrent(snapshot), false, 'a replaced result is not the cited one');
  assert.equal(analysisStampOf(regrouped), analysisStampOf(current));
  assert.equal(JSON.parse(captureEvidence('lists').payload).evidence.summary.nativeSummary, null);
});
