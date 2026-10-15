/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAX_EXPRESS_ID } from './express-id.js';
import type { EntityScanPath } from './entity-scanner.js';

export type ScanCompleteness = 'complete' | 'incomplete' | 'unknown';
export interface ScanDiagnostic {
  code: 'OVERSIZED_EXPRESS_ID' | 'MALFORMED_RECORD' | 'UNREPORTED_SCAN_COUNTS';
  severity: 'warning';
  message: string;
}
/** Record-scan coverage only: this does not certify schema or geometry validity. */
export interface EntityScanReport {
  completeness: ScanCompleteness;
  scanPath: EntityScanPath;
  scannedRecords: number;
  oversizedIdCount: number | null;
  /** The scanner reports a flag, not an exact number of malformed records. */
  malformedRecordDetected: boolean | null;
  diagnostics: readonly ScanDiagnostic[];
}

export function reportScanDiagnostics(scanPath: EntityScanPath, oversizedIdCount: number,
  malformedRecordCount: number, preScanCountUnreported: boolean,
  onDiagnostic?: (message: string) => void): void {
  // On the wasm path Rust already printed these exact sentences (its report
  // sink, kept for direct `@ifc-lite/wasm` callers); printing them again here
  // would log each refusal twice, so that path adds only `onDiagnostic` (#7393).
  const consoleAlreadyReported = scanPath === 'wasm';

  // A refused record is a record the caller will not find. Say so on both
  // channels the loader already watches, rather than letting the model come
  // back quietly short (#3395).
  if (oversizedIdCount > 0) {
    const message =
      `scan: skipped ${oversizedIdCount} record(s) with an express id above ${MAX_EXPRESS_ID} (#3395)`;
    if (!consoleAlreadyReported) console.warn(`[IfcParser] ${message}`);
    onDiagnostic?.(message);
  }

  // Worse than the oversized-id case: this is not "one record the caller
  // will not find", it is "scanning stopped here", so every entity after the
  // break, however well-formed, is also missing from this scan's result.
  // Before this diagnostic existed, that stop was entirely silent: fewer
  // entities came back, and nothing said the file might be incomplete.
  //
  // Deliberately generic: the flag covers three shapes collapsed into one, so a
  // message naming only one of them would misdescribe the others. It no longer
  // says the scan STOPS: since #4179 a record missing its ';' is DROPPED and the
  // scan resumes at the balancing ')', so the common case loses one record from a
  // file otherwise read to completion. The Rust twin
  // (rust/core/src/parser/malformed_records.rs:34) carries the same wording and
  // these two halves must not diverge.
  // so malformedRecordCount is 0 or 1, never a density, and it covers three
  // shapes -- an unterminated or unescaped (#7541) string, an unterminated comment,
  // and a declaration cut off before its own '(' -- collapsed into one flag, so a
  // message naming only one of them would misdescribe the other two every
  // time it fires.
  if (malformedRecordCount > 0) {
    const message =
      "scan: dropped a record with no terminating ';' (an unterminated or unescaped quoted string, " +
      'comment, or truncated file); the entities returned may be an incomplete view of ' +
      'this file (#3695)';
    if (!consoleAlreadyReported) console.warn(`[IfcParser] ${message}`);
    onDiagnostic?.(message);
  }

  // Independent of the branch above, not chained onto it (#3790 round 2).
  // These two say different things about different numbers, and both can be
  // true at once: a pre-pass that stopped at a malformed record AND reports
  // no refusal count. The `else if` this replaces was safe only while the
  // pre-scanned path had no way to set `malformedRecordCount` at all -- the
  // moment it did, the load that most needs both warnings got exactly one.
  if (preScanCountUnreported && scanPath === 'pre-scanned') {
    // Absence has to look different from success. This producer sent the
    // columns without a refusal count, so a zero here is not evidence of
    // none, say that, rather than returning a result that reads like a clean
    // scan.
    const message =
      'scan: the pre-pass that produced this entity index does not report refused ' +
      `express ids (#3395), so a count of 0 is not proof that none were skipped`;
    console.warn(`[IfcParser] ${message}`);
    onDiagnostic?.(message);
  }

}

/** Refusal counts are non-negative safe integers, including across host boundaries. */
export function isScanCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function buildScanReport(scanPath: EntityScanPath, scannedRecords: number,
  oversizedIdCount: number | null, malformedRecordCount: number | null): EntityScanReport {
  // Caller-provided pre-scans are runtime input, including from JavaScript.
  const validCount = (value: number | null) => isScanCount(value) ? value : null;
  oversizedIdCount = validCount(oversizedIdCount);
  malformedRecordCount = validCount(malformedRecordCount);
  const diagnostics: ScanDiagnostic[] = [];
  if (oversizedIdCount !== null && oversizedIdCount > 0) diagnostics.push({
    code: 'OVERSIZED_EXPRESS_ID', severity: 'warning',
    message: `${oversizedIdCount} record(s) were skipped because their EXPRESS ids exceed ${MAX_EXPRESS_ID}.`,
  });
  if (malformedRecordCount !== null && malformedRecordCount > 0) diagnostics.push({
    code: 'MALFORMED_RECORD', severity: 'warning',
    message: 'Malformed STEP records were detected; returned records may be incomplete.',
  });
  if (oversizedIdCount === null || malformedRecordCount === null) diagnostics.push({
    code: 'UNREPORTED_SCAN_COUNTS', severity: 'warning',
    message: 'The scan producer did not report all refusal counters; complete coverage is unknown.',
  });
  const incomplete = (oversizedIdCount ?? 0) > 0 || (malformedRecordCount ?? 0) > 0;
  return { scanPath, scannedRecords, oversizedIdCount,
    malformedRecordDetected: malformedRecordCount === null ? null : malformedRecordCount > 0,
    completeness: incomplete ? 'incomplete' : diagnostics.length > 0 ? 'unknown' : 'complete', diagnostics };
}
