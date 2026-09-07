/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synthesize `EntityRef[]` from a pre-built entity index (ids/starts/lengths
 * column arrays produced by the streaming geometry pre-pass) WITHOUT a
 * second WASM scan of the source.
 *
 * The pre-pass already walked the file once and emitted these three column
 * arrays; the parser worker reuses them so its own `scanEntitiesFastBytes`
 * call — which on a 986 MB / 14 M-entity file takes ~10 s under WASM
 * contention with the geometry workers — can be skipped entirely.
 *
 * Cost: ~1–2 s for 14 M entities. Almost all of it is the per-entity type
 * extraction (find `=`, find `(`, intern). Type interning hits ~99.99 % on
 * real IFC files (≈776 unique type names across 14 M entities) so we
 * allocate one JS string per unique type.
 */

import type { EntityRef } from './types.js';
import { EntityTypeByteInterner } from './entity-type-byte-interner.js';
import type { CompactEntityIndexColumns } from './compact-entity-index-transport.js';
import { asSourceBytes, type IfcSourceBytes } from './source-bytes.js';

/** Scan-time type IDs retain every spelling before compact-index narrowing. */
export type ScannedEntityColumns = Omit<CompactEntityIndexColumns, 'typeIndices'> & {
  typeIndices: Uint16Array | Uint32Array;
};


const EQ = 0x3d;
const LPAREN = 0x28;
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
// Kept in sync with isSpaceByte in step-lexing.ts. Without these two, a form
// feed or vertical tab right after '=' stays attached to the type token this
// function extracts, so the pre-pass fast path would read a wall's type as
// e.g. "\fIFCWALL" instead of "IFCWALL" while the full scanner path reads it
// correctly -- same rule, two byte sets, one wrong answer.
const FORM_FEED = 0x0c;
const VTAB = 0x0b;

/** The shared record walk owns validation, stable ordering and type lexing. */
function visitEntityIndex(
  source: Uint8Array | IfcSourceBytes,
  ids: Uint32Array,
  starts: Uint32Array,
  lengths: Uint32Array,
  visit: (row: number, id: number, type: string, start: number, length: number) => void,
): void {
  const bytes = asSourceBytes(source);
  const n = ids.length;
  // Fail fast on malformed input from the transport layer rather than
  // silently emitting refs with `type: ''` and truncated byte ranges.
  // The pre-pass-emitted SAB triple should always have matching
  // lengths; mismatch here means corruption upstream that the parser
  // cannot recover from. Spans that point past `source.length` are
  // also rejected — clamping them would yield a malformed index.
  if (starts.length !== n || lengths.length !== n) {
    throw new Error(
      `buildEntityRefsFromIndex: column-length mismatch (ids=${n}, starts=${starts.length}, lengths=${lengths.length}); pre-pass entity-index is corrupted`,
    );
  }
  const sourceLen = bytes.byteLength;
  const intern = new EntityTypeByteInterner();
  const contiguous = source instanceof Uint8Array ? source : undefined;

  // Current pre-pass columns are already ID-ordered (#1682). Only allocate
  // and sort a permutation for producers that actually send unsorted IDs.
  // Keep equal IDs in their input order, matching the stable typed-array sort.
  let order: Uint32Array | undefined;
  for (let i = 1; i < n; i++) {
    if (ids[i] < ids[i - 1]) {
      order = Uint32Array.from({ length: n }, (_, index) => index);
      order.sort((a, b) => ids[a] - ids[b]);
      break;
    }
  }

  for (let oi = 0; oi < n; oi++) {
    const i = order ? order[oi] : oi;
    const start = starts[i];
    const len = lengths[i];
    // Reject spans that walk off the end of the source. Clamping
    // (the original behavior) would silently emit refs with
    // truncated byte ranges and empty type names — better to fail
    // loudly so the corrupted source/index is surfaced.
    if (start > sourceLen || start + len > sourceLen) {
      throw new Error(
        `buildEntityRefsFromIndex: out-of-bounds span at index ${i} (id=${ids[i]}, start=${start}, len=${len}, source=${sourceLen})`,
      );
    }
    // The parser already supplies a contiguous view. Keep offsets in that
    // view to avoid constructing one temporary subarray per record. Blocked
    // source accessors retain their existing one-record read pattern.
    const record = contiguous ?? bytes.slice(start, start + len);
    const limit = contiguous ? start + len : record.length;

    // Skip past `#<digits>=` to find the type token.
    let p = contiguous ? start : 0;
    while (p < limit && record[p] !== EQ) p++;
    p++;
    while (
      p < limit
      && (record[p] === SPACE || record[p] === TAB || record[p] === LF || record[p] === CR
        || record[p] === FORM_FEED || record[p] === VTAB)
    ) p++;
    const typeStart = p;
    let typeHash = 0x811c9dc5;
    while (
      p < limit
      && record[p] !== LPAREN
      && record[p] !== SPACE
      && record[p] !== TAB
      && record[p] !== LF
      && record[p] !== CR
      && record[p] !== FORM_FEED
      && record[p] !== VTAB
    ) {
      typeHash = Math.imul(typeHash ^ record[p], 0x01000193);
      p++;
    }
    const typeEnd = p;
    const interned = intern.intern(record, typeStart, typeEnd, typeHash);

    visit(oi, ids[i], interned, start, len);
  }
}

export function buildEntityRefsFromIndex(
  source: Uint8Array | IfcSourceBytes,
  ids: Uint32Array,
  starts: Uint32Array,
  lengths: Uint32Array,
): EntityRef[] {
  const refs: EntityRef[] = new Array(ids.length);
  visitEntityIndex(source, ids, starts, lengths, (row, expressId, type, byteOffset, byteLength) => {
    refs[row] = { expressId, type, byteOffset, byteLength, lineNumber: 0 };
  });
  return refs;
}

/** #3985: retain columns instead of allocating a helper object for every record.
 * Own the output: callers may mutate/release their pre-pass columns after scan.
 * The public EntityRef[] adapter above uses exactly the same lexical walk.
 */
export function buildEntityColumnsFromIndex(
  source: Uint8Array | IfcSourceBytes,
  ids: Uint32Array,
  starts: Uint32Array,
  lengths: Uint32Array,
): ScannedEntityColumns {
  const expressIds = new Uint32Array(ids.length);
  const byteOffsets = new Uint32Array(ids.length);
  const byteLengths = new Uint32Array(ids.length);
  let typeIndices: Uint16Array | Uint32Array = new Uint16Array(ids.length);
  const typeStrings: string[] = [];
  const types = new Map<string, number>();
  visitEntityIndex(source, ids, starts, lengths, (row, id, type, start, length) => {
    let typeIndex = types.get(type);
    if (typeIndex === undefined) {
      typeIndex = typeStrings.length;
      typeStrings.push(type);
      types.set(type, typeIndex);
      // Unrecognized type names are file-supplied too. Keep their original
      // names for categorization even beyond the final compact u16 surface.
      if (typeIndex === 0x10000) typeIndices = Uint32Array.from(typeIndices);
    }
    expressIds[row] = id;
    byteOffsets[row] = start;
    byteLengths[row] = length;
    typeIndices[row] = typeIndex;
  });
  return { expressIds, byteOffsets, byteLengths, typeIndices, typeStrings };
}
