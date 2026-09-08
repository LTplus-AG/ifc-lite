/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Worker-boundary transport for `CompactEntityIndex`.
 *
 * Split out of `data-store-transport.ts`: this is the one piece of that
 * module that deals with a single class (`CompactEntityIndex`) rather than
 * the `IfcDataStore` as a whole, so it stands on its own as a cohesive unit.
 */

import { CompactEntityIndex } from './compact-entity-index.js';

import type { CompactEntityIndexColumns } from './compact-entity-index-columns.js';
export type { CompactEntityIndexColumns } from './compact-entity-index-columns.js';

export function compactEntityIndexToColumns(index: CompactEntityIndex): CompactEntityIndexColumns {
  return index.getColumns();
}

export function compactEntityIndexFromColumns(columns: CompactEntityIndexColumns): CompactEntityIndex {
  return new CompactEntityIndex(
    columns.expressIds,
    columns.byteOffsets,
    columns.byteLengths,
    columns.typeIndices,
    columns.typeStrings,
  );
}
