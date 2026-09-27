/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `HelpHint`'s popover moved onto `ui/popover.tsx` (#5817): it used to be a
 * hand-rolled `createPortal` with its own `document` `mousedown`/`keydown`
 * listeners and a plain `role="dialog"` div. This asserts the acceptance
 * criteria: closes on Esc and returns focus to the trigger; closes on an
 * outside click.
 */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, click, press, render, waitFor } from '@/test/render.js';
import { HelpHint } from './HelpHint.js';

afterEach(cleanup);

async function pointerDownOutside(): Promise<void> {
  await advance(0);
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function mount() {
  const host = render(
    <HelpHint label="Test hint">
      <p>Hint body text</p>
    </HelpHint>,
  );
  const trigger = host.querySelector('button')!;
  return { host, trigger };
}

describe('HelpHint popover (#5817)', () => {
  it('does not wrap Tab inside a non-modal hint (#6110 review)', () => {
    render(
      <HelpHint label="Test hint" docLink={{ href: '/guide', label: 'Guide' }}>
        <button type="button">First action</button>
      </HelpHint>,
    );
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    click(trigger);
    const guide = [...document.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent === 'Guide')!;
    const firstAction = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'First action')!;
    act(() => guide.focus());

    press(guide, 'Tab');

    assert.notEqual(document.activeElement, firstAction, 'Radix must not wrap focus to the first control');
  });

  it('opens on trigger click and closes on Escape, returning focus to the trigger', async () => {
    const { trigger } = mount();
    click(trigger);
    assert.match(document.body.textContent ?? '', /Hint body text/);

    press(document.activeElement ?? trigger, 'Escape');
    await waitFor(
      () => !(document.body.textContent ?? '').includes('Hint body text'),
      'Escape closes the popover',
    );
    await waitFor(() => document.activeElement === trigger, 'focus returns to the trigger on Escape');
  });

  it('closes on outside click', async () => {
    const { trigger } = mount();
    click(trigger);
    assert.match(document.body.textContent ?? '', /Hint body text/);

    await pointerDownOutside();
    await waitFor(
      () => !(document.body.textContent ?? '').includes('Hint body text'),
      'outside click closes the popover',
    );
  });
});
