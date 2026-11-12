/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Kept out of index.ts so a bundler can place the parser entry points (and the
// imported-geometry kernel they reach) apart from this tiny format sniffer.
import { safeUtf8Decode } from '@ifc-lite/data';

/** The first 24 bytes of every Rhino archive, ahead of its version digits. */
const RHINO_3DM_MAGIC = '3D Geometry File Format ';

/** True when the buffer starts with the Rhino archive magic. */
function isRhino3dm(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < RHINO_3DM_MAGIC.length) return false;
  const head = new Uint8Array(buffer, 0, RHINO_3DM_MAGIC.length);
  for (let i = 0; i < RHINO_3DM_MAGIC.length; i++) {
    if (head[i] !== RHINO_3DM_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Detect if a buffer contains IFCX (JSON), IFC (STEP), GLB (binary glTF) or
 * Rhino (.3dm) format.
 */
export function detectFormat(buffer: ArrayBuffer): 'ifcx' | 'ifc' | 'glb' | '3dm' | 'unknown' {
  // Check GLB magic bytes first (binary format, 4-byte magic: 0x46546C67 = 'glTF')
  if (buffer.byteLength >= 4) {
    const magic = new DataView(buffer).getUint32(0, true);
    if (magic === 0x46546c67) {
      return 'glb';
    }
  }

  // A Rhino archive is binary and its magic is ASCII, so it is read byte by
  // byte rather than through the decoder below: a .3dm otherwise fell through
  // to `unknown` and on into the IFC wasm path.
  if (isRhino3dm(buffer)) {
    return '3dm';
  }

  const bytes = new Uint8Array(buffer, 0, Math.min(100, buffer.byteLength));
  // SAB-safe: the upload entry path streams the file directly into a
  // SharedArrayBuffer for files ≥ STREAM_SAB_THRESHOLD, and both Firefox
  // and Chromium reject TextDecoder.decode() on SAB-backed views.
  const start = safeUtf8Decode(bytes).trim();

  // IFCX is JSON starting with {
  if (start.startsWith('{')) {
    return 'ifcx';
  }

  // IFC STEP starts with ISO-10303-21
  if (start.includes('ISO-10303-21') || start.startsWith('ISO')) {
    return 'ifc';
  }

  return 'unknown';
}
