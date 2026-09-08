/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Assembly of a whole ISO 10303-21 file from its already-serialized parts.
 *
 * One level above `step-serialization.ts`: nothing here looks at a value or a
 * token. It takes a finished header string and finished entity lines and joins
 * them into the delivered artifact — bytes for the callers that hand the file
 * to Rust or to a test, a `Blob` for the browser download path. The two must
 * stay byte-identical to each other, which is what their tests assert.
 *
 * Shared by the STEP and merged exporters (was duplicated byte-for-byte in
 * both — alignment audit).
 */

/**
 * Worst-case UTF-8 bytes per UTF-16 code unit: a lone BMP code unit needs at
 * most 3 bytes, and a surrogate pair (2 units) needs 4 bytes for its combined
 * codepoint — 2 bytes/unit, under the 3x bound. An unpaired surrogate is
 * replaced with U+FFFD (3 bytes) by both `TextEncoder` and `Blob`, which also
 * fits. `str.length * UTF8_WORST_CASE_BYTES_PER_UNIT` therefore always fits
 * the full encoding.
 */
const UTF8_WORST_CASE_BYTES_PER_UNIT = 3;

/**
 * Assemble a STEP file from header and entity lines as a Uint8Array.
 *
 * Two passes over `entities`, no intermediate per-entity byte arrays:
 * 1. `TextEncoder.encodeInto` each entity into a reusable (grow-on-demand)
 *    scratch buffer just to learn its exact encoded byte length — the
 *    scratch bytes themselves are discarded.
 * 2. Allocate the ONE final buffer sized from the lengths computed in pass 1,
 *    then `encodeInto` each entity directly into its slice.
 *
 * This replaces a previous single-pass version that kept a persistent
 * `Uint8Array[]` of every encoded entity alive simultaneously (a second full
 * copy of the file's content) purely to learn the sizes needed to allocate
 * the final buffer. Output is byte-identical to that version.
 */
export function assembleStepBytes(header: string, entities: string[]): Uint8Array {
  const encoder = new TextEncoder();

  const headBytes = encoder.encode(`${header}DATA;\n`);
  const tailBytes = encoder.encode('ENDSEC;\nEND-ISO-10303-21;\n');

  // Pass 1: exact per-entity byte length via encodeInto into scratch space
  // (grown on demand), so the final buffer can be allocated once.
  let scratch = new Uint8Array(4096);
  const entityLengths = new Array<number>(entities.length);
  let totalSize = headBytes.byteLength + tailBytes.byteLength;
  for (let i = 0; i < entities.length; i++) {
    const str = entities[i];
    const worstCase = str.length * UTF8_WORST_CASE_BYTES_PER_UNIT;
    if (scratch.byteLength < worstCase) {
      scratch = new Uint8Array(Math.max(worstCase, scratch.byteLength * 2));
    }
    const { written } = encoder.encodeInto(str, scratch);
    entityLengths[i] = written;
    totalSize += written + 1; // +1 for the trailing '\n'
  }

  // Pass 2: encode each entity directly into its slice of the one final buffer.
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(headBytes, offset);
  offset += headBytes.byteLength;

  for (let i = 0; i < entities.length; i++) {
    const len = entityLengths[i];
    encoder.encodeInto(entities[i], result.subarray(offset, offset + len));
    offset += len;
    result[offset] = 0x0a; // '\n'
    offset += 1;
  }

  result.set(tailBytes, offset);
  return result;
}

/**
 * Assemble a STEP file as a multi-part `Blob` instead of one contiguous
 * `Uint8Array`. Built directly from the header, entity strings, and
 * newlines as separate `BlobPart`s — there is no final contiguous copy of
 * the file's content in JS heap memory, since the browser stores/streams
 * each part (and encodes it to UTF-8) independently.
 *
 * Intended for the browser download path: `downloadBlob`
 * (`apps/viewer/src/lib/export/download.ts`) accepts a `Blob` directly,
 * sidestepping the `Uint8Array`-is-not-a-`BlobPart` copy `downloadFile`
 * otherwise has to do under TS 5.7's stricter `BlobPart` typing.
 *
 * Byte content is identical to `assembleStepBytes(header, entities)` — both
 * UTF-8-encode the same header/entity/newline/tail sequence, and `Blob`
 * string parts and `TextEncoder` follow the same WHATWG encoding spec
 * (including replacing unpaired surrogates with U+FFFD).
 */
export function assembleStepBlob(header: string, entities: string[]): Blob {
  const parts: BlobPart[] = new Array(entities.length * 2 + 2);
  parts[0] = `${header}DATA;\n`;
  let i = 1;
  for (const entity of entities) {
    parts[i++] = entity;
    parts[i++] = '\n';
  }
  parts[i] = 'ENDSEC;\nEND-ISO-10303-21;\n';
  return new Blob(parts, { type: 'model/step' });
}
