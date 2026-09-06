/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ScannedEntityColumns } from './entity-refs-from-index.js';
import { CompactEntityIndex } from './compact-entity-index.js';
import { yieldToEventLoop } from './yield-to-event-loop.js';

/** Select a stable subsequence without materializing EntityRefs (#3985).
 * The input is already sorted and validated by the shared pre-pass record walk.
 */
export async function selectEntityColumns(
  columns: ScannedEntityColumns,
  count: number,
  includeType?: (type: string) => boolean,
  rows?: readonly number[],
  chunkSize = 8192,
  budgetMs = 50,
): Promise<CompactEntityIndex> {
  const ids = new Uint32Array(count);
  const starts = new Uint32Array(count);
  const lengths = new Uint32Array(count);
  const types = new Uint16Array(count);
  const typeStrings: string[] = [];
  const remap = new Map<number, number>();
  const includedTypes = includeType ? columns.typeStrings.map(includeType) : undefined;
  const inputCount = rows ? rows.length : columns.expressIds.length;
  let chunkStart = performance.now();
  let out = 0;
  for (let at = 0; at < inputCount; at++) {
    if (at % chunkSize === 0 && performance.now() - chunkStart >= budgetMs) {
      await yieldToEventLoop();
      chunkStart = performance.now();
    }
    const row = rows ? rows[at] : at;
    const sourceType = columns.typeIndices[row];
    if (includedTypes && !includedTypes[sourceType]) continue;
    let type = remap.get(sourceType);
    if (type === undefined) {
      type = typeStrings.length;
      typeStrings.push(columns.typeStrings[sourceType]);
      remap.set(sourceType, type);
    }
    ids[out] = columns.expressIds[row];
    starts[out] = columns.byteOffsets[row];
    lengths[out] = columns.byteLengths[row];
    types[out] = type;
    out++;
  }
  return new CompactEntityIndex(ids, starts, lengths, types, typeStrings);
}
