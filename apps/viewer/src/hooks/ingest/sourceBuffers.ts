/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { countCopy } from '@ifc-lite/load-trace'; // #6957 full source-copy counters

/**
 * Source-buffer helpers for `useIfcLoader.loadFile`.
 *
 * The loader holds the file in ONE buffer: a SharedArrayBuffer when it was
 * streamed (large files), an ArrayBuffer otherwise. Several format paths
 * (archive unwrap, IFCX, GLB) take an `ArrayBuffer` parameter, and the loader
 * used to copy a streamed file into one unconditionally — for the ordinary
 * STEP load that copy was never read again, yet the cache-write closure kept it
 * alive for the session: a second full source copy (343 MB on the reference
 * model). These helpers make the copy happen only on the path that consumes it.
 */

/**
 * `buffer` as an `ArrayBuffer`, copying only when it is shared. Call this at
 * the consumer that needs the `ArrayBuffer` type, never ahead of the branch,
 * so a STEP load streamed into a SharedArrayBuffer pays no copy.
 */
export function sourceArrayBuffer(buffer: ArrayBuffer | SharedArrayBuffer, counter: string): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) return buffer;
  return countCopy(counter, new Uint8Array(buffer).slice().buffer);
}

/** Little-endian `PK\x03\x04`, the zip local-file-header signature. */
const ZIP_LOCAL_HEADER = 0x04034b50;

/**
 * Whether the file's leading bytes are a zip local-file header, read from the
 * small head slice the loader already holds rather than from the source. It is
 * the same signature `unwrapIfcZipWithResources` checks, so a `true` here is
 * exactly the case in which that call does work.
 */
export function headIsZip(head: ArrayBuffer): boolean {
  return head.byteLength >= 4 && new DataView(head).getUint32(0, true) === ZIP_LOCAL_HEADER;
}

/** Appearance input for a non-archive source: no sibling images. Never mutated. */
export const NO_ARCHIVE_IMAGES: { originalResources: Map<string, Uint8Array>; resourcesIncomplete: boolean } = {
  originalResources: new Map<string, Uint8Array>(),
  resourcesIncomplete: false,
};
