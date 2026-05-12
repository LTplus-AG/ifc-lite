/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { computeHmac, createReplayProtector } from '../src/replay-protect.js';

const SECRET = Buffer.from('super-secret', 'utf8');

function envelope(clientId: number, clock: number, payload: Uint8Array) {
  return {
    clientId,
    clock,
    payload,
    hmac: computeHmac(SECRET, clientId, clock, payload),
  };
}

describe('replay protector', () => {
  it('accepts a valid envelope and tracks the clock', () => {
    const p = createReplayProtector({ secret: 'super-secret' });
    const ok = p.verify(envelope(1, 1, new Uint8Array([0xaa])));
    expect(ok.ok).toBe(true);
    expect(p.highestClock(1)).toBe(1);
  });

  it('rejects a tampered HMAC', () => {
    const p = createReplayProtector({ secret: 'super-secret' });
    const env = envelope(1, 1, new Uint8Array([0xaa]));
    env.hmac = '00'.repeat(32);
    const result = p.verify(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-mac');
  });

  it('rejects replays with non-monotonic clocks', () => {
    const p = createReplayProtector({ secret: 'super-secret' });
    expect(p.verify(envelope(1, 5, new Uint8Array([1]))).ok).toBe(true);
    const replay = p.verify(envelope(1, 5, new Uint8Array([1])));
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replay');
  });

  it('rejects on payload mismatch (HMAC over payload)', () => {
    const p = createReplayProtector({ secret: 'super-secret' });
    const env = envelope(1, 1, new Uint8Array([0xaa]));
    env.payload = new Uint8Array([0xbb]); // tampered payload
    const result = p.verify(env);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-mac');
  });
});
