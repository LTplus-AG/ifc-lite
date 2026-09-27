/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ui/popover.tsx` (#5817): the shared Radix wrapper the hand-rolled
 * popovers migrate onto. Asserts the behaviour those hand-rolled versions
 * lacked — Esc/outside-click dismissal and focus return to the opener —
 * which is Radix's job here, not this thin wrapper's, so this is really a
 * smoke test that the wrapper wires it through unbroken.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, click, cleanup, press, render, waitFor } from '@/test/render.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

afterEach(cleanup);

/**
 * Radix's outside-dismiss listens for `pointerdown` (not `click`/`mousedown`,
 * `@radix-ui/react-dismissable-layer`) and, for a left-button press,
 * defers the actual dismissal to the trailing `click` — the real two-event
 * sequence a browser fires for one physical click. The listener itself is
 * attached from a `setTimeout(0)` on mount (so the click that OPENED the
 * popover is never mistaken for one that should close it), hence the
 * `advance(0)` before dispatching either event here.
 */
async function pointerDownOutside(): Promise<void> {
  await advance(0);
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function mount() {
  const host = render(
    <Popover>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>
        <p>Popover body</p>
      </PopoverContent>
    </Popover>,
  );
  const trigger = host.querySelector('button')!;
  // A real click focuses the button before Radix's own open handling runs;
  // the synthetic `click()` dispatch below doesn't carry that browser
  // default action, so it's done explicitly — otherwise there is no
  // "opener" on record for either dismissal path to return focus to.
  act(() => trigger.focus());
  return { host, trigger };
}

describe('ui/popover', () => {
  it('opens on trigger click and closes on Escape, returning focus to the trigger', async () => {
    const { trigger } = mount();
    click(trigger);
    assert.match(document.body.textContent ?? '', /Popover body/, 'popover renders once open');

    press(document.activeElement ?? trigger, 'Escape');
    await waitFor(
      () => !(document.body.textContent ?? '').includes('Popover body'),
      'Escape closes the popover',
    );
    await waitFor(() => document.activeElement === trigger, 'focus returns to the opener on Escape');
  });

  it('closes on outside click', async () => {
    // Radix's non-modal default deliberately does NOT force focus back to
    // the trigger after an outside click (`hasInteractedOutsideRef` in
    // `@radix-ui/react-popover`) — the click's own focus effect wins, so a
    // click on another field doesn't get yanked back to the opener. Only
    // the close-without-an-outside-target paths (Escape, above) return
    // focus, so this test asserts dismissal only.
    const { trigger } = mount();
    click(trigger);
    assert.match(document.body.textContent ?? '', /Popover body/);

    await pointerDownOutside();
    await waitFor(
      () => !(document.body.textContent ?? '').includes('Popover body'),
      'outside click closes the popover',
    );
  });
});
