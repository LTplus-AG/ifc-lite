/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnnotationDropInput`'s shell moved onto `ui/popover.tsx` (#5817): it
 * used to be a hand-rolled `HudSurface` with `role="dialog"` and its own
 * `document` `mousedown` listener for outside-click (which committed a
 * non-empty draft or silently cancelled an empty one) and its own Escape
 * handler (always cancel). This asserts the acceptance criteria plus the
 * commit-vs-cancel distinction the outside-click path preserves.
 */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, press, render, type, waitFor } from '@/test/render.js';
import { AnnotationDropInput } from './AnnotationDropInput.js';

afterEach(cleanup);

async function pointerDownOutside(): Promise<void> {
  await advance(0);
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function mount(boundaryEl: HTMLElement | null = null) {
  let saved: string | null = null;
  let cancelled = false;
  const host = render(
    <AnnotationDropInput
      anchorX={100}
      anchorY={100}
      boundaryEl={boundaryEl}
      entityType={null}
      onSave={(note) => { saved = note; }}
      onCancel={() => { cancelled = true; }}
    />,
  );
  return { host, savedNote: () => saved, isCancelled: () => cancelled };
}

describe('AnnotationDropInput dismissal (#5817)', () => {
  it('closes (cancels) on Escape with an empty draft', async () => {
    const { host, isCancelled } = mount();
    press(host, 'Escape');
    await waitFor(() => isCancelled(), 'Escape cancels the drop with no note typed');
  });

  it('cancels a typed draft on Escape instead of saving it (#6110 review)', async () => {
    const { host, savedNote, isCancelled } = mount();
    const textarea = host.querySelector('textarea')!;
    type(textarea, 'leak here');

    press(textarea, 'Escape');

    await waitFor(() => isCancelled(), 'Escape cancels the typed draft');
    assert.equal(savedNote(), null);
  });

  it('an outside click with a non-empty draft commits the note instead of cancelling', async () => {
    const { host, savedNote, isCancelled } = mount();
    const textarea = host.querySelector('textarea')!;
    type(textarea, 'leak here');

    await pointerDownOutside();

    await waitFor(() => savedNote() === 'leak here', 'outside click commits a non-empty draft');
    assert.equal(isCancelled(), false);
  });

  it('an outside click with an empty draft cancels silently', async () => {
    const { savedNote, isCancelled } = mount();

    await pointerDownOutside();

    await waitFor(() => isCancelled(), 'outside click cancels an empty draft');
    assert.equal(savedNote(), null);
  });

  it('passes boundaryEl to Radix as collisionBoundary (#5817 review)', async () => {
    // Same proof as `AnnotationPopover.popover.test.tsx`: floating-ui's
    // collision detection calls `getBoundingClientRect()` on every element
    // in `collisionBoundary` — if it were left at Radix's default (the
    // viewport, not the canvas layer), this mock would never be called.
    let calls = 0;
    const boundary = document.createElement('div');
    Object.defineProperty(boundary, 'getBoundingClientRect', {
      value: () => {
        calls += 1;
        return { left: 0, top: 0, right: 120, bottom: 90, width: 120, height: 90, x: 0, y: 0, toJSON: () => ({}) };
      },
      configurable: true,
    });
    document.body.appendChild(boundary);
    try {
      mount(boundary);
      await advance(0);

      assert.ok(document.querySelector('[data-radix-popper-content-wrapper]'), 'popover content renders');
      assert.ok(calls > 0, 'boundaryEl.getBoundingClientRect() must be called — collisionBoundary is wired to it');
    } finally {
      boundary.remove();
    }
  });
});
