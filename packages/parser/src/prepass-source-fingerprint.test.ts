/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { readPrepassFingerprint } from './prepass-source-fingerprint.js';

describe('request-local optional prepass source key (#3985)', () => {
  it('never waits or reuses another request cell, including equal-length sources', () => {
    const first = new SharedArrayBuffer(16), second = new SharedArrayBuffer(16);
    const words = new Uint32Array(first);
    words[0] = 5;
    words[2] = 0x4f9f2cab;
    expect(readPrepassFingerprint(first, 5)).toBeUndefined();
    Atomics.store(words, 3, 1);
    expect(readPrepassFingerprint(first, 5)).toBe('5-4f9f2cab');
    expect(readPrepassFingerprint(second, 5)).toBeUndefined();
    expect(readPrepassFingerprint(first, 6)).toBeUndefined();
    expect(readPrepassFingerprint(undefined, 5)).toBeUndefined();
    expect(readPrepassFingerprint(new SharedArrayBuffer(4), 5)).toBeUndefined();
    expect(readPrepassFingerprint(first, 0)).toBeUndefined();
  });
});
