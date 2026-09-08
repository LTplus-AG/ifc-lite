/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The auto-captured chat screenshot must never go stale: the slot is consumed
 * at send time, so a failed capture that leaves the previous value in place
 * ships the WRONG viewport to the model.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { resolveChatViewportScreenshot } from './chatViewportCapture.js';
import { create } from 'zustand';
import { createChatSlice, type ChatSlice } from '../../../store/slices/chatSlice.js';

const canvas = {} as HTMLCanvasElement;

let warnings: unknown[][];
const realWarn = console.warn;
beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
});
afterEach(() => { console.warn = realWarn; });

describe('resolveChatViewportScreenshot', () => {
  it('returns the captured data URL', () => {
    assert.strictEqual(
      resolveChatViewportScreenshot(canvas, () => 'data:image/jpeg;base64,AAA'),
      'data:image/jpeg;base64,AAA',
    );
    assert.deepStrictEqual(warnings, [], 'the happy path must stay quiet');
  });

  it('returns null — not the previous shot — when the capture throws', () => {
    // A tainted canvas (SecurityError) or a lost context. The caller stores
    // this value unconditionally, so null is what CLEARS the stale screenshot;
    // returning undefined / skipping the write is the bug this guards.
    const boom = new Error('SecurityError: tainted canvas');
    const out = resolveChatViewportScreenshot(canvas, () => { throw boom; });
    assert.strictEqual(out, null);
    assert.strictEqual(warnings.length, 1);
    assert.match(String(warnings[0][0]), /screenshot capture failed/);
    assert.strictEqual(warnings[0][1], boom);
  });

  it('returns null without logging when there is no canvas', () => {
    assert.strictEqual(resolveChatViewportScreenshot(null, () => 'x'), null);
    assert.deepStrictEqual(warnings, [], 'a missing canvas is not an error');
  });

  it('treats an empty capture as no screenshot', () => {
    assert.strictEqual(resolveChatViewportScreenshot(canvas, () => ''), null);
  });
});

describe('the caller writes the slot unconditionally', () => {
  it('clears a previous run\'s image when this run\'s capture fails', () => {
    // Pins the CALLER-side behaviour change, not just the resolver.
    // ExecutableCodeBlock writes the slot unconditionally, so a failed capture
    // replaces the prior image with null. Writing only on success is what
    // attached run A's screenshot to a message about run B (#2085), and the
    // slot is cleared only at send time, so the stale value survived.
    const store = create<ChatSlice>()((...a) => createChatSlice(...a));
    const canvas = {} as HTMLCanvasElement;

    store.getState().setChatViewportScreenshot(
      resolveChatViewportScreenshot(canvas, () => 'data:image/png;base64,AAAA'),
    );
    assert.strictEqual(store.getState().chatViewportScreenshot, 'data:image/png;base64,AAAA');

    store.getState().setChatViewportScreenshot(
      resolveChatViewportScreenshot(canvas, () => {
        throw new Error('capture failed');
      }),
    );
    assert.strictEqual(store.getState().chatViewportScreenshot, null);
  });
});
