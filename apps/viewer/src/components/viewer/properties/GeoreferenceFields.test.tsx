/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5821: georeference fields remain keyboard editable after the type-scale split. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render';
import { AngleRow, GeorefRow } from './GeoreferenceFields';

afterEach(cleanup);

it('opens a georeference field with Enter, focuses its input, and applies a suggested datum (#5821)', () => {
  let saved: string | number | null = null;
  const host = render(<GeorefRow label="GeodeticDatum" value="ETRS89" editable fieldEntity="projectedCRS" fieldName="geodeticDatum" onSave={value => { saved = value; }} />);
  const row = host.querySelector<HTMLElement>('[role="button"][aria-label="GeodeticDatum"]');
  assert.ok(row, 'the editable row is named and keyboard reachable');
  assert.equal(row.tabIndex, 0);
  act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  const input = host.querySelector<HTMLInputElement>('input');
  assert.ok(input, 'Enter opens the real inline editor');
  assert.equal(document.activeElement, input, 'the opened editor receives focus');
  const suggestion = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'WGS84');
  assert.ok(suggestion);
  act(() => suggestion.click());
  assert.equal(saved, 'WGS84');
  assert.equal(host.querySelector('input'), null, 'the editor closes after applying a datum');
});

it('opens the angle editor with Space and restores the read-only row on Escape (#5821)', () => {
  let changed = false;
  const host = render(<AngleRow angle={30} editable onAngleChange={() => { changed = true; }} />);
  const row = host.querySelector<HTMLElement>('[role="button"]');
  assert.ok(row);
  act(() => { row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })); });
  const input = host.querySelector<HTMLInputElement>('input');
  assert.ok(input);
  assert.equal(document.activeElement, input);
  act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  assert.equal(host.querySelector('input'), null);
  assert.equal(changed, false, 'cancel does not change the angle');
});

it('keeps a terrain action separate from the editable value (#5821)', () => {
  let terrainClicks = 0;
  const host = render(
    <GeorefRow label="OrthogonalHeight" value={1300} editable isNumber onSave={() => {}}>
      <button onClick={() => { terrainClicks++; }}>Use terrain height</button>
    </GeorefRow>,
  );
  assert.equal(host.querySelector('[role="button"][aria-label="OrthogonalHeight"]'), null,
    'the row containing another button must not expose a nested button role');
  const terrain = [...host.querySelectorAll('button')].find(button => button.textContent === 'Use terrain height');
  assert.ok(terrain);
  act(() => terrain.click());
  assert.equal(terrainClicks, 1);
  assert.equal(host.querySelector('input'), null, 'terrain action must not also open the inline editor');
  const edit = host.querySelector<HTMLButtonElement>('button[aria-label="Edit OrthogonalHeight"]');
  assert.ok(edit, 'the field still has an independent keyboard-accessible edit action');
  act(() => edit.click());
  assert.ok(host.querySelector('input'));
});
