/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `reference-integrity` rule of `ifc-lite validate`: `#N` attribute
 * references whose target expressId is not in the file. Split out of
 * `validate.ts` to keep that file under its module-size budget.
 */

import { asSourceBytes, type IfcDataStore, type EntityRef, type IfcSourceBytes } from '@ifc-lite/parser';

/** One `#N` reference whose target expressId does not exist in the file. */
export interface DanglingReference {
  /** expressId of the entity containing the reference. */
  entityId: number;
  /** STEP type name of the referencing entity (UPPERCASE, as scanned). */
  entityType: string;
  /** Zero-based top-level attribute slot the reference sits in (nested refs report their containing slot). */
  attributeIndex: number;
  /** The missing expressId being referenced. */
  target: number;
}

const CH_QUOTE = 0x27; // '
const CH_LPAREN = 0x28; // (
const CH_RPAREN = 0x29; // )
const CH_COMMA = 0x2c; // ,
const CH_HASH = 0x23; // #
const CH_SLASH = 0x2f; // /
const CH_STAR = 0x2a; // *

/**
 * Scan one entity record's source bytes for `#N` attribute references and
 * report the ones whose target expressId is not indexed. Operates directly on
 * the raw bytes the parser already indexed (`store.entityIndex.byId` spans),
 * so it is a single pass over each record with no string allocation. Quote
 * tracking (including STEP's doubled-quote escape) keeps `#N` sequences inside
 * string literals from being read as references; embedded STEP comments are
 * skipped.
 */
function scanEntityForDanglingRefs(
  src: Uint8Array | IfcSourceBytes,
  ref: EntityRef,
  exists: (id: number) => boolean,
  out: DanglingReference[],
): void {
  // Narrow to this record before scanning. `slice` is a `subarray` on a
  // contiguous source, so the byte walk below is unchanged and zero-copy.
  const record = asSourceBytes(src).slice(ref.byteOffset, ref.byteOffset + ref.byteLength);
  scanRecordForDanglingRefs(record, ref, exists, out);
}

/** The byte walk itself, over one already-narrowed entity record. */
function scanRecordForDanglingRefs(
  source: Uint8Array,
  ref: EntityRef,
  exists: (id: number) => boolean,
  out: DanglingReference[],
): void {
  const end = source.length;
  // References only occur inside the attribute list; skip the "#id = TYPE" prefix.
  let i = 0;
  while (i < end && source[i] !== CH_LPAREN) i++;
  if (i >= end) return; // malformed record, nothing to scan

  let depth = 1; // we are inside the outermost '(' now
  let attrIndex = 0;
  i++;

  while (i < end) {
    const c = source[i];
    if (c === CH_QUOTE) {
      // String literal: skip to the closing quote, honouring '' escapes.
      i++;
      while (i < end) {
        if (source[i] === CH_QUOTE) {
          // `\S\'` is a PAGE directive's operand, text rather than a close (#7589):
          // the byte form of the lookback in `stepStringLiteralEnd` (@ifc-lite/encoding).
          if (i >= 3 && source[i - 1] === 0x5c && source[i - 2] === 0x53 && source[i - 3] === 0x5c) { i++; continue; }
          if (i + 1 < end && source[i + 1] === CH_QUOTE) {
            i += 2; // escaped quote, still inside the string
            continue;
          }
          break; // closing quote
        }
        i++;
      }
    } else if (c === CH_SLASH && i + 1 < end && source[i + 1] === CH_STAR) {
      // STEP comment inside a record (rare but legal): skip to closing marker.
      i += 2;
      while (i + 1 < end && !(source[i] === CH_STAR && source[i + 1] === CH_SLASH)) i++;
      i++; // lands on '/', loop increment moves past it
    } else if (c === CH_LPAREN) {
      depth++;
    } else if (c === CH_RPAREN) {
      depth--;
      if (depth === 0) return; // end of attribute list
    } else if (c === CH_COMMA && depth === 1) {
      attrIndex++;
    } else if (c === CH_HASH) {
      let id = 0;
      let digits = 0;
      let j = i + 1;
      while (j < end) {
        const d = source[j] - 0x30;
        if (d < 0 || d > 9) break;
        id = id * 10 + d;
        digits++;
        j++;
      }
      if (digits > 0) {
        if (!exists(id)) {
          out.push({ entityId: ref.expressId, entityType: ref.type, attributeIndex: attrIndex, target: id });
        }
        i = j - 1; // loop increment moves past the last digit
      }
    }
    i++;
  }
}

/** Check source `#N` references against the parsed and deferred file indexes
 * (rule `reference-integrity`), scanning records in both indexes. */
export function collectDanglingReferences(store: IfcDataStore): DanglingReference[] {
  const source = store.source;
  // @raw-entity-enumeration-ok reference-integrity checks the source bytes against their parsed source index
  const byId = store.entityIndex.byId;
  const deferred = store.deferredEntityIndex;
  if (!source || source.byteLength === 0 || !byId) return [];

  const exists = (id: number): boolean => byId.has(id) || deferred?.has(id) === true;

  const out: DanglingReference[] = [];
  for (const ref of byId.values()) {
    scanEntityForDanglingRefs(source, ref, exists, out);
  }
  if (deferred) {
    for (const ref of deferred.values()) {
      if (byId.has(ref.expressId)) continue; // already scanned above
      scanEntityForDanglingRefs(source, ref, exists, out);
    }
  }
  return out;
}
