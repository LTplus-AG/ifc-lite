/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5604: a CSV import writes straight to the model's `MutablePropertyView`
 * (`CsvConnector.importAsync`), bypassing every store action. The Export
 * Changes button memoises its count on `mutationVersion` and hides at 0, so
 * unless the import bumps that version the imported edits never show up as
 * exportable (and the unexported-edits guards, which read the same count,
 * never arm). This drives the real upload -> Import flow and checks the
 * button appears.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance } from '@/test/render.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { DataConnector } from './DataConnector.js';
import { ExportChangesButton } from './ExportChangesButton.js';

const MODEL_ID = 'model-a';
const GLOBAL_ID = '2O2Fr$t4X7Zf8NOew3FLOH';

function exportChangesButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Export modified IFC'));
}

async function uploadCsv(text: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  assert.ok(input, 'the CSV file input must render in the open dialog');
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], 'data.csv', { type: 'text/csv' })] });
  act(() => {
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  // FileReader resolves on a later task.
  await advance(50);
}

describe('DataConnector — CSV import refreshes the pending-changes count (#5604)', () => {
  beforeEach(() => {
    useViewerStore.setState({
      ...fixtureModels(fixtureModel(MODEL_ID, {
        entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A', globalId: GLOBAL_ID }],
      })),
      // The model's overlay exists already, as it does once its properties
      // have been viewed; the connector binds to it when it mounts.
      mutationViews: new Map([[MODEL_ID, new MutablePropertyView(null, MODEL_ID)]]),
      mutationVersion: 0,
      georefMutations: new Map(),
      scheduleData: null,
      scheduleIsEdited: false,
      scheduleSourceModelId: null,
      collabRole: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the Export modified IFC button once a CSV import has written a property', async () => {
    const container = render(
      <>
        <ExportChangesButton />
        <DataConnector trigger={<button>Open</button>} />
      </>,
    );
    assert.equal(exportChangesButton(container), undefined, 'no pending changes before the import');

    const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Open');
    assert.ok(trigger);
    click(trigger);
    await advance(0);

    await uploadCsv(`GlobalId,FireRating\n${GLOBAL_ID},REI60\n`);

    const importBtn = [...document.body.querySelectorAll('button')].find((b) => {
      const text = b.textContent?.trim() ?? '';
      return text === 'Import' || /^Import \d+ rows?$/.test(text);
    });
    assert.ok(importBtn, 'the Import button must render');
    assert.equal(importBtn.disabled, false, 'the uploaded CSV and its auto-detected mapping enable Import');
    click(importBtn);
    await advance(100);

    const view = useViewerStore.getState().mutationViews.get(MODEL_ID);
    assert.equal(view?.getModifiedEntityCount(), 1, 'fixture sanity: the import wrote one entity to the overlay');
    const button = exportChangesButton(container);
    assert.ok(button, 'the Export modified IFC button must appear after the CSV import');
    assert.match(button.textContent ?? '', /1/, 'and count the imported change');
  });
});
