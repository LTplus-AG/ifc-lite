/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RhinoReadError } from './types.js';

const MAGIC = '3D Geometry File Format ';
/** Rhino 8. rhino3dm 8.35.0 has not been tried on a newer archive. */
const NEWEST_ARCHIVE_VERSION = 80;

export const NOT_3DM_MESSAGE = 'Not a Rhino .3dm file, or the file is damaged.';

/**
 * Read the archive version from the 32-byte header without touching wasm:
 * the magic, then the version as right-aligned ASCII digits.
 */
export function readArchiveVersion(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 32) throw new RhinoReadError('not-3dm', NOT_3DM_MESSAGE);
  const header = String.fromCharCode(...bytes.subarray(0, 32));
  const version = header.slice(MAGIC.length).trim();
  if (!header.startsWith(MAGIC) || !/^\d{1,8}$/.test(version)) throw new RhinoReadError('not-3dm', NOT_3DM_MESSAGE);
  const archiveVersion = Number(version);
  if (archiveVersion > NEWEST_ARCHIVE_VERSION) {
    throw new RhinoReadError('newer-archive', `This file was saved by a newer Rhino (archive version ${archiveVersion}). In Rhino, save it as Rhino 8 or older.`);
  }
  return archiveVersion;
}

const END_OF_FILE_MARK = 0x7fff;

/**
 * True when the archive ends in its end-of-file mark, which states the file's
 * own length: the bytes were not cut short. This is the layout archives have
 * written since Rhino 5 (8-byte lengths); an older archive answers false.
 */
export function endsWithFileLength(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = bytes.byteLength;
  return size >= 20 && view.getUint32(size - 20, true) === END_OF_FILE_MARK
    && view.getBigUint64(size - 16, true) === 8n && view.getBigUint64(size - 8, true) === BigInt(size);
}
