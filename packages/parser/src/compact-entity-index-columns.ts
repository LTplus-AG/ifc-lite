/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plain-data column representation of a `CompactEntityIndex`. Holds the
 * four numeric backing arrays plus a copied type-string list. Numeric backing
 * remains valid until its owner detaches it. Transport may transfer a retired
 * index; cache consumers must neither mutate nor detach the borrowed columns.
 */
export interface CompactEntityIndexColumns {
  expressIds: Uint32Array;
  byteOffsets: Uint32Array;
  byteLengths: Uint32Array;
  typeIndices: Uint16Array;
  typeStrings: string[];
}

/** Intern `type` into the parallel string table/lookup pair, returning the
 *  index the `Uint16Array` type column stores. */
export function internType(typeStrings: string[], typeStringMap: Map<string, number>, type: string): number {
  let index = typeStringMap.get(type);
  if (index === undefined) {
    index = typeStrings.length;
    typeStrings.push(type);
    typeStringMap.set(type, index);
  }
  return index;
}
