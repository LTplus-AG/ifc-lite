/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `describeThrown` must turn any thrown value into a bounded message without
 * throwing itself (#9523, PR #9905 review: a `toJSON` that throws null made a
 * catch block throw while reading `.message`).
 */

import { describe, expect, it } from 'vitest';
import { describeThrown } from './errors.js';

describe('describeThrown', () => {
  it('reads Error messages, strings and message-bearing objects', () => {
    expect(describeThrown(new Error('boom'))).toBe('boom');
    expect(describeThrown('plain')).toBe('plain');
    expect(describeThrown({ message: 'EPIPE from another realm' })).toBe('EPIPE from another realm');
  });

  it('names values that carry no message', () => {
    expect(describeThrown(null)).toBe('a thrown null');
    expect(describeThrown(undefined)).toBe('a thrown undefined');
    expect(describeThrown(42)).toBe('a thrown number');
    expect(describeThrown({ code: 1 })).toBe('a thrown object');
  });

  it('caps every branch at the same length', () => {
    expect(describeThrown(new Error('e'.repeat(2000)))).toBe(`${'e'.repeat(500)}…`);
    expect(describeThrown('s'.repeat(2000))).toBe(`${'s'.repeat(500)}…`);
  });
});
