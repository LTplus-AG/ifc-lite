/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SearchableSelect`'s popup moved onto `ui/popover.tsx` (#5817). This
 * asserts the acceptance criteria: closes on Esc and returns focus to the
 * trigger; closes on outside click (see `SearchableSelect.test.tsx` for the
 * portal/clipping/filter/commit coverage this file doesn't repeat).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, cleanup, press, render, waitFor } from '@/test/render.js';
import { SearchableSelect } from './SearchableSelect.js';

afterEach(cleanup);

async function pointerDownOutside(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function mount() {
  const host = render(
    <SearchableSelect value="" options={['Alpha', 'Beta', 'Gamma']} onChange={() => {}} />,
  );
  const trigger = host.querySelector('button')!;
  // A real click focuses the button before Radix's own open handling runs;
  // the synthetic `click()` dispatch below doesn't carry that browser
  // default action, so it's done explicitly — otherwise there is no
  // "opener" on record for Escape's focus-return.
  act(() => trigger.focus());
  return { host, trigger };
}

describe('SearchableSelect popover dismissal (#5817)', () => {
  it('opens on trigger click and closes on Escape, returning focus to the trigger', async () => {
    const { trigger } = mount();
    click(trigger);
    assert.ok(document.querySelector('[data-testid="searchable-select-popup"]'), 'popup opens');

    press(document.activeElement ?? trigger, 'Escape');

    await waitFor(
      () => !document.querySelector('[data-testid="searchable-select-popup"]'),
      'Escape closes the popup',
    );
    await waitFor(() => document.activeElement === trigger, 'focus returns to the trigger on Escape');
  });

  it('closes on an outside click', async () => {
    const { trigger } = mount();
    click(trigger);
    assert.ok(document.querySelector('[data-testid="searchable-select-popup"]'), 'popup opens');

    await pointerDownOutside();

    await waitFor(
      () => !document.querySelector('[data-testid="searchable-select-popup"]'),
      'outside click closes the popup',
    );
  });
});
