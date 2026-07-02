/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `.ifcZIP` container support (issue #1494).
 *
 * The buildingSMART IFC container format is a plain zip archive wrapping a
 * single `.ifc`/`.ifcxml` model file (optionally alongside referenced
 * resources like textures — those are ignored here, not extracted). This
 * module unwraps that container so the rest of the pipeline (parseAuto,
 * detectFormat, the various loaders) sees ordinary model bytes and never
 * has to know zip existed.
 */

import JSZip from 'jszip';

/** Little-endian `PK\x03\x04` — the local-file-header signature every
 *  standard zip archive starts with (including .ifcZIP/.bcfzip/.docx/...). */
const ZIP_MAGIC = 0x04034b50;

/** True if `buffer` starts with the zip local-file-header signature. */
export function isZipBuffer(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  return new DataView(buffer).getUint32(0, true) === ZIP_MAGIC;
}

/** Case-insensitive match for a model file entry inside the archive. */
const MODEL_ENTRY_RE = /\.(ifc|ifcxml)$/i;

/**
 * If `buffer` is a zip container, unwrap it and return the bytes of the
 * single `.ifc`/`.ifcxml` entry inside. Returns `buffer` UNCHANGED when it's
 * not a zip (cheap magic-byte check, no-op for every ordinary IFC/IFCX/GLB
 * file) — so callers can call this unconditionally on every load.
 *
 * Throws if the archive contains zero or more than one candidate model
 * entry — silently picking one would risk loading the wrong model.
 * Referenced resources (textures, documents) inside the container are not
 * extracted; only the model entry's bytes are returned.
 */
export async function unwrapIfcZip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isZipBuffer(buffer)) return buffer;

  // Wrap in a Uint8Array rather than passing `buffer` directly: some callers
  // (the browser streaming path) hand us a SharedArrayBuffer-backed view for
  // large files, which JSZip doesn't declare support for but a Uint8Array
  // over it reads identically to one over a plain ArrayBuffer.
  const zip = await JSZip.loadAsync(new Uint8Array(buffer));
  const candidates = Object.values(zip.files).filter(
    (entry) => !entry.dir && MODEL_ENTRY_RE.test(entry.name),
  );

  if (candidates.length === 0) {
    throw new Error(
      'This .ifcZIP archive contains no .ifc/.ifcxml entry — nothing to parse.',
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `This .ifcZIP archive contains ${candidates.length} model files ` +
      `(${candidates.map((c) => c.name).join(', ')}) — expected exactly one.`,
    );
  }

  return candidates[0].async('arraybuffer');
}
