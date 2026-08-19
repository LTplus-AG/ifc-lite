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
 * ## Why an out-of-range ref is never "no match"
 *
 * This predicate was once exempted from the incidental readers
 * (`getRelatedEntities`, `getPropertySetName`, `getPropertyIdsInSet`, …) on
 * the grounds that "a clamped, empty decode already yields no match, which is
 * the same answer". That is false, and it is false in BOTH directions the
 * range can leave the source. A clamp does not empty a range; it moves an
 * endpoint onto a real file byte, and the window that survives still holds
 * somebody else's record. Measured on a two-record source
 * (`#1=IFCPROPERTYSET(...,(#101,#102));#2=IFCPROPERTYSET(...,(#201,#202));`):
 *
 * - **Negative offset.** `(-2, n)` floors to 0 and decodes from the START OF
 *   THE FILE: `getPropertySetName(#2)` answers `'SetA'` — `#1`'s name.
 * - **Overrunning end.** `(0, 9999)` for `#1` clamps to EOF, so the window
 *   ends at the file's LAST record. `getPropertySetName(#1)` answers `'SetA'`
 *   — right, by luck, because that pattern is unanchored — while
 *   `getPropertyIdsInSet(#1)` answers `[201, 202]`, which are `#2`'s members.
 *   The readers whose patterns are `$`-anchored match at the end of the
 *   CLAMPED window, i.e. against whatever record the file happens to end on.
 *
 * A confidently wrong answer, not "no match". The overrun is also the shape
 * that is REACHABLE — it is the #2491 corrupt-store shape above, a ref
 * claiming bytes the source cannot serve. The negative offset is not, twice
 * over: `OVERLAY_BYTE_OFFSET = -1` (`mutations/src/store-editor.ts`) is the
 * only negative offset in the repo and every site that writes it pairs it
 * with `byteLength: 0`; and `CompactEntityIndex` — the index those readers
 * consult — keeps offsets in a `Uint32Array`, so a negative value cannot
 * round-trip through it at all. The two-record measurements above were taken
 * over a plain-`Map` index, which can hold one.
 *
 * The readers are therefore gated on this predicate too (`entityLineText` in
 * `step-property-sets.ts`), which also makes them agree with the source-iteration
 * pass: that pass already skips a record whose ref fails this test, so an
 * exempt reader was answering questions about a record the same export had
 * decided not to write.
 */

import { asSourceBytes, type IfcSourceBytes } from '@ifc-lite/parser';
import type { ExportEntityRef } from './entity-iteration.js';

/**
 * UTF-8 decode of `[start, end)` of the source, accepting either the raw bytes
 * or the {@link IfcSourceBytes} accessor (#2183). Replaces the direct
 * `safeUtf8Decode(source, …)` calls the exporter used to make: `decodeUtf8` is
 * SAB-safe in exactly the same way, and routing through the accessor is what
 * lets `IfcDataStore.source` change shape without touching those reads.
 *
 * Lives beside {@link createSourceRefReader} because the two are always used
 * together: the predicate decides whether a range may be read, this performs
 * the read. Both `step-exporter.ts` and `step-property-sets.ts` need them, and
 * one decode with one doc comment is what keeps the two files agreeing about
 * what a clamped range means (#2475 step 2b).
 */
export function decodeRange(src: Uint8Array | IfcSourceBytes, start: number, end: number): string {
  return asSourceBytes(src).decodeUtf8(start, end);
}

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
