/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Can this record's line actually be read out of this source?"
 *
 * The exporter's byte-range gates used to ask two weaker questions — is there a
 * source at all, and does this ref claim a non-empty range — and relied on an
 * UNSTATED invariant to join them: an empty source implies zero-length refs
 * (#2491). Every producer in the repo happens to honour it (the one source-less
 * store builder adds every ref as `(0, 0)`), and nothing states or enforces it.
 *
 * A store that violates it made the exporter write a CORRUPT file, silently. A
 * ref claiming real bytes over a source that has none passed the presence gates,
 * so the property-set generator wrote an `IfcRelDefinesByProperties` naming the
 * host — while the source-iteration pass emitted the host's own line as the
 * EMPTY STRING, because `IfcSourceBytes.decodeUtf8` clamps a range it cannot
 * address. A relationship pointing at a wall whose line had vanished: no error,
 * no warning.
 *
 * ## Why the ref rather than the invariant
 *
 * The invariant could have been asserted where stores are constructed. There is
 * no single chokepoint for that — stores are built by the parser, by the server
 * data model, by test doubles and by any embedder of the published API — so an
 * assertion would have to be added to each, and the next producer (a partial or
 * streaming source, or one that attaches bytes after building its index) would
 * be free to skip it. Testing the ref puts the check where the value is USED,
 * which is one place per read and cannot be bypassed by a new producer.
 *
 * The degraded behaviour is the one the exporter already handles correctly and
 * has tests for: a record with no emittable bytes. Nothing is generated FOR it,
 * nothing that names it is written, and it does not appear in the file — the
 * same outcome as the source-less store the server path builds.
 *
 * This predicate is deliberately NOT applied to the incidental readers
 * (`getRelatedEntities`, `getPropertySetName`, …). Those decode a range and
 * match a pattern in it; a clamped, empty decode already yields "no match",
 * which is the same answer and needs no gate of its own.
 */

import type { ExportEntityRef } from './entity-iteration.js';

/** The half of a source this module needs: how many bytes it can serve. */
interface SourceExtent {
  readonly byteLength: number;
}

/**
 * A predicate over entity refs: true when `[byteOffset, byteOffset+byteLength)`
 * is a non-empty range fully inside `source`.
 *
 * `source` may be absent (a store built with no source at all), in which case
 * nothing is readable. A ref at `(0, 0)` is not readable either — that is the
 * canonical "this record has no source line" marker, not a zero-width read.
 */
export function createSourceRefReader(
  source: SourceExtent | null | undefined,
): (ref: Pick<ExportEntityRef, 'byteOffset' | 'byteLength'> | undefined) => boolean {
  const extent = source ? source.byteLength : 0;
  return (ref) => {
    if (!ref) return false;
    if (ref.byteOffset < 0 || ref.byteLength <= 0) return false;
    // `<=` on the END, so a range that stops exactly at the last byte reads.
    // Written as a sum rather than as two comparisons because a ref whose
    // offset alone is in range can still run off the end.
    return ref.byteOffset + ref.byteLength <= extent;
  };
}
