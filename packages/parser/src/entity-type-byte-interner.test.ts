/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest';
import { EntityTypeByteInterner } from './entity-type-byte-interner.js';
import { buildEntityRefsFromIndex } from './entity-refs-from-index.js';
import { contiguousSourceBytes } from './source-bytes.js';

describe('issue #3985 byte type interning', () => {
  it('compares every byte on hash collisions, including mixed case and raw non-ASCII', () => {
    const interner = new EntityTypeByteInterner();
    const spellings = ['IFCWALL', 'IFCWaLL', 'UNKNOWN', 'IFC\u00ffALL', ''];
    for (let round = 0; round < 2; round++) {
      for (const spelling of spellings) {
        const bytes = Uint8Array.from(spelling, character => character.charCodeAt(0));
        // Identical caller-supplied hashes represent the collision case. Hash
        // identity must never replace equality of the underlying type bytes.
        expect(interner.intern(bytes, 0, bytes.length, 23)).toBe(spelling);
      }
    }
  });

  it('bounds repeated colliding-token byte comparisons rather than growing quadratically', () => {
    const interner = new EntityTypeByteInterner();
    for (let i = 0; i < 9; i++) {
      const name = `TYPE_000${i}`;
      const bytes = new TextEncoder().encode(name);
      expect(interner.intern(bytes, 0, bytes.length, 1)).toBe(name);
    }
    const name = 'TYPE_0009';
    const raw = new TextEncoder().encode(name);
    let reads = 0;
    const bytes = new Proxy(raw, {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, target);
      },
    });
    expect(interner.intern(bytes, 0, raw.length, 1)).toBe(name);
    // The saturated bucket reads this token once to obtain the native Map
    // key. Removing the collision cap instead repeats the long shared prefix
    // against every prior token, violating this work bound.
    expect(reads).toBeLessThanOrEqual(raw.length);
    expect(interner.intern(raw, 0, raw.length, 1)).toBe(name);
  });

  it('continues exact lookup after a high-cardinality source exceeds the fast dictionary budget', () => {
    const interner = new EntityTypeByteInterner();
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 4200; i++) {
        const name = `UNKNOWN_${i}`;
        const bytes = new TextEncoder().encode(name);
        expect(interner.intern(bytes, 0, bytes.length, i)).toBe(name);
      }
    }
  });

  it('keeps record-relative spans for a sliced input and the source-accessor read path', () => {
    const recordA = Uint8Array.from([...new TextEncoder().encode('#2=\tIfcWall($);')]);
    const recordB = Uint8Array.from([35, 49, 61, 73, 70, 67, 255, 40, 36, 41, 59]);
    const storage = new Uint8Array(recordA.length + recordB.length + 11);
    storage.set(recordA, 5);
    storage.set(recordB, 5 + recordA.length);
    const source = storage.subarray(5, 5 + recordA.length + recordB.length);
    const ids = Uint32Array.of(2, 1);
    const starts = Uint32Array.of(0, recordA.length);
    const lengths = Uint32Array.of(recordA.length, recordB.length);
    const expected = [
      { expressId: 1, type: 'IFC\u00ff', byteOffset: recordA.length, byteLength: recordB.length, lineNumber: 0 },
      { expressId: 2, type: 'IfcWall', byteOffset: 0, byteLength: recordA.length, lineNumber: 0 },
    ];
    expect(buildEntityRefsFromIndex(source, ids, starts, lengths)).toEqual(expected);
    const accessor = contiguousSourceBytes(source);
    const read = vi.spyOn(accessor, 'slice');
    expect(buildEntityRefsFromIndex(accessor, ids, starts, lengths)).toEqual(expected);
    expect(read.mock.calls).toEqual([[recordA.length, source.length], [0, recordA.length]]);
  });
});
