/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// P15 (#6912): an IDS correction reviewed, applied and re-validated from its receipt, on the committed SketchUp sample.

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseIDS } from '@ifc-lite/ids';
import { render, click, cleanup, advance } from '@/test/render';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { getCorrectableRequirements } from '@/hooks/ids/idsCorrectableRequirements';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { idsCorrectionToModelChanges } from '@/lib/actions/ids-changes';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { installSampleModel, sampleIdsXml } from '@/test/sample-corrections-fixture';
import { proposalOf } from '../assistant/AssistantConversation';
import { ChangeReviewDialog } from './ChangeReviewDialog';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await advance(10);
  assert.ok(check());
}

test('Re-run validation on the receipt shows the specification whose verdict counts the correction changed', async () => {
  await modelChangeLibrary.initialize();
  const { data, view } = await installSampleModel();
  const ids = parseIDS(await sampleIdsXml());
  const stamp = captureAnalysisStamp();
  const { report, snapshot } = await runIdsCheck({ document: ids, modelId: 'sample', dataStore: data, mutationView: view, locale: 'en',
    models: useViewerStore.getState().models });
  useViewerStore.getState().setIdsValidationReport(stampAnalysisReport(report, stamp), snapshot);
  const spec = report.specificationResults.find((result) => result.specification.name === 'Walls are external')!;
  const [requirement] = getCorrectableRequirements(spec);
  const conversion = idsCorrectionToModelChanges(useViewerStore.getState(), { modelId: 'sample', target: requirement.target,
    facetDataType: requirement.facetDataType, expressIds: requirement.failedEntities.map((e) => e.expressId), rawValue: 'yes', title: 'IsExternal' });

  render(<ChangeReviewDialog conversion={conversion} origin="ids:test" onClose={() => {}} />);
  const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  click(button('Apply 1 change')!);
  await waitFor(() => useModelChangeReceipts.getState().entries.length === 1);
  const dialog = document.body.querySelector('[role="dialog"]')!;
  // Totals span all three sample specifications; only the wall requirement is corrected here.
  assert.match(dialog.textContent ?? '', /Building Architecture IDS: 3 failed, 8 passed before applying/);

  click(button('Re-run validation')!);
  await waitFor(() => !!useModelChangeReceipts.getState().entries[0].validation?.after);
  assert.match(dialog.textContent ?? '', /Walls are external: failed 1 → 0, passed 3 → 4/);
  assert.match(dialog.textContent ?? '', /After re-run: 2 failed, 9 passed/);
  await waitFor(() => button('Re-run validation')?.disabled === false);
});

test('an assistant table.mapping answer is a typed proposal that points to the table it needs', () => {
  const mapping = { version: 1, kind: 'table.mapping', title: 'Widths', identity: { column: 'Guid', key: 'Tag' },
    columns: [{ column: 'W', target: 'quantity', qset: 'Qto_WallBaseQuantities', name: 'Width', unit: 'mm' }] };
  assert.deepEqual(proposalOf(JSON.stringify(mapping)), { kind: 'mapping', columns: 1, key: 'Tag' });
  assert.equal(proposalOf(JSON.stringify({ ...mapping, columns: [] }))?.kind, 'invalid');
});
