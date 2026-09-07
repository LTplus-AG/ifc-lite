/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { publishPrepassFingerprint, runPrepassWithFingerprint } from './prepass-source-fingerprint.js';

describe('optional prepass fingerprint publication (#3985)', () => {
  it('accepts full-source keys and leaves older complete events unavailable', () => {
    const cell = new SharedArrayBuffer(16), words = new Uint32Array(cell);
    words[0] = 5;
    publishPrepassFingerprint(cell, 5, { type: 'complete', totalJobs: 0 });
    expect(Atomics.load(words, 3)).toBe(0);
    publishPrepassFingerprint(cell, 5, { type: 'complete', totalJobs: 0, sourceContentKey: '5-4f9f2cab' });
    expect(Atomics.load(words, 3)).toBe(1);
    expect(Atomics.load(words, 2)).toBe(0x4f9f2cab);
    expect(words[0]).toBe(5);
  });
});

it('keeps old API dispatch and source views intact while detecting new wrappers', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const events: unknown[] = [];
  const calls: string[] = [];
  const onEvent = (event: unknown) => events.push(event);
  const api = {
    buildPrePassStreaming(source: Uint8Array, emit: (event: unknown) => void) {
      expect(this).toBe(api);
      expect(source).toBe(bytes);
      calls.push('serial'); emit({ type: 'complete' });
    },
    buildPrePassStreamingSharded(source: Uint8Array, emit: (event: unknown) => void) {
      expect(this).toBe(api);
      expect(source).toBe(bytes);
      calls.push('sharded'); emit({ type: 'complete' });
    },
  };
  const columns: [Uint32Array, Uint32Array, Uint32Array, Uint8Array] = [new Uint32Array(), new Uint32Array(), new Uint32Array(), new Uint8Array()];
  const cell = new SharedArrayBuffer(16);
  runPrepassWithFingerprint(api, [bytes, onEvent, 1024, undefined, true], cell);
  runPrepassWithFingerprint(api, [bytes, onEvent, 1024, undefined, true], cell, columns);
  const enhanced = Object.assign(api, {
    buildPrePassStreamingWithSourceFingerprint(source: Uint8Array, emit: (event: unknown) => void) {
      expect(this).toBe(api); expect(source).toBe(bytes);
      calls.push('serial-key'); emit({ type: 'complete', sourceContentKey: '3-56cf37ab' });
    },
    buildPrePassStreamingShardedWithSourceFingerprint(source: Uint8Array, emit: (event: unknown) => void) {
      expect(this).toBe(api); expect(source).toBe(bytes);
      calls.push('sharded-key'); emit({ type: 'complete', sourceContentKey: '3-56cf37ab' });
    },
  });
  runPrepassWithFingerprint(enhanced, [bytes, onEvent, 1024, undefined, true], cell);
  runPrepassWithFingerprint(enhanced, [bytes, onEvent, 1024, undefined, true], cell, columns);
  runPrepassWithFingerprint(enhanced, [bytes, onEvent, 1024, undefined, true]);
  expect(calls).toEqual(['serial', 'sharded', 'serial-key', 'sharded-key', 'serial']);
  expect(events).toHaveLength(5);
});
