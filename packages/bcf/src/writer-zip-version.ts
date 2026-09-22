/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Patch the "version needed to extract" field JSZip writes into every ZIP
 * entry (#3612).
 *
 * JSZip's `ZipFileWorker` hardcodes that field to 0x000A (1.0) for every
 * entry, in both the local file header and the central directory header,
 * regardless of compression method — there is no `generateAsync` option to
 * change it (`ZipFileWorker.js:206-207`). The ZIP APPNOTE (6.3.3, section
 * 4.4.3) requires 0x0014 (2.0) once method 8 (DEFLATE) is used, which the
 * BCF writer always requests, so the archives this package writes are out
 * of spec on their own terms regardless of what any particular reader does
 * with them. Found while investigating #3612, a report of BCF import
 * failures against other software; whether this specifically explains the
 * Solibri failure reported there is not established.
 *
 * This walks the ZIP's own structure — EOCD -> central directory entries ->
 * each entry's local header offset — rather than scanning the buffer for the
 * 0x04034b50 / 0x02014b50 signature bytes. A blind scan is unsafe here: the
 * signature bytes can recur inside DEFLATE-compressed entry data (they are
 * an ordinary 4-byte pattern to the compressor), so only offsets reached by
 * walking the documented structure can be trusted as real header starts.
 */

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIRECTORY_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const VERSION_NEEDED_DEFLATE = 0x0014;

/**
 * Locate the End Of Central Directory record. It sits at the end of the
 * file, followed only by an optional comment (max 65535 bytes), so scanning
 * backward from the end for its signature is the standard, safe way to find
 * it — nothing else in a ZIP produced by JSZip can contain this signature
 * within that trailing window other than the record itself, because the
 * comment length that precedes it in a genuine EOCD is cross-checked below.
 */
function findEndOfCentralDirectory(buf: Uint8Array): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const minPos = Math.max(0, buf.length - EOCD_MIN_SIZE - 65535);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= minPos; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      const commentLength = view.getUint16(i + 20, true);
      if (i + EOCD_MIN_SIZE + commentLength === buf.length) {
        return i;
      }
    }
  }
  throw new Error('BCF writer: could not locate ZIP end-of-central-directory record');
}

/**
 * Patch every entry's "version needed to extract" field (local file header
 * offset +4, central directory header offset +6) from 0x000A to 0x0014,
 * for the DEFLATE-compressed entries JSZip always produces here.
 *
 * The input Blob's bytes are never mutated in place through the Blob API
 * (Blobs are immutable); a copy is made, patched, and returned as a new
 * Blob of the same type.
 */
export async function fixZipVersionNeeded(blob: Blob): Promise<Blob> {
  const original = new Uint8Array(await blob.arrayBuffer());
  const buf = original.slice(); // mutable copy
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const eocdOffset = findEndOfCentralDirectory(buf);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  let pos = centralDirectoryOffset;
  for (let i = 0; i < entryCount; i++) {
    const sig = view.getUint32(pos, true);
    if (sig !== CENTRAL_DIRECTORY_SIG) {
      throw new Error(
        `BCF writer: expected central directory signature at 0x${pos.toString(16)}, got 0x${sig.toString(16)}`
      );
    }
    const method = view.getUint16(pos + 10, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    // Only DEFLATE entries require 2.0; leave any other method's field as-is.
    // In practice every BCF writer entry is DEFLATE (see writer.ts), so this
    // is a defensive check rather than a live branch.
    if (method === 8) {
      view.setUint16(pos + 6, VERSION_NEEDED_DEFLATE, true); // central directory header

      const localSig = view.getUint32(localHeaderOffset, true);
      if (localSig !== LOCAL_FILE_HEADER_SIG) {
        throw new Error(
          `BCF writer: expected local file header signature at 0x${localHeaderOffset.toString(16)}, got 0x${localSig.toString(16)}`
        );
      }
      view.setUint16(localHeaderOffset + 4, VERSION_NEEDED_DEFLATE, true); // local file header
    }

    pos += 46 + nameLength + extraLength + commentLength;
  }

  return new Blob([buf], { type: blob.type });
}
