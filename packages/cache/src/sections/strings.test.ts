/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The StringTable is serialized positionally (by index). The read path must
 * therefore preserve positions. The old read re-interned each string, which
 * DEDUPES, so a table that legitimately held a duplicate string would collapse
 * it and shift every later index on reload — corrupting all StringTable-indexed
 * lookups. `readStrings` now rebuilds via `StringTable.fromArray`, keeping every
 * slot.
 */

import { describe, it, expect } from 'vitest';
import { StringTable } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { writeStrings, readStrings } from './strings.js';

function roundTrip(table: StringTable): StringTable {
    const writer = new BufferWriter();
    writeStrings(writer, table);
    return readStrings(new BufferReader(writer.build()));
}

describe('StringTable section round-trip', () => {
    it('preserves positions for a table containing a duplicate string', () => {
        // Index 1 and 3 are both 'foo'. A dedup-on-read would collapse index 3
        // and shift 'baz' from 4 -> 3, breaking every later index.
        const original = StringTable.fromArray(['', 'foo', 'bar', 'foo', 'baz']);
        const restored = roundTrip(original);

        expect(restored.count).toBe(original.count);
        for (let i = 0; i < original.count; i++) {
            expect(restored.get(i)).toBe(original.get(i));
        }
        // Spell out the load-bearing slots.
        expect(restored.get(1)).toBe('foo');
        expect(restored.get(3)).toBe('foo');
        expect(restored.get(4)).toBe('baz');
    });

    it('round-trips a normal (deduped) table unchanged', () => {
        const original = new StringTable();
        original.intern('alpha');
        original.intern('beta');
        original.intern('gamma');
        const restored = roundTrip(original);
        expect(restored.getAll()).toEqual(original.getAll());
    });

    it('rejects a corrupt offset table instead of silently bleeding one string into another', () => {
        // `readStrings` slices each string out of the shared data blob via
        // `data.subarray(offsets[i], offsets[i + 1])`. `subarray` SATURATES
        // instead of throwing, so a corrupt/non-monotonic offset table (disk
        // corruption, a truncated transfer, a hand-crafted cache) makes one
        // string silently absorb the next string's bytes instead of erroring —
        // the same "declared length trusted without a bounds check" shape as
        // the packed-geometry-pool and LAS-strided-read bugs.
        // fromArray canonically prepends '' at index 0 (see property-table-list-values.test.ts),
        // so this table is ['', 'XX', 'SECRET'] with cumulative offsets [0, 0, 2, 8].
        const original = StringTable.fromArray(['XX', 'SECRET']);
        const writer = new BufferWriter();
        writeStrings(writer, original);
        const bytes = new Uint8Array(writer.build());

        // Layout: count(u32) offsets(u32 x (count+1)) data. offsets[2] is the
        // boundary between string 1 ("XX", 2 bytes) and string 2 ("SECRET", 6
        // bytes); it sits at byte 4 + 2*4 = 12. Corrupt it from 2 to a value
        // PAST the end of the 8-byte data blob (`subarray` saturates instead
        // of throwing), so string 1's declared range would silently absorb
        // string 2's bytes in full and string 2 would decode as empty.
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(view.getUint32(12, true)).toBe(2);
        view.setUint32(12, 500, true);

        expect(() => readStrings(new BufferReader(bytes.buffer))).toThrow(
            /Corrupt cache StringTable/,
        );
    });

    // Monotonicity compares each offset with its PREDECESSOR, so it can never
    // anchor offset 0: shifting EVERY offset by the same amount keeps the
    // table perfectly monotonic while every string is read from the wrong
    // place. The external anchor is literal zero.
    it('rejects an offset table shifted wholesale (monotonic, but not starting at zero)', () => {
      const table = new StringTable();
      table.intern('XX');
      table.intern('SECRET');
      const writer = new BufferWriter();
      writeStrings(writer, table);
      const bytes = new Uint8Array(writer.build());
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      // count(u32) then (count+1) u32 offsets. Move ONLY the first off zero,
      // leaving the rest — and therefore the total data length — untouched.
      // Shifting every offset instead would push the last past the blob and
      // trip BufferReader's own short-read guard first, which would make this
      // test pass for the wrong reason.
      dv.setUint32(4, 1, true);

      expect(() => readStrings(new BufferReader(bytes.buffer))).toThrow(
        /first offset is 1, expected 0/,
      );
    });

    it('rejects a nonzero offsets[0] even when count is 0 (bounding a corrupt count field, not just a corrupt offset table)', () => {
      // `StringTable` always writes at least one slot (the canonical empty
      // string), so `writeStrings` never actually emits `count === 0` — this
      // guards the byte format itself, not that class's invariant. A
      // corrupt/hand-crafted cache can still set the `count` field to 0
      // directly. The old `count > 0 && …` guard skipped validation
      // entirely in that case, and with the monotonicity loop below also a
      // no-op (it iterates `count` times), `totalBytes = offsets[count]` —
      // i.e. `offsets[0]` — flowed unchecked into
      // `reader.readBytes(totalBytes)`, silently consuming that many bytes
      // of whatever data follows (e.g. the next cache section) as if it were
      // this (nonexistent) table's string data, desyncing every read after
      // it with no error at all. Hand-craft that buffer directly, since no
      // writer in this codebase produces it: count(u32)=0, offsets(u32 x 1,
      // i.e. offsets[0]) = garbage, followed by bytes standing in for a
      // subsequent section.
      const buf = new ArrayBuffer(4 + 4 + 500);
      const dv = new DataView(buf);
      dv.setUint32(0, 0, true); // count = 0
      dv.setUint32(4, 500, true); // offsets[0] = 500 (garbage; must be 0)
      for (let i = 0; i < 500; i++) dv.setUint8(8 + i, 0xaa);

      expect(() => readStrings(new BufferReader(buf))).toThrow(
        /Corrupt cache StringTable: first offset is 500, expected 0/,
      );
    });

    it('accepts an offset table whose last string reaches exactly to the end of the data blob (bounding control)', () => {
        // A valid table's final offset always equals the data blob's length —
        // this must keep working, otherwise the guard above would reject every
        // legitimate table, not just corrupt ones.
        const original = StringTable.fromArray(['a', 'bb', 'ccc']);
        const restored = roundTrip(original);
        expect(restored.getAll()).toEqual(original.getAll());
    });
});
