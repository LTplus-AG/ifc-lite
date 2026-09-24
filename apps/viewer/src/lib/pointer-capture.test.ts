/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5403: `setPointerCapture` threw `InvalidStateError` out of pointerdown
 * handlers in production. The fake below follows the Pointer Events 3 contract
 * for the capture methods: `NotFoundError` for an id that is not an active
 * pointer, `InvalidStateError` while pointer lock is held, and release is a
 * no-op for a pointer the element does not hold.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { capturePointer, releasePointer, type PointerCaptureTarget } from './pointer-capture.js';

interface FakeElement extends PointerCaptureTarget {
  captured: Set<number>;
  captureCalls: number;
  releaseCalls: number;
}

function fakeElement(opts: { active?: number[]; connected?: boolean; pointerLocked?: boolean; captureThrows?: unknown } = {}): FakeElement {
  const active = new Set(opts.active ?? [1]);
  const el: FakeElement = {
    isConnected: opts.connected ?? true,
    captured: new Set<number>(),
    captureCalls: 0,
    releaseCalls: 0,
    setPointerCapture(id: number) {
      el.captureCalls++;
      if (opts.captureThrows !== undefined) throw opts.captureThrows;
      if (!active.has(id)) throw new DOMException('No active pointer with the given id is found.', 'NotFoundError');
      if (opts.pointerLocked) throw new DOMException('Pointer lock is active.', 'InvalidStateError');
      el.captured.add(id);
    },
    hasPointerCapture: (id: number) => el.captured.has(id),
    releasePointerCapture(id: number) {
      el.releaseCalls++;
      if (!active.has(id)) throw new DOMException('No active pointer with the given id is found.', 'NotFoundError');
      el.captured.delete(id);
    },
  };
  return el;
}

describe('capturePointer (#5403)', () => {
  it('captures an active pointer on a connected element', () => {
    const el = fakeElement();
    assert.equal(capturePointer(el, 1), true);
    assert.ok(el.hasPointerCapture(1));
  });

  it('does not throw for a pointer that is no longer active', () => {
    const el = fakeElement({ active: [] });
    assert.equal(capturePointer(el, 7), false);
    assert.equal(el.captured.size, 0);
  });

  it('does not throw while pointer lock is held (the fly-mode InvalidStateError)', () => {
    const el = fakeElement({ pointerLocked: true });
    assert.equal(capturePointer(el, 1), false);
  });

  it('skips a detached or missing element without touching the DOM', () => {
    const detached = fakeElement({ connected: false });
    assert.equal(capturePointer(detached, 1), false);
    assert.equal(detached.captureCalls, 0);
    assert.equal(capturePointer(null, 1), false);
    assert.equal(capturePointer(undefined, 1), false);
  });

  it('treats a refusal raised in another window realm as a refusal (detached panels)', () => {
    // A detached panel's element belongs to a second window, so its DOMException
    // is not `instanceof` this realm's Error; an `instanceof` check rethrew it.
    const foreign: unknown = runInNewContext("Object.assign(new Error('Pointer lock is active.'), { name: 'InvalidStateError' })");
    assert.equal(foreign instanceof Error, false, 'precondition: the error comes from another realm');
    const el = fakeElement({ captureThrows: foreign });
    assert.equal(capturePointer(el, 1), false);
  });

  it('rethrows an error that is not a capture refusal', () => {
    const el = fakeElement({ captureThrows: new TypeError('bug in the caller') });
    assert.throws(() => capturePointer(el, 1), TypeError);
  });
});

describe('releasePointer (#5403)', () => {
  it('releases a pointer the element holds', () => {
    const el = fakeElement();
    capturePointer(el, 1);
    releasePointer(el, 1);
    assert.equal(el.hasPointerCapture(1), false);
  });

  it('is a no-op when capture was never taken or already dropped', () => {
    const el = fakeElement({ active: [] });
    assert.doesNotThrow(() => releasePointer(el, 7));
    assert.equal(el.releaseCalls, 0, 'the raw release would throw NotFoundError for an inactive pointer');
    assert.doesNotThrow(() => releasePointer(null, 1));
  });
});
