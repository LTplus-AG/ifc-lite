/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as focusReturn from './returnFocusAfterKeyboard';

/** Close the popover and report whether Radix's focus return was cancelled. */
function close(handlers: focusReturn.FocusReturnHandlers): boolean {
  let prevented = false;
  handlers.onCloseAutoFocus({ preventDefault: () => { prevented = true; } } as Event);
  return prevented;
}

// Review of #9257 (#9233): Radix returned focus to the profile picker's trigger
// after a mouse close, so Enter reopened the picker instead of committing.
describe('returning focus to a popover trigger only after a keyboard close (#9233)', () => {
  it('exports the handler factory', () => {
    assert.equal(typeof focusReturn.createFocusReturnHandlers, 'function');
  });

  it('a click outside leaves focus off the trigger', () => {
    const h = focusReturn.createFocusReturnHandlers();
    h.onPointerDownOutside();
    assert.equal(close(h), true);
  });

  it('picking an option with the mouse leaves focus off the trigger', () => {
    const h = focusReturn.createFocusReturnHandlers();
    h.onPointerDownCapture();
    assert.equal(close(h), true);
  });

  it('Escape returns focus to the trigger, even after the mouse was used inside', () => {
    const h = focusReturn.createFocusReturnHandlers();
    h.onPointerDownCapture();
    h.onEscapeKeyDown();
    assert.equal(close(h), false);
  });

  it('a keyboard pick returns focus to the trigger', () => {
    const h = focusReturn.createFocusReturnHandlers();
    h.onPointerDownCapture();
    h.onKeyDownCapture();
    assert.equal(close(h), false);
  });

  it('each close starts fresh: a mouse close does not carry into the next keyboard close', () => {
    const h = focusReturn.createFocusReturnHandlers();
    h.onPointerDownOutside();
    assert.equal(close(h), true);
    assert.equal(close(h), false);
  });
});
