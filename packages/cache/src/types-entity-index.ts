/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface CacheEntityRef {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber?: number;
}

export interface CacheEntityIndex {
  byId: Iterable<[number, CacheEntityRef]> & {
    /** Optional borrowed columns equivalent to iteration; never mutated/transferred. */
    getColumns?(): {
      expressIds: Uint32Array;
      byteOffsets: Uint32Array;
      byteLengths: Uint32Array;
      typeIndices: Uint16Array;
      typeStrings: string[];
    };
  };
}

export interface CachedEntityIndexColumns {
  ids: Uint32Array;
  byteOffsets: Uint32Array;
  byteLengths: Uint32Array;
  typeIndices: Uint16Array;
  typeNames: string[];
}

