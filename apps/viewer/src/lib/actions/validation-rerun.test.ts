/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Re-run validation scope and recording against receipt changes made meanwhile (#6912). */

import '@/test/setup-dom.js';
import '@/test/content-fixture';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseIDS } from '@ifc-lite/ids';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { installSampleModel, sampleIdsXml } from '@/test/sample-corrections-fixture';
import type { ModelChangeReceipt } from './model-change-commit';
import { modelChangeLibrary, useModelChangeReceipts } from './receipts';
import { captureValidationBefore, type ReceiptValidation } from './validation-verdicts';
import { recordReceiptRerun, rerunReceiptValidation } from './validation-rerun';

const original = useViewerStore.getState();
afterEach(() => useViewerStore.setState(original));

async function sampleReport(): Promise<ReceiptValidation> {
  const { data, view } = await installSampleModel();
  const state = useViewerStore.getState();
  const { report, snapshot } = await runIdsCheck({ document: parseIDS(await sampleIdsXml()), modelId: 'sample', dataStore: data,
    mutationView: view, locale: 'en', models: state.models });
  state.setIdsValidationReport(stampAnalysisReport(report, captureAnalysisStamp()), snapshot);
  const validation = captureValidationBefore(useViewerStore.getState());
  assert.ok(validation);
  return validation;
}

const receipt = (id: string, modelId: string, validation: ReceiptValidation, status: ModelChangeReceipt['status'] = 'applied'): ModelChangeReceipt => ({
  version: 1, id, title: 'Fix', digest: 'd', createdAt: new Date(0).toISOString(), origin: 'test',
  batches: [{ modelId, batchId: 'b' }], applied: [], skipped: [], status, validation,
});

test('an IDS rerun refuses when the loaded report validates a model the receipt did not change', async () => {
  const validation = await sampleReport();
  assert.deepEqual(await rerunReceiptValidation(useViewerStore, receipt('elsewhere', 'other', validation)), { ok: false, reason: 'other-model' });
  const same = await rerunReceiptValidation(useViewerStore, receipt('here', 'sample', validation));
  assert.ok(same.ok, 'the model the receipt changed reruns');
});

test('a rerun result never turns a receipt undone meanwhile back into an applied one', async () => {
  const validation = await sampleReport();
  assert.equal(await modelChangeLibrary.put('raced', receipt('raced', 'sample', validation, 'undone')), true);
  const after = { ...validation, after: validation.before, rerunAt: new Date(1).toISOString() };
  assert.equal(await recordReceiptRerun('raced', after), false);
  assert.equal(useModelChangeReceipts.getState().entries.find(entry => entry.id === 'raced')?.status, 'undone');
  assert.equal(useModelChangeReceipts.getState().entries.find(entry => entry.id === 'raced')?.validation?.after, undefined);

  assert.equal(await modelChangeLibrary.put('live', receipt('live', 'sample', validation)), true);
  assert.equal(await recordReceiptRerun('live', after), true);
  const live = useModelChangeReceipts.getState().entries.find(entry => entry.id === 'live');
  assert.deepEqual([live?.status, live?.validation?.rerunAt], ['applied', after.rerunAt]);
});
