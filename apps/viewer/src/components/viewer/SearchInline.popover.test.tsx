/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SearchInline`'s results dropdown moved onto `@radix-ui/react-popover`
 * (#5817): it used to close only via its own `window` `mousedown` listener
 * (SearchInline.tsx:368 in the issue) and its own `handleInputKeyDown`
 * Escape branch, neither wired to Radix's dismissal semantics.
 *
 * This asserts the acceptance criteria for the migrated popover: it closes
 * on Esc and on an outside click, and — since this is a combobox where DOM
 * focus stays on the `<input>` throughout (arrow keys / Enter navigate the
 * list without moving focus into it) — focus is never disturbed by either
 * dismissal path.
 */

import '@/test/setup-dom.js';

import { act } from 'react';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, press, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SearchInline } from './SearchInline.js';

const MODEL_ID = 'model-a';

let initialState: ReturnType<typeof useViewerStore.getState>;

function seedOpenWithResults(): HTMLElement {
  useViewerStore.setState({
    ...fixtureModels(
      fixtureModel(MODEL_ID, {
        idOffset: 1_000_000,
        entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }],
      }),
    ),
    searchQuery: 'Wall',
    searchOpen: true,
    searchIndexes: new Map([[MODEL_ID, { status: 'building', progress: 0 }]]) as never,
  });
  return render(<SearchInline />);
}

/**
 * Radix's `DismissableLayer` attaches its `pointerdown` listener from a
 * `setTimeout(0)` on mount (so the click that OPENED the popover is never
 * mistaken for one that should close it) and, for a left-button press,
 * defers the actual dismissal to the trailing `click` — the real two-event
 * sequence a browser fires for one physical click. See `ui/popover.test.tsx`
 * for the same pattern against the wrapper directly.
 */
async function pointerDownOutside(): Promise<void> {
  await advance(0);
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('SearchInline popover dismissal (#5817)', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });
  after(() => { useViewerStore.setState(initialState, true); });

  it('renders the popover as a listbox anchored to the input', () => {
    const container = seedOpenWithResults();
    const popover = document.getElementById('search-inline-popover');
    assert.ok(popover, 'popover renders while open');
    assert.equal(popover?.getAttribute('role'), 'listbox');
    const input = container.querySelector('input')!;
    assert.equal(input.getAttribute('aria-controls'), 'search-inline-popover');
  });

  it('Esc closes the popover without moving focus off the input', () => {
    const container = seedOpenWithResults();
    const input = container.querySelector('input')!;
    act(() => input.focus());
    assert.ok(document.getElementById('search-inline-popover'), 'popover open before Escape');

    press(input, 'Escape');

    assert.equal(useViewerStore.getState().searchOpen, false);
    assert.equal(document.getElementById('search-inline-popover'), null, 'Escape closes the popover');
    assert.equal(document.activeElement, input, 'focus stays on the input — this is a combobox, not a dialog');
  });

  it('an outside click closes the popover without moving focus off the input', async () => {
    const container = seedOpenWithResults();
    const input = container.querySelector('input')!;
    act(() => input.focus());
    assert.ok(document.getElementById('search-inline-popover'), 'popover open before the outside click');

    await pointerDownOutside();

    assert.equal(useViewerStore.getState().searchOpen, false);
    assert.equal(document.getElementById('search-inline-popover'), null, 'outside click closes the popover');
    assert.equal(document.activeElement, input, 'focus stays on the input');
  });
});
