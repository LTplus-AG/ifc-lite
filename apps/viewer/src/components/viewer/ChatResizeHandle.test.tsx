/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #5821: the chat pane's resize separator remains operable from the keyboard. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { cleanup, render } from '@/test/render';
import { ChatResizeHandle } from './ChatResizeHandle';

afterEach(cleanup);

it('resizes the chat pane with arrow and boundary keys while reporting its width (#5821)', () => {
  function Pane() {
    const [width, setWidth] = useState(500);
    return <ChatResizeHandle width={width} onWidthChange={setWidth} onMouseDown={() => {}} />;
  }

  const host = render(<Pane />);
  const separator = host.querySelector<HTMLElement>('[role="separator"]');
  assert.ok(separator);
  assert.equal(separator.tabIndex, 0);
  assert.equal(separator.getAttribute('aria-orientation'), 'vertical');
  assert.equal(separator.getAttribute('aria-valuemin'), '240');
  assert.equal(separator.getAttribute('aria-valuemax'), '700');
  assert.equal(separator.getAttribute('aria-valuenow'), '500');

  for (const [key, expected] of [
    ['ArrowLeft', '520'],
    ['ArrowRight', '500'],
    ['Home', '240'],
    ['End', '700'],
    ['ArrowLeft', '700'],
    ['ArrowRight', '680'],
  ]) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => { separator.dispatchEvent(event); });
    assert.equal(event.defaultPrevented, true, `${key} is handled by the separator`);
    assert.equal(separator.getAttribute('aria-valuenow'), expected);
  }
});
