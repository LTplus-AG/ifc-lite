/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { eventKey, isTextEntryTarget } from './keyboard-event.js';

/**
 * Build a KeyboardEvent-shaped stub. The point of these helpers is exactly the
 * cases the DOM types say cannot happen, so the stub is deliberately typed as
 * the DOM interface only at the boundary.
 */
const keyEvent = (key: unknown): KeyboardEvent =>
  ({ key } as unknown as KeyboardEvent);

const eventOn = (target: unknown): Event =>
  ({ target } as unknown as Event);

describe('eventKey', () => {
  it('lower-cases a normal key', () => {
    assert.equal(eventKey(keyEvent('A')), 'a');
    assert.equal(eventKey(keyEvent('w')), 'w');
    assert.equal(eventKey(keyEvent('Escape')), 'escape');
    assert.equal(eventKey(keyEvent('ArrowLeft')), 'arrowleft');
  });

  it('returns null when the browser omits `key` (autofill keyup)', () => {
    // The production crash: Chromium dispatches a `keyup` with no `key` after
    // an autofill pick, and `e.key.toLowerCase()` threw.
    assert.equal(eventKey(keyEvent(undefined)), null);
    assert.equal(eventKey({} as unknown as KeyboardEvent), null);
  });

  it('returns null for non-string `key` values rather than throwing', () => {
    assert.equal(eventKey(keyEvent(null)), null);
    assert.equal(eventKey(keyEvent(65)), null);
    assert.equal(eventKey(keyEvent({ toLowerCase: () => 'a' })), null);
  });

  it('preserves keys that are falsy-but-valid strings', () => {
    // A space bar keypress reports ' ', and '0' is a real key. Neither may be
    // dropped by a truthiness check.
    assert.equal(eventKey(keyEvent(' ')), ' ');
    assert.equal(eventKey(keyEvent('0')), '0');
    // The empty string is not a key any handler matches, but it is a string,
    // so it must round-trip rather than become null.
    assert.equal(eventKey(keyEvent('')), '');
  });

  it('does not mutate the event', () => {
    const e = keyEvent('A');
    eventKey(e);
    assert.equal(e.key, 'A');
  });
});

describe('isTextEntryTarget', () => {
  it('detects the text-entry elements shortcuts must not fire inside', () => {
    assert.equal(isTextEntryTarget(eventOn({ tagName: 'INPUT' })), true);
    assert.equal(isTextEntryTarget(eventOn({ tagName: 'TEXTAREA' })), true);
    assert.equal(
      isTextEntryTarget(eventOn({ tagName: 'DIV', isContentEditable: true })),
      true,
    );
  });

  it('lets shortcuts through for ordinary targets', () => {
    assert.equal(isTextEntryTarget(eventOn({ tagName: 'CANVAS' })), false);
    assert.equal(
      isTextEntryTarget(eventOn({ tagName: 'DIV', isContentEditable: false })),
      false,
    );
    assert.equal(isTextEntryTarget(eventOn({ tagName: 'BUTTON' })), false);
  });

  it('returns false instead of throwing on a missing target', () => {
    // `e.target` is null for an event dispatched at no node — the old
    // `(e.target as HTMLElement).tagName` read threw here.
    assert.equal(isTextEntryTarget(eventOn(null)), false);
    assert.equal(isTextEntryTarget(eventOn(undefined)), false);
  });

  it('returns false for targets with no tagName (document, window, SVG)', () => {
    assert.equal(isTextEntryTarget(eventOn({})), false);
    // An SVGElement has a tagName but no isContentEditable.
    assert.equal(isTextEntryTarget(eventOn({ tagName: 'svg' })), false);
  });

  it('is case-sensitive on tagName, matching DOM semantics', () => {
    // HTML elements always report an upper-case tagName; a lower-case one
    // comes from XML/SVG content, which is not a text-entry surface.
    assert.equal(isTextEntryTarget(eventOn({ tagName: 'input' })), false);
  });
});
