/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type PointCloudFormat = 'las' | 'laz' | 'ply' | 'pcd' | 'e57' | 'pts' | 'xyz';

/**
 * Detect a supported point-cloud format from filename or magic bytes.
 * Returns null when the buffer isn't a recognised format.
 *
 * Magic-byte sniffing covers files renamed by users:
 *   - LAS:  "LASF" (0x4653414c)
 *   - PLY:  "ply\n" or "ply\r\n" at offset 0
 *   - PCD:  "# .PCD" or any `.PCD` token in first 32 bytes
 *   - LAZ:  shares LAS magic; we trust the extension here
 */
export function detectPointCloudFormat(
  fileName: string,
  buffer: ArrayBuffer | null,
): PointCloudFormat | null {
  // Magic bytes win over extension when both are available — a LAS
  // file dropped as `*.ply` should still load as LAS, not be forced
  // through the wrong decoder. PTS / XYZ are ASCII so they have no
  // distinctive magic and stay extension-only at the bottom.
  if (buffer && buffer.byteLength >= 8) {
    const view = new DataView(buffer, 0, Math.min(buffer.byteLength, 32));
    // E57 magic = "ASTM-E57" (8 bytes) — check before LAS so files
    // can't accidentally match on the LAS magic in their first 4 bytes.
    if (
      view.getUint8(0) === 0x41 && view.getUint8(1) === 0x53
      && view.getUint8(2) === 0x54 && view.getUint8(3) === 0x4d
      && view.getUint8(4) === 0x2d && view.getUint8(5) === 0x45
      && view.getUint8(6) === 0x35 && view.getUint8(7) === 0x37
    ) return 'e57';
    if (view.getUint32(0, true) === 0x4653414c /* "LASF" little-endian */) {
      // LAS and LAZ share the LASF magic; differentiate by extension
      // when available, otherwise default to LAS (laz-perf will throw
      // a clear error on a non-LAZ payload).
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.laz')) return 'laz';
      return 'las';
    }
    // ASCII probes: "ply" header / PCD header line.
    const b0 = view.getUint8(0), b1 = view.getUint8(1), b2 = view.getUint8(2);
    if (b0 === 0x70 /* p */ && b1 === 0x6c /* l */ && b2 === 0x79 /* y */) return 'ply';
    // PCDs in the wild use three header shapes:
    //   1. `# .PCD v0.7\n…`              — original commented header
    //   2. `VERSION 0.7\n…`              — version-first (PCL pcl_io)
    //   3. `FIELDS x y z\n…`             — fields-first (some converters)
    // Match all three so a renamed PCD doesn't fall through to the
    // extension-based detector.
    if (b0 === 0x23 /* # */ && view.byteLength > 4 && view.getUint8(2) === 0x2e /* . */) return 'pcd';
    if (
      b0 === 0x56 /* V */ && b1 === 0x45 /* E */ && b2 === 0x52 /* R */
      && view.byteLength > 7 && view.getUint8(3) === 0x53 /* S */
      && view.getUint8(4) === 0x49 /* I */ && view.getUint8(5) === 0x4f /* O */
      && view.getUint8(6) === 0x4e /* N */
    ) return 'pcd';
    if (
      b0 === 0x46 /* F */ && b1 === 0x49 /* I */ && b2 === 0x45 /* E */
      && view.byteLength > 6 && view.getUint8(3) === 0x4c /* L */
      && view.getUint8(4) === 0x44 /* D */ && view.getUint8(5) === 0x53 /* S */
    ) return 'pcd';
  }
  // Fall back to extension when the buffer is missing / too short
  // OR for ASCII formats (PTS / XYZ) that don't carry a magic header.
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.las')) return 'las';
  if (lower.endsWith('.laz')) return 'laz';
  if (lower.endsWith('.ply')) return 'ply';
  if (lower.endsWith('.pcd')) return 'pcd';
  if (lower.endsWith('.e57')) return 'e57';
  if (lower.endsWith('.pts')) return 'pts';
  if (lower.endsWith('.xyz')) return 'xyz';
  return null;
}
