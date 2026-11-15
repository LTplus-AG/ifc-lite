/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const decoder = new TextDecoder('utf-8');

/**
 * UTF-8 decode a byte range. Copies first when the bytes sit on a
 * SharedArrayBuffer, which `TextDecoder.decode` rejects.
 */
export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.byteLength): string {
  const view = bytes.subarray(start, end);
  const shared = typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer;
  return decoder.decode(shared ? view.slice() : view);
}

/** Parse a JSON chunk, tolerating the trailing space and NUL padding 3D Tiles and glTF allow. */
export function parseJsonChunk(bytes: Uint8Array, start: number, end: number): unknown {
  // eslint-disable-next-line no-control-regex -- strip NUL padding that some writers use instead of spaces
  const text = decodeUtf8(bytes, start, end).replace(/[\u0000\s]+$/, '');
  return text.length === 0 ? undefined : JSON.parse(text);
}

export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Four-character magic at `offset`, or '' when out of range. */
export function magicAt(bytes: Uint8Array, offset = 0): string {
  if (bytes.byteLength < offset + 4) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
