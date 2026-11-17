/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Created on first use: module-level work would defeat the package's `sideEffects: false`.
let decoder: TextDecoder | undefined;

/**
 * UTF-8 decode a byte range. Copies first when the bytes sit on a
 * SharedArrayBuffer, which `TextDecoder.decode` rejects.
 */
export function decodeUtf8(bytes: Uint8Array, start = 0, end = bytes.byteLength): string {
  const view = bytes.subarray(start, end);
  const shared = typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer;
  decoder ??= new TextDecoder('utf-8');
  return decoder.decode(shared ? view.slice() : view);
}

/** True for the padding bytes writers put after a JSON chunk: space, tab, CR, LF and NUL. */
function isPadding(b: number): boolean {
  return b === 0x20 || b === 0x00 || b === 0x0a || b === 0x0d || b === 0x09;
}

/**
 * Parse a JSON chunk, tolerating the trailing space and NUL padding 3D Tiles
 * and glTF allow. The padding is trimmed by a single backwards byte scan: a
 * trailing-whitespace regex backtracks quadratically over a long whitespace
 * run that is not at the end (1 MiB of spaces then one byte took minutes).
 */
export function parseJsonChunk(bytes: Uint8Array, start: number, end: number): unknown {
  let e = end;
  while (e > start && isPadding(bytes[e - 1])) e--;
  return e === start ? undefined : JSON.parse(decodeUtf8(bytes, start, e));
}

/** Own-property lookup in a constant table, so a file-supplied key such as `constructor` cannot hit `Object.prototype`. */
export function own<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** A non-negative safe integer, as every count, length and offset read from a file must be. */
export function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Four-character magic at `offset`, or '' when out of range. */
export function magicAt(bytes: Uint8Array, offset = 0): string {
  if (bytes.byteLength < offset + 4) return '';
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}
