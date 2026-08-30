/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EntityTable.typeRanges` changed in #3101 from `start + count` to a
 * `[firstRow, lastRow + 1]` span. `FORMAT_VERSION` was deliberately not
 * bumped (`header.ts` throws only on `version > FORMAT_VERSION`, so older
 * caches are accepted by design), so a cache written before #3101 still
 * deserializes `start + count` triples. `readEntities` used to hand those
 * straight to the public `EntityTable.typeRanges`.
 *
 * The two forms COINCIDE whenever a type happens to occupy contiguous rows,
 * which is exactly what kept the divergence invisible — every fixture here
 * therefore interleaves its types.
 */

import { describe, it, expect } from 'vitest';
import { StringTable, IfcTypeEnum, entityTableFromColumns } from '@ifc-lite/data';
import type { EntityTable } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { writeEntities, readEntities } from './entities.js';

/**
 * Rows 0/2/4 are IfcWall, rows 1/3 are IfcSpace — neither type is contiguous.
 *   span semantics:        Wall [0, 5), Space [1, 4)
 *   pre-#3101 start+count: Wall  0 + 3,  Space  1 + 2
 * Both fields differ for both types, so no assertion below can be satisfied
 * by the wrong form.
 */
const INTERLEAVED_TYPES: readonly IfcTypeEnum[] = [
  IfcTypeEnum.IfcWall,
  IfcTypeEnum.IfcSpace,
  IfcTypeEnum.IfcWall,
  IfcTypeEnum.IfcSpace,
  IfcTypeEnum.IfcWall,
];

function columnsFor(types: readonly IfcTypeEnum[], strings: StringTable) {
  const count = types.length;
  const globalId = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    globalId[i] = strings.intern(`gid-${i}`);
  }
  return {
    count,
    expressId: Uint32Array.from(types.map((_t, i) => (i + 1) * 10)),
    typeEnum: Uint16Array.from(types),
    globalId,
    name: new Uint32Array(count),
    description: new Uint32Array(count),
    objectType: new Uint32Array(count),
    flags: new Uint8Array(count),
    containedInStorey: new Int32Array(count).fill(-1),
    definedByType: new Int32Array(count).fill(-1),
    geometryIndex: new Int32Array(count).fill(-1),
  };
}

/**
 * Serialize a section whose type-range triples carry the SUPPLIED values, then
 * hydrate it. `entityTableFromColumns` prefers supplied `typeRanges` over the
 * ones it would derive, so passing pre-#3101 `start + count` pairs produces
 * byte-for-byte the payload an old writer produced — the layout never changed,
 * only the meaning of the third field.
 */
function hydrate(
  types: readonly IfcTypeEnum[],
  stored: Map<IfcTypeEnum, { start: number; end: number }>,
): { table: EntityTable; strings: StringTable } {
  const strings = new StringTable();
  const columns = columnsFor(types, strings);
  const source = entityTableFromColumns({ ...columns, typeRanges: stored }, strings);
  const writer = new BufferWriter();
  writeEntities(writer, source);
  return { table: readEntities(new BufferReader(writer.build()), strings), strings };
}

function hydrateTable(
  types: readonly IfcTypeEnum[],
  stored: Map<IfcTypeEnum, { start: number; end: number }>,
): EntityTable {
  return hydrate(types, stored).table;
}

/** The pre-#3101 `start + count` triples for the interleaved fixture. */
function oldStartPlusCount(): Map<IfcTypeEnum, { start: number; end: number }> {
  return new Map([
    [IfcTypeEnum.IfcWall, { start: 0, end: 3 }],
    [IfcTypeEnum.IfcSpace, { start: 1, end: 2 }],
  ]);
}

/** The post-#3101 spans for the same fixture. */
function newSpans(): Map<IfcTypeEnum, { start: number; end: number }> {
  return new Map([
    [IfcTypeEnum.IfcWall, { start: 0, end: 5 }],
    [IfcTypeEnum.IfcSpace, { start: 1, end: 4 }],
  ]);
}

describe('readEntities derives typeRanges instead of trusting the stored triples', () => {
  it('gives span semantics for a pre-#3101 cache with interleaved types', () => {
    const table = hydrateTable(INTERLEAVED_TYPES, oldStartPlusCount());

    // Positions, not a count and not a sum: `a + b = whole` has many wrong
    // solutions. IfcWall's last row is 4, so its span must end at 5 — the
    // stored triple said 3.
    expect(table.typeRanges.get(IfcTypeEnum.IfcWall)).toEqual({ start: 0, end: 5 });
    expect(table.typeRanges.get(IfcTypeEnum.IfcSpace)).toEqual({ start: 1, end: 4 });
  });

  it('gives the same answer for a post-#3101 cache whose triples are already spans', () => {
    const table = hydrateTable(INTERLEAVED_TYPES, newSpans());

    expect(table.typeRanges.get(IfcTypeEnum.IfcWall)).toEqual({ start: 0, end: 5 });
    expect(table.typeRanges.get(IfcTypeEnum.IfcSpace)).toEqual({ start: 1, end: 4 });
  });

  it('lands on one answer whichever vintage wrote the cache', () => {
    const fromOld = hydrateTable(INTERLEAVED_TYPES, oldStartPlusCount());
    const fromNew = hydrateTable(INTERLEAVED_TYPES, newSpans());

    expect([...fromOld.typeRanges]).toEqual([...fromNew.typeRanges]);
  });

  it('covers every row of its type, and its endpoints are rows of that type', () => {
    const table = hydrateTable(INTERLEAVED_TYPES, oldStartPlusCount());

    for (const [type, range] of table.typeRanges) {
      for (let row = 0; row < table.count; row++) {
        if (table.typeEnum[row] !== type) continue;
        expect(row).toBeGreaterThanOrEqual(range.start);
        expect(row).toBeLessThan(range.end);
      }
      // The span is [first, last + 1], so both endpoints name rows of the type.
      expect(table.typeEnum[range.start]).toBe(type);
      expect(table.typeEnum[range.end - 1]).toBe(type);
    }
  });

  it('keeps getByType consistent with the derived spans', () => {
    const table = hydrateTable(INTERLEAVED_TYPES, oldStartPlusCount());

    expect(table.getByType(IfcTypeEnum.IfcWall)).toEqual([10, 30, 50]);
    expect(table.getByType(IfcTypeEnum.IfcSpace)).toEqual([20, 40]);
  });

  // --- what the displaced straight-through assignment used to do -----------

  it('gives a single-row type a one-wide span', () => {
    const types = [IfcTypeEnum.IfcWall, IfcTypeEnum.IfcDoor, IfcTypeEnum.IfcWall];
    const table = hydrateTable(
      types,
      new Map([
        [IfcTypeEnum.IfcWall, { start: 0, end: 2 }], // old: start 0, count 2
        [IfcTypeEnum.IfcDoor, { start: 1, end: 1 }], // old: start 1, count 1
      ]),
    );

    expect(table.typeRanges.get(IfcTypeEnum.IfcDoor)).toEqual({ start: 1, end: 2 });
    expect(table.typeRanges.get(IfcTypeEnum.IfcWall)).toEqual({ start: 0, end: 3 });
  });

  it('has no entry for a type absent from the table', () => {
    const table = hydrateTable(INTERLEAVED_TYPES, oldStartPlusCount());

    expect(table.typeRanges.has(IfcTypeEnum.IfcDoor)).toBe(false);
    expect(table.typeRanges.size).toBe(2);
  });

  it('drops a stored triple for a type that no row carries', () => {
    // Only a corrupt or hand-written cache can hold one: the builder records a
    // range from a row it saw. An empty range names no rows, so nothing is lost.
    const stored = oldStartPlusCount();
    stored.set(IfcTypeEnum.IfcBeam, { start: 2, end: 0 });
    const table = hydrateTable(INTERLEAVED_TYPES, stored);

    expect(table.typeRanges.has(IfcTypeEnum.IfcBeam)).toBe(false);
    expect([...table.typeRanges.keys()]).toEqual([IfcTypeEnum.IfcWall, IfcTypeEnum.IfcSpace]);
  });

  it('returns an empty map for an empty table', () => {
    const table = hydrateTable([], new Map());

    expect(table.count).toBe(0);
    expect(table.typeRanges.size).toBe(0);
  });

  it('orders the map by first appearance in the type column', () => {
    // The straight-through assignment kept the serialized order; the derivation
    // keeps first-appearance order. They agree for anything the builder wrote,
    // and this pins the order the derivation guarantees even when the stored
    // triples arrive in the other order.
    const stored = new Map([
      [IfcTypeEnum.IfcSpace, { start: 1, end: 2 }],
      [IfcTypeEnum.IfcWall, { start: 0, end: 3 }],
    ]);
    const table = hydrateTable(INTERLEAVED_TYPES, stored);

    expect([...table.typeRanges.keys()]).toEqual([IfcTypeEnum.IfcWall, IfcTypeEnum.IfcSpace]);
  });

  it('reads a v14 section, which has no rawTypeName column, without running past its end', () => {
    // A v15 payload is a v14 payload plus a trailing Uint32Array[count], so
    // dropping those bytes reproduces exactly what an old writer emitted.
    const strings = new StringTable();
    const columns = columnsFor(INTERLEAVED_TYPES, strings);
    const source = entityTableFromColumns({ ...columns, typeRanges: newSpans() }, strings);
    const writer = new BufferWriter();
    writeEntities(writer, source);
    const v15 = new Uint8Array(writer.build());
    const v14Length = v15.byteLength - INTERLEAVED_TYPES.length * 4;

    // Anti-vacuity: the column really is the only difference, and it is not
    // zero-width — otherwise this test would pass against an unchanged writer.
    expect(v15.byteLength - v14Length).toBe(INTERLEAVED_TYPES.length * 4);
    expect(v14Length).toBeGreaterThan(0);

    // Trailing bytes the reader must not touch. Reading the absent column
    // would consume them (and a shorter buffer would run off the end).
    const withTrailer = new Uint8Array(v14Length + 64);
    withTrailer.set(v15.subarray(0, v14Length), 0);
    withTrailer.fill(0xab, v14Length);

    const reader = new BufferReader(withTrailer.buffer);
    const table = readEntities(reader, strings, 14);

    expect(reader.position).toBe(v14Length);
    expect(table.count).toBe(INTERLEAVED_TYPES.length);
    expect(table.getTypeName(10)).toBe('IfcWall');
    expect(table.getTypeName(20)).toBe('IfcSpace');
  });

  it('round-trips the derived spans through a second write', () => {
    const { table: first, strings } = hydrate(INTERLEAVED_TYPES, oldStartPlusCount());
    const writer = new BufferWriter();
    writeEntities(writer, first);
    const second = readEntities(new BufferReader(writer.build()), strings);

    expect([...second.typeRanges]).toEqual([...first.typeRanges]);
  });
});
