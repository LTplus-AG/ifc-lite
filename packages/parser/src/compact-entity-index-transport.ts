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

/**
 * Plain-data column representation of a `CompactEntityIndex`. Holds the
 * five backing arrays plus the deduplicated type-string list. All four
 * typed arrays are transferable.
 */
export interface CompactEntityIndexColumns {
  expressIds: Uint32Array;
  byteOffsets: Uint32Array;
  byteLengths: Uint32Array;
  typeIndices: Uint16Array;
  typeStrings: string[];
}

export function compactEntityIndexToColumns(index: CompactEntityIndex): CompactEntityIndexColumns {
  // CompactEntityIndex stores its arrays as private fields; access them
  // through the prototype's documented columns. We rely on the public
  // constructor's parameter order to define this contract.
  const internal = index as unknown as {
    expressIds: Uint32Array;
    byteOffsets: Uint32Array;
    byteLengths: Uint32Array;
    typeIndices: Uint16Array;
    typeStrings: string[];
  };
  return {
    expressIds: internal.expressIds,
    byteOffsets: internal.byteOffsets,
    byteLengths: internal.byteLengths,
    typeIndices: internal.typeIndices,
    typeStrings: internal.typeStrings.slice(),
  };
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
