/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnnotationPopover`'s shell moved onto `ui/popover.tsx` (#5817): it used
 * to be a hand-rolled `HudSurface` with `role="dialog"` and its own
 * `document` `mousedown` listener for outside-click — Escape never closed
 * the popover itself (only cancelled an in-progress edit). This asserts the
 * acceptance criteria: closes on Esc and returns focus to the opener;
 * closes on an outside click.
 */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advance, cleanup, press, render, waitFor } from '@/test/render.js';
import type { Annotation } from '@/store/slices/annotationsSlice';
import { AnnotationPopover } from './AnnotationPopover.js';

afterEach(cleanup);

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  const now = Date.now();
  return {
    id: 'ann-1',
    position: { x: 0, y: 0, z: 0 },
    modelId: null,
    entityExpressId: null,
    note: 'Check this detail before pouring the slab.',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Annotation;
}

async function pointerDownOutside(): Promise<void> {
  await advance(0);
  act(() => {
    document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    document.body.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * There is no real DOM "opener" here to assert a focus-return against: the
 * pin is a projected SVG point (`Pin.tsx`), not a focusable trigger — its
 * own click handler toggles selection directly (`AnnotationLayer.tsx`),
 * unlike `KeyboardShortcutsDialog`/`HelpHint`/`SearchInline`, which each
 * have a real button. So this only asserts dismissal itself (`onClose`
 * called); `AnnotationLayer.test.tsx` covers the pin-click open/close wiring
 * end to end.
 */
function mount(overrides: Partial<Annotation> = {}) {
  let closed = false;
  const host = render(
    <AnnotationPopover
      annotation={makeAnnotation(overrides)}
      anchorX={100}
      anchorY={100}
      canvasWidth={800}
      canvasHeight={600}
      entityType={null}
      onSave={() => {}}
      onDelete={() => {}}
      onClose={() => { closed = true; }}
    />,
  );
  return { host, isClosed: () => closed };
}

describe('AnnotationPopover dismissal (#5817)', () => {
  it('closes on Escape in read mode', async () => {
    const { host, isClosed } = mount();
    assert.match(document.body.textContent ?? '', /Check this detail/);

    press(host, 'Escape');

    await waitFor(() => isClosed(), 'Escape closes the popover (onClose called)');
  });

  it('closes on an outside click', async () => {
    const { isClosed } = mount();
    assert.match(document.body.textContent ?? '', /Check this detail/);

    await pointerDownOutside();

    await waitFor(() => isClosed(), 'outside click closes the popover (onClose called)');
  });

  it('does not close when the click lands on the same annotation pin', async () => {
    const { isClosed } = mount();
    const pin = document.createElement('div');
    pin.setAttribute('data-annotation-pin-id', 'ann-1');
    document.body.appendChild(pin);

    await advance(0);
    act(() => {
      pin.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    act(() => {
      pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    assert.equal(isClosed(), false, 'the pin\'s own click handler owns this toggle, not Radix\'s outside-click');
  });
});
