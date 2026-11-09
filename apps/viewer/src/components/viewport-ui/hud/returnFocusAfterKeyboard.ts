/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef } from 'react';

/** Handlers spread onto a Radix popover's Content. */
export interface FocusReturnHandlers {
  onPointerDownCapture: () => void;
  onKeyDownCapture: () => void;
  onPointerDownOutside: () => void;
  onEscapeKeyDown: () => void;
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * Return focus to a popover's trigger only when the popover was closed from
 * the keyboard (#9233). Radix puts focus back on the trigger after every
 * close, and the keyboard dispatcher lets a focused control keep Enter, so a
 * command-bar popover closed with the mouse (a click outside, or picking an
 * option) would otherwise take the next Enter away from the running command:
 * Enter reopened the picker instead of committing the beam. After an Escape or
 * a keyboard pick, focus still returns to the trigger, as a keyboard user
 * expects.
 */
export function createFocusReturnHandlers(): FocusReturnHandlers {
  let pointer = false;
  return {
    onPointerDownCapture: () => { pointer = true; },
    onKeyDownCapture: () => { pointer = false; },
    onPointerDownOutside: () => { pointer = true; },
    onEscapeKeyDown: () => { pointer = false; },
    onCloseAutoFocus: (event) => {
      if (pointer) event.preventDefault();
      pointer = false;
    },
  };
}

/** {@link createFocusReturnHandlers}, stable across renders. */
export function useReturnFocusAfterKeyboard(): FocusReturnHandlers {
  const handlers = useRef<FocusReturnHandlers | null>(null);
  return (handlers.current ??= createFocusReturnHandlers());
}
