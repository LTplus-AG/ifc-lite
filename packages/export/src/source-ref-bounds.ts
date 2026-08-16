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
 * ## The incidental readers, and why the clamp is never harmless
 *
 * This predicate is not applied on this branch to the incidental readers
 * (`getRelatedEntities`, `getPropertySetName`, `getElementQuantityName`, …).
 * Those decode a range and match a pattern in it.
 *
 * The exemption is NOT justified by the clamp being harmless, in EITHER
 * direction the range can leave the source. `clampRange` (`source-bytes.ts`)
 * does not empty a range; it moves an endpoint onto a real file byte, and the
 * window that survives still holds somebody else's record. Measured on a
 * two-record source:
 *
 * - **Negative offset.** A negative start carrying a real length floors to 0
 *   and decodes from the beginning of the FILE, so `getPropertySetName`
 *   reports the FIRST pset's name for the second one — a confidently wrong
 *   answer, not a null.
 * - **Overrunning end.** Equally wrong, and this is the shape that is
 *   REACHABLE. `(byteOffset: 0, byteLength: 9999)` for `#1` clamps to EOF, so
 *   the window ends at the file's LAST record; `getPropertyIdsInSet(#1)`
 *   answers `[201, 202]`, which are `#2`'s members. The `$`-anchored patterns
 *   match at the end of the CLAMPED window, i.e. against whatever record the
 *   file happens to end on. `getPropertySetName` is right there only by luck,
 *   because its pattern is unanchored.
 *
 * The negative offset is unreachable — `OVERLAY_BYTE_OFFSET` (`-1`) is the
 * only one in the repo, all three sites that write it pair it with
 * `byteLength: 0`, and it is synthesised by the EFFECTIVE index rather than
 * written into `dataStore.entityIndex.byId`, which is the index these readers
 * consult (all pinned by `source-ref-bounds.test.ts`). The overrun is not: it
 * is the same corrupt-store shape as above, a ref claiming bytes the source
 * cannot serve.
 *
 * So the exemption is a live defect, not a safe simplification, and it is
 * older than this branch. Removing it — gating these readers on this
 * predicate, which also makes them agree with the source-iteration pass — is
 * the subject of #2678, with the probe and the tests. It is deliberately not
 * done here: this branch is about the emission predicate, and the two changes
 * touch the same docstring. When #2678 lands, the per-call-site consequence
 * lives in `step-exporter.ts`'s `entityLineText` and the argument stays here,
 * cited rather than repeated.
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
