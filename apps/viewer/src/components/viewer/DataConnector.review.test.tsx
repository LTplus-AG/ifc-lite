/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * P15 (#6912): the Data Connector's primary action reviews a CSV as model
 * changes instead of writing it. Drives the real upload → Review as changes →
 * Apply flow on the committed SketchUp sample, and the AI "Suggest mapping"
 * card through a stubbed provider stream.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { installSampleModel, SAMPLE_WALLS } from '@/test/sample-corrections-fixture';
import { modelChangeLibrary, useModelChangeReceipts } from '@/lib/actions/receipts';
import { DataConnector } from './DataConnector.js';

const original = useViewerStore.getState();
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; useViewerStore.setState(original); });

const buttons = () => [...document.body.querySelectorAll('button')];
const byText = (text: string | RegExp) => buttons().find((b) => typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''));

async function openWithCsv(text: string) {
  const container = render(<DataConnector trigger={<button>Open</button>} />);
  click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Open')!);
  await advance(0);
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], 'walls.csv', { type: 'text/csv' })] });
  act(() => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await advance(50);
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await advance(10);
  assert.ok(check());
}

describe('DataConnector — Review as changes (#6912)', () => {
  it('reviews the CSV with expected values, applies it as one undo step and records a receipt', async () => {
    await modelChangeLibrary.initialize();
    const { data, view } = await installSampleModel();
    const back = data.entities.getExpressIdByGlobalId(SAMPLE_WALLS.rightBack);
    await openWithCsv(`GlobalId,FireRating\n${SAMPLE_WALLS.rightFront},EI60\n${SAMPLE_WALLS.rightBack},EI90\n2Missing0000000000000x,EI30\n`);

    const review = byText('Review as changes');
    assert.ok(review && !review.disabled, 'review is the primary, enabled action once a key column and mapping exist');
    assert.ok(byText(/^Import/), 'the direct import stays available as the secondary action');
    click(review!);
    await advance(0);
    const dialog = [...document.body.querySelectorAll('[role="dialog"]')].at(-1)!;
    assert.match(dialog.textContent ?? '', /2 changes in 1 part\(s\) · 0 already set · 1 skipped/);
    assert.equal(view.getPropertyValue(back, 'Pset_WallCommon', 'FireRating'), null, 'opening the review wrote nothing');

    click(byText('Apply 2 changes')!);
    await waitFor(() => useModelChangeReceipts.getState().entries.length === 1);
    const pset = useModelChangeReceipts.getState().entries[0].applied[0].field.split('.')[0];
    assert.equal(view.getPropertyValue(back, pset, 'FireRating'), 'EI90');
    assert.match(dialog.textContent ?? '', /Applied 2 changes as one undo step/);
    useViewerStore.getState().undo('sample');
    assert.equal(view.getPropertyValue(back, pset, 'FireRating'), null, 'one undo reverts the reviewed import');
  });

  it('Suggest mapping shows an editable card whose sample converts the first rows before review', async () => {
    await installSampleModel();
    useViewerStore.setState({ chatActiveModel: 'openai/gpt-free' });
    const draft = { version: 1, kind: 'table.mapping', title: 'Widths', identity: { column: 'Guid', key: 'GlobalId' },
      columns: [{ column: 'Breite (m)', target: 'quantity', qset: 'Qto_WallBaseQuantities', name: 'Width', unit: 'm' }] };
    globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(draft) }, finish_reason: 'stop' }] })}\n\n`);
    await openWithCsv(`Guid,Breite (m)\n${SAMPLE_WALLS.left},0.3\n`);
    click(byText('Suggest mapping')!);
    await waitFor(() => !!document.body.querySelector('section[aria-label="Suggested table mapping"]'));
    const card = document.body.querySelector('section[aria-label="Suggested table mapping"]')!;
    assert.match(card.textContent ?? '', new RegExp(`${SAMPLE_WALLS.left} · Qto_WallBaseQuantities.Width: 200\\.0+\\d* → 300`), '0.3 m previews as 300 mm');

    const unit = card.querySelector<HTMLSelectElement>('select[aria-label="Unit"]')!;
    act(() => { unit.value = 'm2'; unit.dispatchEvent(new window.Event('change', { bubbles: true })); });
    assert.match(card.textContent ?? '', /Unit does not fit the target/, 'an edited unit is validated against the quantity type');
    act(() => { unit.value = 'm'; unit.dispatchEvent(new window.Event('change', { bubbles: true })); });
    click([...card.querySelectorAll('button')].find((b) => b.textContent === 'Review as changes')!);
    await advance(0);
    assert.match([...document.body.querySelectorAll('[role="dialog"]')].at(-1)?.textContent ?? '', /Apply 1 change/);
  });
});
