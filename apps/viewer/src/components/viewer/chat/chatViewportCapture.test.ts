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
