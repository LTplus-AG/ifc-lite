/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether bytes start like an ISO 10303-21 (STEP) exchange file, the only input
 * the small-file fast path meshes. A ZIP archive, IFCX or anything else named
 * `.ifc` is refused, and the load then meshes as usual. An optional UTF-8 BOM
 * and leading whitespace are allowed.
 */

const MAGIC = 'ISO-10303-21';

export function looksLikeStepSource(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && i < 64 && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  if (bytes.length - i < MAGIC.length) return false;
  for (let k = 0; k < MAGIC.length; k++) if (bytes[i + k] !== MAGIC.charCodeAt(k)) return false;
  return true;
}
