/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// P15 (#6912): bulk and IDS corrections as reviewed batches, and the validation rerun linked to their receipt.

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PropertyValueType } from '@ifc-lite/data';
import { parseIDS } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { getCorrectableRequirements } from '@/hooks/ids/idsCorrectableRequirements';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { installSampleModel, parseIfcBytes, sampleIdsXml, SAMPLE_WALLS } from '@/test/sample-corrections-fixture';
import { MODEL_CHANGE_LIMIT, type ModelChange } from './model-change';
import { previewModelChanges } from './model-change-preview';
import { commitModelChanges } from './model-change-commit';
import { decodeModelChangeReceipt } from './receipts';
import { bulkActionToModelChanges } from './bulk-changes';
import { idsCorrectionToModelChanges } from './ids-changes';
import { MODEL_CHANGE_SET_LIMIT, toConversion } from './change-conversion';
import { captureValidationBefore, verdictDelta } from './validation-verdicts';
import { rerunReceiptValidation } from './validation-rerun';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

const walls = (data: Awaited<ReturnType<typeof installSampleModel>>['data']) =>
  Object.values(SAMPLE_WALLS).map((globalId) => data.entities.getExpressIdByGlobalId(globalId));

test('a bulk action becomes one change per target with its current value expected', async () => {
  const { data } = await installSampleModel();
  const ids = walls(data);
  useViewerStore.getState().setProperty('sample', ids[0], 'Pset_Review', 'Status', 'Done', PropertyValueType.Label);
  const targets = ids.map((expressId) => ({ modelId: 'sample', expressId }));
  const set = bulkActionToModelChanges(useViewerStore.getState(), targets,
    { type: 'SET_PROPERTY', psetName: 'Pset_Review', propName: 'Status', value: 'Done', valueType: PropertyValueType.Label }, 'Status');
  assert.equal(set.unchanged, 1, 'the wall already set is not proposed');
  assert.deepEqual(set.batches[0].changes.map((c) => [c.op, c.target.globalId, c.expected]), ids.slice(1).map((id) =>
    ['property.set', data.entities.getGlobalId(id), null]));

  const deleted = bulkActionToModelChanges(useViewerStore.getState(), targets,
    { type: 'DELETE_PROPERTY', psetName: 'Pset_Review', propName: 'Status' }, 'Clear status');
  assert.deepEqual(deleted.batches[0].changes.map((c) => [c.op, c.expected]), [['property.delete', 'Done']]);
  assert.equal(deleted.unchanged, 3, 'absent values have nothing to delete');

  const real = bulkActionToModelChanges(useViewerStore.getState(), targets.slice(0, 1),
    { type: 'SET_PROPERTY', psetName: 'Pset_Review', propName: 'Load', value: 3, valueType: PropertyValueType.Real }, 'Load');
  assert.equal((real.batches[0].changes[0] as Extract<ModelChange, { op: 'property.set' }>).dataType, 'IfcReal', 'a whole Real stays Real');

  const storey = data.entityIndex.byType.get('IFCBUILDINGSTOREY')![0];
  const tag = bulkActionToModelChanges(useViewerStore.getState(), [{ modelId: 'sample', expressId: storey }],
    { type: 'SET_ATTRIBUTE', attribute: 'Tag', value: 'X' }, 'Tag');
  assert.deepEqual(tag.issues.map((issue) => issue.kind), ['unsupported-value'], 'a storey has no Tag attribute');
});

test('change sets above the batch limit split into numbered parts; oversized sets are refused', () => {
  const change = (i: number): ModelChange => ({ op: 'property.set', target: { globalId: `${String(i).padStart(22, '0')}` },
    pset: 'P', name: 'X', expected: null, value: i });
  const split = toConversion('Import', undefined, Array.from({ length: MODEL_CHANGE_LIMIT * 2 + 1 }, (_, i) => change(i)), [], 0);
  assert.deepEqual(split.batches.map((b) => [b.title, b.changes.length]),
    [['Import (part 1 of 3)', 500], ['Import (part 2 of 3)', 500], ['Import (part 3 of 3)', 1]]);
  const refused = toConversion('Import', undefined, Array.from({ length: MODEL_CHANGE_SET_LIMIT + 1 }, (_, i) => change(i)), [], 0);
  assert.deepEqual([refused.refused, refused.batches.length, refused.total], [true, 0, MODEL_CHANGE_SET_LIMIT + 1]);
});

test('an IDS correction applied by review changes the native verdict counts recorded on its receipt', async () => {
  const { data, view } = await installSampleModel();
  const state = useViewerStore.getState();
  const document = parseIDS(await sampleIdsXml());
  const stamp = captureAnalysisStamp();
  const { report, snapshot } = await runIdsCheck({ document, modelId: 'sample', dataStore: data, mutationView: view, locale: 'en', models: state.models });
  state.setIdsValidationReport(stampAnalysisReport(report, stamp), snapshot);
  const walls = report.specificationResults.find((spec) => spec.specification.name === 'Walls are external')!;
  assert.equal(walls.applicableCount, 4, 'the sample has four walls');
  const failedBefore = walls.failedCount;
  // Oracle, read from the STEP text: only the plumbing wall's Pset_WallCommon (#357) holds IsExternal .F.
  assert.equal(failedBefore, 1);
  assert.equal(walls.entityResults.find((e) => !e.passed)?.globalId, SAMPLE_WALLS.plumbing);

  const [requirement] = getCorrectableRequirements(walls, (id) => view.isDeleted(id));
  const conversion = idsCorrectionToModelChanges(useViewerStore.getState(), { modelId: 'sample', target: requirement.target,
    facetDataType: requirement.facetDataType, expressIds: requirement.failedEntities.map((e) => e.expressId), rawValue: 'true', title: 'IsExternal' });
  assert.equal(conversion.batches[0].changes.length, failedBefore);
  assert.ok(conversion.batches[0].changes.every((c) => c.op === 'property.set' && c.value === true && c.dataType === 'IfcBoolean'
    && c.expected === false), 'the stored false is expected and the IFC boolean type is kept');

  const validation = captureValidationBefore(useViewerStore.getState());
  assert.equal(validation?.beforeFreshness, 'current');
  const preview = previewModelChanges(useViewerStore.getState(), conversion.batches[0]);
  const outcome = commitModelChanges(useViewerStore, preview, new Set(preview.rows.map((row) => row.index)), 'ids:test');
  assert.ok(outcome.ok && validation);
  const rerun = await rerunReceiptValidation(useViewerStore, { ...outcome.receipt, validation });
  assert.ok(rerun.ok);
  const delta = verdictDelta(rerun.receipt.validation!);
  assert.deepEqual(delta.map((row) => [row.name, row.before?.failed, row.after?.failed, row.after?.passed]),
    [['Walls are external', failedBefore, 0, 4]]);
  assert.notEqual(useViewerStore.getState().idsValidationReport, report, 'the rerun publishes a new report');
  assert.deepEqual(decodeModelChangeReceipt(JSON.parse(JSON.stringify(rerun.receipt)))?.validation, rerun.receipt.validation,
    'the counts survive the receipt store');
  const { validation: _dropped, ...legacy } = rerun.receipt;
  assert.ok(decodeModelChangeReceipt(JSON.parse(JSON.stringify(legacy))), 'receipts written before P15 still decode');
  assert.equal(decodeModelChangeReceipt({ ...rerun.receipt, validation: { ...validation, before: 'x' } }), null);

  const reparsed = await parseIfcBytes(editedModelBytes(data, view));
  const reparsedReport = await runIdsCheck({ document, modelId: 'reparsed', dataStore: reparsed, locale: 'en', models: new Map() });
  const reparsedWalls = reparsedReport.report.specificationResults.find((spec) => spec.specification.name === 'Walls are external');
  assert.deepEqual([reparsedWalls?.passedCount, reparsedWalls?.failedCount], [4, 0], 'the exported IFC passes the corrected requirement on its own');
});

test('a rerun refuses when no report is loaded', async () => {
  await installSampleModel();
  const outcome = await rerunReceiptValidation(useViewerStore, { version: 1, id: 'r', title: 't', digest: 'd', createdAt: '', origin: 'o',
    batches: [], applied: [], skipped: [], status: 'applied',
    validation: { source: 'ids', title: 'Other', before: [], beforeFreshness: 'unknown' } });
  assert.deepEqual(outcome, { ok: false, reason: 'no-report' });
});
