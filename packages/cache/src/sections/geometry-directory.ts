/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validation for the v13 geometry section's chunk directory (see the module
 * doc comment in geometry-chunks.ts for the on-disk layout). Split out of
 * geometry-chunks.ts so the directory-integrity checks — which exist purely
 * to catch corrupted/adversarial cache files, not to serve the happy path —
 * stay reviewable on their own.
 */

import type { GeometryHead } from './geometry-chunks.js';

/**
 * Validate a parsed v13 geometry head's directory against the structural
 * facts of the parse. `actualHeadEnd` is where the head parse actually
 * landed (relative to the section start) — a fact independent of anything
 * the on-disk `headLength` field claims. Throws on any inconsistency.
 */
export function validateGeometryDirectory(head: GeometryHead, actualHeadEnd: number): void {
  // Validate `headLength` against that structural fact BEFORE it is trusted
  // as the chunk-0 anchor below. Without this, the anchor check further down
  // (`chunks[0].byteOffset === 4 + head.headLength`) only cross-validates two
  // independently-corruptible on-disk fields against EACH OTHER: corrupt
  // headLength and echo the same corruption into chunk 0's declared
  // byteOffset, and the two stay "consistent" while both disagree with where
  // the head parse actually ended — stepping around the anchor check AND the
  // contiguity loop that follows it in one move. Anchoring against
  // `reader.position` instead closes that, because it can't be forged from
  // inside the buffer's declared fields.
  if (4 + head.headLength !== actualHeadEnd) {
    throw new Error(
      `Invalid cache: geometry head declares headLength ${head.headLength}, but the parsed head is ${actualHeadEnd - 4} bytes`,
    );
  }

  // The writer lays chunks out back-to-back with no gaps (see the module
  // doc comment). Validate that invariant on read: a corrupt directory entry
  // that inflates one chunk's byteLength (with uncompressedLength and
  // meshCount lied to match, so the per-chunk checks in decodeGeometryChunk
  // can't tell) would otherwise let that chunk's slice reach into — and
  // silently absorb — a NEIGHBOURING chunk's real, validly-encoded mesh
  // records, duplicating that geometry under two chunks with no error. This
  // catches it at the structural level, independent of anything the
  // corrupted entry itself claims.
  // NOTE: this only cross-checks chunks against EACH OTHER (safe regardless
  // of what follows the geometry section in a multi-section cache file). It
  // does not — and structurally cannot, without also threading the
  // section's own byte size through this call — catch a corrupted LAST
  // chunk whose declared range reaches past its true end into whatever
  // bytes happen to follow (trailing padding, or the next section). That
  // residual case still relies on readChunk's own end-of-buffer bounds
  // check plus decodeGeometryChunk's uncompressedLength check.
  // Anchor the sequence. The contiguity loop below starts at i = 1 because
  // element 0 has no predecessor to be consistent WITH -- so on its own it
  // validates every chunk except the first, and a directory whose offsets are
  // all shifted by the same amount stays perfectly contiguous and passes.
  // `headLength` is that external anchor: the writer lays the first chunk
  // immediately after the head, at `4 + headLength` (the 4 being the
  // `headLength` field itself).
  if (head.chunks.length > 0) {
    const expectedFirst = actualHeadEnd; // == 4 + head.headLength, now proven equal above
    if (head.chunks[0].byteOffset !== expectedFirst) {
      throw new Error(
        `Invalid cache: geometry chunk 0 byteOffset ${head.chunks[0].byteOffset} does not start at the end of the head (expected ${expectedFirst})`,
      );
    }
  }
  for (let i = 1; i < head.chunks.length; i++) {
    const expectedStart = head.chunks[i - 1].byteOffset + head.chunks[i - 1].byteLength;
    if (head.chunks[i].byteOffset !== expectedStart) {
      throw new Error(
        `Invalid cache: geometry chunk ${i} byteOffset ${head.chunks[i].byteOffset} is not contiguous with the previous chunk (expected ${expectedStart})`,
      );
    }
  }
}
