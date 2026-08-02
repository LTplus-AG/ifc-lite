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
});
