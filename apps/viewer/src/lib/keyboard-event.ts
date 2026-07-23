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
 * True when the event targets a text-entry surface (`<input>`, `<textarea>` or
 * a `contenteditable` host), i.e. the user is typing and single-key shortcuts
 * must not fire.
 *
 * Returns `false` for a missing or non-HTML target rather than throwing.
 */
export function isTextEntryTarget(e: Event): boolean {
  const target = e.target as (Partial<HTMLElement> | null);
  if (!target) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable === true
  );
}
