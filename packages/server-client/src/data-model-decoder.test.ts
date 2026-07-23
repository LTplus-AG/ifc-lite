// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract tests for `ServerEntityIndex` (issue #1841).
 *
 * It replaces a `Map<number, EntityMetadata>` that hit V8's ~2^24 entry ceiling
 * on huge models. The replacement is only safe if it stays Map-compatible for
 * every consumer, so these tests pin lookup, iteration order, and the row
 * materialization that turns columns back into `EntityMetadata`.
 */

import { describe, it, expect } from 'vitest';
import { ServerEntityIndex, type EntityMetadata } from './data-model-decoder.js';

const rows: EntityMetadata[] = [
  {
    entity_id: 300,
    type_name: 'IfcWall',
    global_id: 'GUID-300',
    name: 'Wall A',
    description: 'outer leaf',
    object_type: 'Basic',
    tag: 'T300',
    predefined_type: 'STANDARD',
    has_geometry: true,
  },
  { entity_id: 100, type_name: 'IfcSlab', global_id: 'GUID-100', has_geometry: true },
  { entity_id: 200, type_name: 'IfcSpace', has_geometry: false },
];

describe('ServerEntityIndex', () => {
  it('looks up every entity regardless of emission order', () => {
    const index = ServerEntityIndex.fromRows(rows);
    expect(index.size).toBe(3);
    for (const row of rows) {
      expect(index.has(row.entity_id)).toBe(true);
      expect(index.get(row.entity_id)?.type_name).toBe(row.type_name);
    }
  });

  it('returns undefined / -1 for an id that is not present', () => {
    const index = ServerEntityIndex.fromRows(rows);
    expect(index.get(999)).toBeUndefined();
    expect(index.has(999)).toBe(false);
    expect(index.rowIndexOf(999)).toBe(-1);
  });

  it('binary-searches an unsorted column set back to the right ROW', () => {
    const index = ServerEntityIndex.fromRows(rows);
    // Emission order is 300, 100, 200 — rowIndexOf must return the row in the
    // ORIGINAL column order, not the sorted position.
    expect(index.rowIndexOf(300)).toBe(0);
    expect(index.rowIndexOf(100)).toBe(1);
    expect(index.rowIndexOf(200)).toBe(2);
    expect(index.columns.expressId[index.rowIndexOf(200)]).toBe(200);
  });

  it('takes the no-permutation fast path when ids arrive sorted', () => {
    const sorted = [...rows].sort((a, b) => a.entity_id - b.entity_id);
    const index = ServerEntityIndex.fromRows(sorted);
    expect(index.rowIndexOf(100)).toBe(0);
    expect(index.rowIndexOf(200)).toBe(1);
    expect(index.rowIndexOf(300)).toBe(2);
  });

  it('round-trips every optional field, mapping empty/absent to undefined', () => {
    const index = ServerEntityIndex.fromRows(rows);
    expect(index.get(300)).toEqual(rows[0]);

    const sparse = index.get(200)!;
    expect(sparse.entity_id).toBe(200);
    expect(sparse.type_name).toBe('IfcSpace');
    expect(sparse.global_id).toBeUndefined();
    expect(sparse.name).toBeUndefined();
    expect(sparse.has_geometry).toBe(false);
  });

  it('iterates in row order and stays Map-compatible', () => {
    const index = ServerEntityIndex.fromRows(rows);

    expect([...index.keys()]).toEqual([300, 100, 200]);
    expect([...index.values()].map((e) => e.entity_id)).toEqual([300, 100, 200]);
    expect([...index].map(([id]) => id)).toEqual([300, 100, 200]);
    expect([...index.entries()].map(([id, e]) => [id, e.entity_id])).toEqual([
      [300, 300],
      [100, 100],
      [200, 200],
    ]);

    const seen: number[] = [];
    index.forEach((value, key) => {
      expect(value.entity_id).toBe(key);
      seen.push(key);
    });
    expect(seen).toEqual([300, 100, 200]);
  });

  it('handles an empty model without throwing', () => {
    const index = ServerEntityIndex.fromRows([]);
    expect(index.size).toBe(0);
    expect(index.rowIndexOf(1)).toBe(-1);
    expect([...index]).toEqual([]);
  });
});
