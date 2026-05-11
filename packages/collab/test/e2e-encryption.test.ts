/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  createKeyRing,
  decryptFrame,
  deriveRoomKey,
  encryptFrame,
  exportRoomKey,
  generateRoomKey,
  importRoomKey,
} from '../src/security/e2e.js';

describe('E2E encryption', () => {
  it('round-trips through encrypt → decrypt with a derived key', async () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const key = await deriveRoomKey('correct horse battery staple', salt, { iterations: 1000 });
    const plaintext = new TextEncoder().encode('hello, e2e world');
    const frame = await encryptFrame(plaintext, key);
    expect(frame.byteLength).toBeGreaterThan(plaintext.byteLength + 12);
    const decoded = await decryptFrame(frame, [key]);
    expect(new TextDecoder().decode(decoded)).toBe('hello, e2e world');
  });

  it('produces a different key for different salts', async () => {
    const a = await deriveRoomKey('pw', new Uint8Array([1, 2]), { iterations: 1000 });
    const b = await deriveRoomKey('pw', new Uint8Array([9, 9]), { iterations: 1000 });
    const message = new Uint8Array([0xab, 0xcd]);
    const frame = await encryptFrame(message, a);
    await expect(decryptFrame(frame, [b])).rejects.toThrow(/decryption failed/);
  });

  it('wrong-key decryption throws', async () => {
    const a = await generateRoomKey();
    const b = await generateRoomKey();
    const frame = await encryptFrame(new Uint8Array([1, 2, 3]), a);
    await expect(decryptFrame(frame, [b])).rejects.toThrow(/decryption failed/);
  });

  it('export → import preserves the key', async () => {
    const a = await generateRoomKey();
    const exported = await exportRoomKey(a);
    expect(exported.bytes.byteLength).toBe(32);
    const reimported = await importRoomKey(exported.version, exported.bytes);
    const frame = await encryptFrame(new Uint8Array([7, 7, 7]), a);
    const decoded = await decryptFrame(frame, [reimported]);
    expect(decoded).toEqual(new Uint8Array([7, 7, 7]));
  });

  it('key ring rotates keys with grace period', async () => {
    const k1 = await generateRoomKey();
    const ring = createKeyRing(k1, { gracePeriodMs: 60_000 });
    const oldFrame = await encryptFrame(new Uint8Array([1]), k1);
    const k2 = await generateRoomKey();
    ring.rotate(k2);
    expect(ring.current()).toBe(k2);
    // Frame encrypted with retired key still decrypts via the ring.
    const decoded = await decryptFrame(oldFrame, ring.active());
    expect(decoded).toEqual(new Uint8Array([1]));
  });

  it('key ring drops keys past grace', async () => {
    const k1 = await generateRoomKey();
    let now = 1_000_000;
    const ring = createKeyRing(k1, { gracePeriodMs: 100, now: () => now });
    const k2 = await generateRoomKey();
    ring.rotate(k2);
    expect(ring.active().length).toBe(2);
    now += 1000;
    expect(ring.active().length).toBe(1);
  });
});
