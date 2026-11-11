/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane: `byType` from the cached entity-index columns is grouped by type
// index. Its contents AND its key order must equal the per-entity Map build it
// replaces (consumers iterate it).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CachedEntityIndexColumns } from '@ifc-lite/cache';
import { buildEntityIndexFromCachedColumns } from './ifcCacheDecode.js';

/** The previous build, verbatim. */
function reference(columns: CachedEntityIndexColumns): Map<string, number[]> {
  const byType = new Map<string, number[]>();
  for (let i = 0; i < columns.ids.length; i++) {
    const type = columns.typeNames[columns.typeIndices[i]];
    let ids = byType.get(type);
    if (!ids) { ids = []; byType.set(type, ids); }
    ids.push(columns.ids[i]);
  }
  return byType;
}

function columns(n: number, typeNames: string[], seed: number): CachedEntityIndexColumns {
  const ids = new Uint32Array(n); const typeIndices = new Uint16Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; ids[i] = i * 3 + 1; typeIndices[i] = s % typeNames.length; }
  return { ids, byteOffsets: new Uint32Array(n), byteLengths: new Uint32Array(n), typeIndices, typeNames };
}

const entries = (m: Map<string, number[]>) => [...m].map(([k, v]) => `${k}:${v.join(',')}`);

describe('entity index from cached columns: byType', () => {
  it('equals the per-entity build, contents and key order', () => {
    for (const seed of [1, 2, 3]) {
      const c = columns(5000, ['IFCWALL', 'IFCSLAB', 'IFCDOOR', 'IFCPROPERTYSET', 'IFCSPACE', 'IFCUNUSED'], seed);
      assert.deepEqual(entries(buildEntityIndexFromCachedColumns(c).byType), entries(reference(c)));
    }
  });

  it('equals it when two type indices share a name', () => {
    const c = columns(3000, ['IFCWALL', 'IFCSLAB', 'IFCWALL', 'IFCDOOR'], 9);
    assert.deepEqual(entries(buildEntityIndexFromCachedColumns(c).byType), entries(reference(c)));
  });

  it('is empty for no entities', () => {
    assert.equal(buildEntityIndexFromCachedColumns(columns(0, ['IFCWALL'], 1)).byType.size, 0);
  });
});
