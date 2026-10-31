/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8341: the Load report tells the user when a load left type geometry out
 * because type records could not be read, and stays silent for 0 or an
 * unknown count. The count arrives on `FederatedModel.omittedTypeRecords`.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store/index.js';
import { LoadReportPanel } from './LoadReportPanel.js';

const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState);
});

function mount(omittedTypeRecords: number | undefined): HTMLElement {
  const model = {
    ...fixtureModel('m'),
    name: 'haus.ifc',
    schemaVersion: 'IFC4',
    loadedAt: 1_700_000_000_000,
    fileSize: 1_000,
    loadFormat: 'ifc',
    loadPath: 'wasm',
    ...(omittedTypeRecords === undefined ? {} : { omittedTypeRecords }),
  } as FederatedModel;
  useViewerStore.setState({ ...fixtureModels(model) });
  return render(<LoadReportPanel />);
}

describe('LoadReportPanel omitted type records (#8341)', () => {
  it('states the count in plain language and marks the load as having an issue', () => {
    const text = mount(3).textContent ?? '';
    assert.match(text, /3 type definitions could not be read, so their type geometry was left out\./);
    assert.match(text, /Issues found/);
    assert.doesNotMatch(text, /Diagnostics unavailable/);
  });

  it('uses the singular for one record', () => {
    assert.match(mount(1).textContent ?? '', /1 type definition could not be read, so its type geometry was left out\./);
  });

  it('shows nothing for 0, and nothing for an unknown count', () => {
    for (const count of [0, undefined]) {
      const text = mount(count).textContent ?? '';
      assert.doesNotMatch(text, /type definition/);
      assert.match(text, /Diagnostics unavailable/);
      cleanup();
    }
  });
});
