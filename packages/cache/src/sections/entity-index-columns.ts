/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CacheEntityIndex, CachedEntityIndexColumns } from '../types.js';

/** #3985: reuse validated numeric backing; retain generic iterable semantics. */
export function prepareBorrowedEntityColumns(byId: CacheEntityIndex['byId']): CachedEntityIndexColumns | undefined {
  if (typeof byId.getColumns !== 'function') return undefined;
  const c = byId.getColumns();
  if (!(c.expressIds instanceof Uint32Array) || !(c.byteOffsets instanceof Uint32Array)
    || !(c.byteLengths instanceof Uint32Array) || !(c.typeIndices instanceof Uint16Array)
    || !Array.isArray(c.typeStrings)) return undefined;
  const n = c.expressIds.length;
  if (c.byteOffsets.length !== n || c.byteLengths.length !== n || c.typeIndices.length !== n) return undefined;
  const remap = new Int32Array(Math.min(c.typeStrings.length, 0x10000)).fill(-1);
  const seen = new Map<string, number>();
  const typeNames: string[] = [];
  const typeIndices = new Uint16Array(n);
  for (let row = 0; row < n; row++) {
    if (row && c.expressIds[row] < c.expressIds[row - 1]) return undefined;
    const rawTypeIndex = c.typeIndices[row];
    if (rawTypeIndex >= c.typeStrings.length || typeof c.typeStrings[rawTypeIndex] !== 'string') return undefined;
    let index = remap[rawTypeIndex];
    if (index === -1) {
      const name = c.typeStrings[rawTypeIndex].toUpperCase();
      let existing = seen.get(name);
      if (existing === undefined) {
        existing = typeNames.length;
        if (existing > 0xffff) throw new Error('Entity index has more than 65535 unique IFC type names');
        typeNames.push(name);
        seen.set(name, existing);
      }
      index = existing;
      remap[rawTypeIndex] = index;
    }
    typeIndices[row] = index;
  }
  return { ids: c.expressIds, byteOffsets: c.byteOffsets, byteLengths: c.byteLengths, typeIndices, typeNames };
}
