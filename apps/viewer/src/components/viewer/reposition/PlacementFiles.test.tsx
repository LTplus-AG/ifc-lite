/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { PlacementFiles } from './PlacementFiles';

afterEach(cleanup);
for (const parseFailure of [false, true]) it(`clears the previous import status after a failure (parse: ${parseFailure}, #4226)`, async () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), modelPlacement: emptyPlacementState() });
  const ui = render(<PlacementFiles />), input = ui.querySelector('input')!;
  async function read(text: string) {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], 'positions.json')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  await read(JSON.stringify({ version: 1, units: 'm', axes: 'engineering-z-up', frameKey: 'local-engineering:m:z-up',
    models: [{ instanceId: 'missing', sourceContentHash: 'missing-source', translation: [1, 2, 3], locked: false }] }));
  assert.ok(ui.querySelector('[role="status"]'));
  if (parseFailure) await read('{broken');
  else click([...ui.querySelectorAll('button')].find((button) => button.textContent === 'Import positions')!);
  assert.ok(ui.querySelector('[role="alert"]')); assert.equal(ui.querySelector('[role="status"]'), null);
});
