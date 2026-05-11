/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * E57 file header + page-CRC handling.
 *
 * The file is divided into `pageSize`-byte physical pages, each
 * carrying a 4-byte CRC32-C tail. XML offsets and binary-section
 * offsets in the XML reference the LOGICAL byte stream — i.e. with
 * those CRC tails stripped. Everything in this module helps callers
 * convert between the two views.
 */

const E57_MAGIC = 'ASTM-E57';

export interface E57FileHeader {
  majorVersion: number;
  minorVersion: number;
  fileLogicalSize: number;
  xmlLogicalOffset: number;
  xmlLogicalLength: number;
  pageSize: number;
}

/** Read the 48-byte FileHeader. Throws on bad magic. */
export function parseE57FileHeader(bytes: Uint8Array): E57FileHeader {
  if (bytes.length < 48) throw new Error('E57: header truncated (need 48 bytes)');
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== E57_MAGIC) {
    throw new Error(`E57: bad magic "${magic}" (expected "${E57_MAGIC}")`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    majorVersion: view.getUint32(8, true),
    minorVersion: view.getUint32(12, true),
    fileLogicalSize: readU64LE(view, 16),
    // Physical XML offset → we convert to logical below; xmlLogicalLength
    // is the byte length AFTER stripping page CRCs.
    xmlLogicalOffset: physicalToLogical(readU64LE(view, 24), readU64LE(view, 40)),
    xmlLogicalLength: readU64LE(view, 32),
    pageSize: readU64LE(view, 40),
  };
}

/**
 * Strip the 4-byte CRC tail from each `pageSize`-byte physical page.
 *
 * Returns a freshly-allocated buffer of "logical" bytes — the form that
 * XML offsets and CompressedVector data offsets reference.
 *
 * `pageSize` is read from the header and is conventionally 1024.
 */
export function stripPageCrc(bytes: Uint8Array, pageSize: number): Uint8Array {
  if (pageSize <= 4) throw new Error('E57: pageSize too small');
  const payloadPerPage = pageSize - 4;
  const fullPages = Math.floor(bytes.length / pageSize);
  const tail = bytes.length - fullPages * pageSize;
  // Trailing partial page (if any) still carries 4 CRC bytes when complete;
  // when the file ends mid-page we can't trust those tail bytes, so we
  // stop at the last complete page boundary.
  const out = new Uint8Array(fullPages * payloadPerPage + Math.max(0, tail - 4));
  let dst = 0;
  for (let p = 0; p < fullPages; p++) {
    const src = p * pageSize;
    out.set(bytes.subarray(src, src + payloadPerPage), dst);
    dst += payloadPerPage;
  }
  if (tail > 4) {
    const src = fullPages * pageSize;
    out.set(bytes.subarray(src, src + tail - 4), dst);
  }
  return out;
}

/** Convert a physical (CRC-paged) offset to the equivalent logical offset. */
export function physicalToLogical(physical: number, pageSize: number): number {
  const payloadPerPage = pageSize - 4;
  const pages = Math.floor(physical / pageSize);
  const within = physical - pages * pageSize;
  return pages * payloadPerPage + within;
}

/**
 * Read a CompressedVector binary-section header (E57 spec §6.4.2) and
 * return the LOGICAL byte offset where its DataPackets actually start.
 *
 * Layout (32 bytes):
 *   [ 0]  u8     sectionId           (must == 1 for CompressedVector)
 *   [ 1]  u8[7]  reserved
 *   [ 8]  u64 LE sectionLogicalLength
 *   [16]  u64 LE dataPhysicalOffset
 *   [24]  u64 LE indexPhysicalOffset
 *
 * The XML's `points@fileOffset` points at this section header — NOT at
 * the first DataPacket. Reading packets straight at `fileOffset` puts
 * the parser ~32 bytes off and the first u16 it reads is the low half
 * of `sectionLogicalLength`, which usually decodes as a bytestreamCount
 * of 0 (matched the user-reported `bytestreamCount (0) ≠ prototype
 * length (7)` error exactly).
 */
export function resolveCompressedVectorDataOffset(
  logical: Uint8Array,
  physicalSectionOffset: number,
  pageSize: number,
): number {
  const sectionLogical = physicalToLogical(physicalSectionOffset, pageSize);
  if (sectionLogical + 32 > logical.length) {
    throw new Error(
      `E57: CompressedVector section header at logical ${sectionLogical} runs past end of file (length ${logical.length})`,
    );
  }
  const view = new DataView(logical.buffer, logical.byteOffset + sectionLogical, 32);
  const sectionId = view.getUint8(0);
  if (sectionId !== 1) {
    throw new Error(
      `E57: expected CompressedVector section (id=1) at physical ${physicalSectionOffset}, got id=${sectionId}`,
    );
  }
  const dataPhysicalOffset = readU64LE(view, 16);
  return physicalToLogical(dataPhysicalOffset, pageSize);
}

export function readU64LE(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x100000000 + lo;
}
