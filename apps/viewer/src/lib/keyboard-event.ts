/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Defensive readers for the two `KeyboardEvent` fields whose TypeScript types
 * are stricter than what browsers actually dispatch.
 *
 * `KeyboardEvent.key` is typed `string` by the DOM lib, but it is genuinely
 * absent on some real events:
 *  - Chromium fires a `keyup` carrying no `key` when the user accepts a browser
 *    autofill / password-manager suggestion (reproduced on Edge 150 / Windows).
 *  - Events synthesised by extensions or by `dispatchEvent(new Event('keyup'))`
 *    have no `key` either — `Event` has no `key`, and nothing stops that event
 *    from reaching a `keyup` listener.
 *
 * Reading `.toLowerCase()` on that threw an uncaught
 * `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`,
 * which aborted the rest of the handler. In the fly-through controls that left
 * the movement loop armed on a key whose `keyup` never cleared it, so panning
 * kept running until the next matching keypress.
 *
 * `event.target` is likewise `null` for an event dispatched at no node, and is
 * not necessarily an `HTMLElement` (an `SVGElement`, `document` or `window`
 * has no `tagName`/`isContentEditable`), so the "is the user typing?" guard
 * every key handler opens with needs the same treatment.
 */

/**
 * The event's `key`, lower-cased — or `null` when the browser omitted it.
 *
 * Callers should treat `null` as "no identifiable key" and skip the event:
 * every comparison against a concrete key would be false anyway.
 */
export function eventKey(e: KeyboardEvent): string | null {
  // Read through an untyped view: the DOM lib promises a string, the browser
  // does not.
  const key = (e as { key?: unknown }).key;
  return typeof key === 'string' ? key.toLowerCase() : null;
}

/**
 * Keys the Walk tool's movement loop owns (see `useKeyboardControls`). While
 * `activeTool === 'walk'`, global single-key shortcuts must not also fire on
 * them — A would otherwise "Show all" and D toggle the presentation dock.
 */
export const WALK_MOVEMENT_KEYS: ReadonlySet<string> = new Set([
  'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  'w', 's', 'a', 'd',
]);

/** ARIA roles whose widgets consume plain keys (type-ahead, arrows, values). */
const INPUT_ROLE_SELECTOR =
  '[role=combobox],[role=listbox],[role=slider],[role=menu],[role=menuitem]';

/**
 * True when `target` is a surface that consumes plain key presses — a
 * text-entry element (`<input>`, `<textarea>`, a `contenteditable` host), a
 * native `<select>` (type-ahead), or an element inside an ARIA combobox,
 * listbox, slider or menu — so single-key shortcuts must not fire.
 *
 * Returns `false` for a missing or non-HTML target rather than throwing.
 */
export function isTextEntryElement(target: unknown): boolean {
  const el = target as (Partial<HTMLElement> | null | undefined);
  if (!el) return false;
  if (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  ) {
    return true;
  }
  return typeof el.closest === 'function' && el.closest(INPUT_ROLE_SELECTOR) !== null;
}

/** {@link isTextEntryElement} for a key event's target. */
export function isTextEntryTarget(e: Event): boolean {
  return isTextEntryElement(e.target);
}
