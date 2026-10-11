/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { extractClassificationsOnDemand } from '@ifc-lite/parser';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { BACK_WALL, BACK_WALL_NAME, SAMPLE_MODEL, parseIfc, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { parseModelAuthoringBatch } from '@/lib/actions/model-authoring';
import { modelChangeLibrary } from '@/lib/actions/receipts';
import { ModelAuthoringReview } from './ModelAuthoringReview';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); });

test('#7271 mounted classification review discloses metadata-only effect and waits for explicit Apply', async () => {
  await modelChangeLibrary.initialize();
  const { dataStore, view } = await seedAuthoringSample();
  const target = dataStore.entities.getExpressIdByGlobalId(BACK_WALL)!;
  const before = editedModelBytes(dataStore, view);
  const batch = parseModelAuthoringBatch(JSON.stringify({ version: 1, kind: 'model.authoring', title: 'Explicit classification',
    units: 'm', frame: 'storey-local', operations: [{ op: 'classification.add',
      target: { globalId: BACK_WALL, modelId: SAMPLE_MODEL, ifcClass: 'IfcWall', name: BACK_WALL_NAME },
      Classification: { Name: 'User supplied system' }, Reference: { Identification: 'USER-001', Name: 'Explicit label' } }] }));
  const ui = render(<ModelAuthoringReview batch={batch} origin="test" />);
  const apply = () => [...ui.querySelectorAll('button')].find(button => button.textContent?.startsWith('Apply'))!;
  const checkbox = ui.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.match(ui.textContent ?? '', /Existing classifications retained/);
  assert.match(ui.textContent ?? '', /User supplied system · USER-001 · Explicit label/);
  assert.match(ui.textContent ?? '', /no geometric preview/);
  assert.deepEqual(editedModelBytes(dataStore, view), before, 'mounting does not author classifications');
  click(checkbox);
  assert.equal(apply().disabled, true, 'unapproved metadata cannot be applied');
  click(checkbox);
  assert.equal(apply().disabled, false);
  click(apply());
  assert.match(ui.textContent ?? '', /Applied 1 change/);
  const parsed = await parseIfc(editedModelBytes(dataStore, view));
  assert.deepEqual(extractClassificationsOnDemand(parsed, target).map(row => [row.system, row.identification, row.name]),
    [['User supplied system', 'USER-001', 'Explicit label']]);
  assert.equal(parsed.entities.getGlobalId(target), BACK_WALL);
});
