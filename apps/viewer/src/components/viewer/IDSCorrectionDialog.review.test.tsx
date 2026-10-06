/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// P15 (#6912): the IDS correction dialog's primary action reviews the correction instead of writing it.

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { parseIDS } from '@ifc-lite/ids';
import { cleanup, click, render, type, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { installSampleModel, sampleIdsXml, SAMPLE_WALLS } from '@/test/sample-corrections-fixture';
import { IDSCorrectionDialog } from './IDSCorrectionDialog.js';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original); });

test('Review as changes shows the typed correction with the stored value expected and writes only on apply', async () => {
  await modelChangeLibrary.initialize();
  const { data, view } = await installSampleModel();
  const { report } = await runIdsCheck({ document: parseIDS(await sampleIdsXml()), modelId: 'sample', dataStore: data, mutationView: view,
    locale: 'en', models: useViewerStore.getState().models });
  const spec = report.specificationResults.find((result) => result.specification.name === 'Walls are external')!;
  let revalidated = 0;
  render(<IDSCorrectionDialog open onOpenChange={() => {}} specResult={spec} modelId="sample" onRevalidate={async () => { revalidated++; }} />);
  type(document.body.querySelector<HTMLInputElement>('input[placeholder]')!, 'true');
  const button = (text: string) => [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  click(button('Review as changes')!);
  await advance(0);
  const review = [...document.body.querySelectorAll('[role="dialog"]')].at(-1)!;
  assert.match(review.textContent ?? '', /plumbing wall/);
  assert.match(review.textContent ?? '', /Pset_WallCommon\.IsExternal/);
  const plumbing = data.entities.getExpressIdByGlobalId(SAMPLE_WALLS.plumbing);
  assert.equal(view.getPropertyValue(plumbing, 'Pset_WallCommon', 'IsExternal'), false, 'reviewing wrote nothing');

  click(button('Apply 1 change')!);
  for (let i = 0; i < 100 && useModelChangeReceipts.getState().entries.length === 0; i++) await advance(10);
  assert.equal(view.getPropertyValue(plumbing, 'Pset_WallCommon', 'IsExternal'), true);
  assert.equal(revalidated, 0, 'validation reruns from the receipt, on request');
});
