/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Kept out of index.ts so a bundler can place the parser entry points (and the
// imported-geometry kernel they reach) apart from this tiny format sniffer.
import { safeUtf8Decode } from '@ifc-lite/data';

/**
 * The first 24 bytes of every Rhino archive, ahead of its version digits. The
 * reader holds the same string, with the version check beside it
 * (`packages/rhino3dm/src/read/header.ts`); sharing it would mean a package
 * edge from this dependency-free sniffer.
 */
const RHINO_3DM_MAGIC = '3D Geometry File Format ';

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

  const bytes = new Uint8Array(buffer, 0, Math.min(100, buffer.byteLength));
  // SAB-safe: the upload entry path streams the file directly into a
  // SharedArrayBuffer for files ≥ STREAM_SAB_THRESHOLD, and both Firefox
  // and Chromium reject TextDecoder.decode() on SAB-backed views.
  const start = safeUtf8Decode(bytes).trim();

  // IFCX is JSON starting with {
  if (start.startsWith('{')) {
    return 'ifcx';
  }

  // A Rhino archive is binary, but its magic is ASCII and the decoder above is
  // non-fatal, so the first 24 characters survive whatever follows. Checked
  // before the STEP branch, because a binary tail can hold anything.
  if (start.startsWith(RHINO_3DM_MAGIC)) {
    return '3dm';
  }

  // IFC STEP starts with ISO-10303-21
  if (start.includes('ISO-10303-21') || start.startsWith('ISO')) {
    return 'ifc';
  }

  return 'unknown';
}
