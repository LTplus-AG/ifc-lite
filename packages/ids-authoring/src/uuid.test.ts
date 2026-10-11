/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { deriveId, isUuid, uuidv7 } from './uuid.js';

describe('uuidv7', () => {
  it('encodes the version, variant and millisecond timestamp (RFC 9562 §5.7)', () => {
    const ms = 0x0189_1234_5678;
    const id = uuidv7({ now: () => ms });
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(ms);
  });

  it('stays strictly increasing within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7({ now: () => 1_700_000_000_000 }));
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('deriveId', () => {
  it('is deterministic and salt-sensitive', () => {
    expect(deriveId('op-1', 'a')).toBe(deriveId('op-1', 'a'));
    expect(deriveId('op-1', 'a')).not.toBe(deriveId('op-1', 'b'));
    expect(deriveId('op-1', 'a')).not.toBe(deriveId('op-2', 'a'));
    // `seed + salt` concatenation must not collide across the boundary.
    expect(deriveId('ab', 'c')).not.toBe(deriveId('a', 'bc'));
  });

  it('produces version-8 UUIDs without collisions over 20k derivations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const id = deriveId('seed', String(i));
      expect(id[14]).toBe('8');
      seen.add(id);
    }
    expect(seen.size).toBe(20_000);
  });
});
