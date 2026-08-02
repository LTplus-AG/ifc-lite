/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Input normalization for the Space Sketch editor — the single place that knows
 * what each mouse button / modifier means, so platform quirks are encoded once
 * (and unit-tested) instead of being re-derived in every handler.
 *
 * The big quirk: on macOS a **Ctrl+click is converted by the OS into a real
 * right-click** (`button === 2` + a `contextmenu` event), whereas Cmd/Alt+click
 * stay a normal left-click. So the "remove" gesture reaches the app two ways —
 * a modifier-held primary click (Win/Linux Ctrl, macOS Alt/Cmd) via pointerdown,
 * and a secondary click (any right-click, incl. macOS Ctrl-click) via the
 * context menu. Both must do the same thing; this module makes that explicit.
 */

export type PointerButton = 'primary' | 'middle' | 'secondary' | 'other';

/** Which mouse button a pointer/mouse event used. */
export function pointerButton(e: { button: number }): PointerButton {
  switch (e.button) {
    case 0: return 'primary';
    case 1: return 'middle';
    case 2: return 'secondary';
    default: return 'other';
  }
}

/**
 * True when a remove/dissolve modifier (Alt, Ctrl, or Cmd) is held. Works for
 * pointer and keyboard events alike (both carry the modifier flags), so the
 * pointerdown handler, the hover-preview, and the keydown/keyup listener all
 * agree on what counts as the remove gesture.
 *
 * NOTE: a macOS Ctrl+click does NOT come through here as a primary click — the
 * OS turns it into a secondary click, so it's handled via the context-menu
 * path. This reports the explicit modifier state for a *left* click.
 */
export function isRemoveModifier(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.altKey || e.ctrlKey || e.metaKey;
}
