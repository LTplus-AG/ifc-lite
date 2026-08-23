/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * entity-index.ts had no dedicated unit test: readEntityIndex's downstream
 * lookups (`typeNames[typeIndices[i]]`) silently yield `undefined` for a
 * corrupt typeIndex, so the function guards against that with an explicit
 * throw. Mutation testing showed that guard's reject path was asserted
 * nowhere — deleting it left the full cache suite (including cache.test.ts's
 * happy-path entity-index round-trip) green, because every existing test
 * only ever writes valid, in-range typeIndex values.
 */

import { describe, it, expect } from 'vitest';
import { writeEntityIndex, readEntityIndex } from './entity-index.js';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import type { CacheEntityIndex } from '../types.js';

function roundTrip(index: CacheEntityIndex) {
  const writer = new BufferWriter();
  writeEntityIndex(writer, index);
  return readEntityIndex(new BufferReader(writer.build()));
}

describe('EntityIndex section round-trip', () => {
  it('round-trips ids, byte ranges and type names for valid input', () => {
    const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>([
      [1, { expressId: 1, type: 'IFCWALL', byteOffset: 10, byteLength: 20, lineNumber: 0 }],
      [2, { expressId: 2, type: 'IFCSLAB', byteOffset: 30, byteLength: 15, lineNumber: 0 }],
    ]);
    const restored = roundTrip({ byId });

    expect(Array.from(restored.ids)).toEqual([1, 2]);
    expect(Array.from(restored.byteOffsets)).toEqual([10, 30]);
    expect(Array.from(restored.byteLengths)).toEqual([20, 15]);
    expect(restored.typeNames[restored.typeIndices[0]]).toBe('IFCWALL');
    expect(restored.typeNames[restored.typeIndices[1]]).toBe('IFCSLAB');
  });

  it('normalizes the type name to upper case and prefers a ref-supplied expressId over the map key', () => {
    // Both halves of `normalizeRef` were unobservable: every existing
    // fixture in this package already spells its type in upper case and
    // already sets `expressId` equal to the map key. Mutation testing
    // confirmed it — deleting `.toUpperCase()`, and replacing
    // `ref.expressId || id` with a bare `id`, each left the whole
    // `@ifc-lite/cache` suite green at 83/83.
    const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>([
      // Key 99, but the ref names itself 5 — the ref wins.
      [99, { expressId: 5, type: 'IFCSLAB', byteOffset: 30, byteLength: 15, lineNumber: 0 }],
      // Mixed case on the wire; and expressId 0 is falsy, so this row is
      // the one where the map key legitimately supplies the id.
      [7, { expressId: 0, type: 'IfcWall', byteOffset: 10, byteLength: 20, lineNumber: 0 }],
    ]);
    const restored = roundTrip({ byId });

    // Sorted by the NORMALIZED expressId: 5 (from key 99) then 7 (from the
    // key, the ref having none).
    expect(Array.from(restored.ids)).toEqual([5, 7]);
    expect(Array.from(restored.byteOffsets)).toEqual([30, 10]);
    expect(restored.typeNames[restored.typeIndices[0]]).toBe('IFCSLAB');
    expect(restored.typeNames[restored.typeIndices[1]]).toBe('IFCWALL');
  });

  it('rejects a typeIndex that points outside the typeNames table (corrupt/truncated cache)', () => {
    // Write a valid, single-type-name section, then corrupt the on-disk
    // typeIndices column so it addresses a type name that doesn't exist —
    // simulating truncation/corruption between the typeNames block and the
    // columnar arrays without hand-building the whole binary layout.
    const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>([
      [1, { expressId: 1, type: 'IFCWALL', byteOffset: 0, byteLength: 1, lineNumber: 0 }],
    ]);
    const writer = new BufferWriter();
    writeEntityIndex(writer, { byId });
    const bytes = new Uint8Array(writer.build());

    // Layout: count(u32) typeNameCount(u32) [typeName strings] ids[] byteOffsets[]
    // byteLengths[] typeIndices[u16]. With one entity and one type name, the
    // typeIndices column is the last 2 bytes of the buffer.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const corruptTypeIndex = 0xffff; // guaranteed out of range for a 1-entry typeNames table
    view.setUint16(bytes.byteLength - 2, corruptTypeIndex, true);

    expect(() => readEntityIndex(new BufferReader(bytes.buffer))).toThrow(
      /Corrupt cache entity-index: typeIndex \d+ at row \d+ exceeds typeNames length \d+/,
    );

    // Control: the untouched (truthful) buffer still reads cleanly — the
    // throw above is caused by the corruption, not the fixture itself.
    const clean = new Uint8Array(writer.build());
    expect(() => readEntityIndex(new BufferReader(clean.buffer))).not.toThrow();
  });
});
