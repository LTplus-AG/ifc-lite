/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser, type IfcDataStore, type ParseOptions } from './index.js';
import { unwrapIfcZipView } from './ifczip.js';
import type { EntityScanReport } from './scan-report.js';

export type IfcInputErrorCode = 'EMPTY_INPUT' | 'INVALID_STEP' | 'TRUNCATED_STEP' | 'MISSING_DATA' | 'INVALID_ARCHIVE';
export class IfcInputError extends Error {
  constructor(readonly code: IfcInputErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IfcInputError';
  }
}
export interface ParseModelOptions extends ParseOptions {
  /** Used only in diagnostics; bytes are supplied directly and no I/O is performed. */
  label?: string;
}
export interface ParsedModel {
  store: IfcDataStore;
  /** Record-scan completeness, independent of schema/geometry validation. */
  report: EntityScanReport;
}

/** Validate a STEP envelope and unwrap IFCZIP. Never exits the process. */
export async function validateStepInput(input: Uint8Array | ArrayBuffer, label = 'input'): Promise<Uint8Array> {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Validate the file is a STEP/IFC file
  if (bytes.byteLength === 0) {
    throw new IfcInputError('EMPTY_INPUT', `${label} is empty (0 bytes)`);
  }

  // Transparent .ifcZIP unwrap (issue #1494) — cheap magic-byte no-op for an
  // ordinary .ifc file. `unwrapIfcZipView` returns an ArrayBuffer over the
  // model bytes (the input unchanged when it isn't a zip container), so this
  // covers both the disk-read path and callers that already hold the buffer.
  try {
    bytes = new Uint8Array(await unwrapIfcZipView(bytes));
  } catch (err) {
    throw new IfcInputError('INVALID_ARCHIVE', `${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  // Check for STEP file signature ("ISO-10303-21") in the first 256 bytes.
  // TextDecoder (not Buffer.toString) so a plain Uint8Array view works too.
  const headerSnippet = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 256)),
  );
  if (!headerSnippet.includes('ISO-10303-21')) {
    throw new IfcInputError('INVALID_STEP', `${label} is not a valid IFC/STEP file`);
  }

  // A STEP file ends with `END-ISO-10303-21;`. Its absence means the bytes are
  // truncated -- a half-finished download, a killed export, a partial upload --
  // and a truncated file does not fail to parse: it parses to a PREFIX. The
  // scan stops wherever the bytes stop and reports whatever it got, so
  // `ifc-lite info` answered "Entities: 59" and exited 0 for the first 4 KB of a
  // real model, and "Schema: IFC4" for a 22-byte stub with no FILE_SCHEMA at
  // all (#5532). A confidently wrong answer is worse than an error, because
  // nothing downstream can tell it apart from a small model.
  //
  // Only the tail is decoded: these files reach hundreds of MB.
  const tailStart = Math.max(0, bytes.byteLength - 256);
  const tailSnippet = new TextDecoder('latin1').decode(bytes.subarray(tailStart));
  if (!tailSnippet.includes('END-ISO-10303-21;')) {
    throw new IfcInputError(
      'TRUNCATED_STEP', `${label} is truncated: it starts like a STEP file but has no ` +
        `END-ISO-10303-21; terminator, so any entity count or schema read from it ` +
        `would describe only the part that arrived.`,
    );
  }

  // A file with a header and no DATA section carries no entities at all. It is
  // well-formed STEP, so the terminator check above passes; it is still not a
  // model, and reporting a schema for it asserts something the file never said.
  // Bounded, like the header scan: `DATA;` follows the header, and these files
  // reach hundreds of MB -- decoding one whole would also risk V8's max string
  // length. 64 KB is far more header than any exporter writes.
  const headText = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024)),
  );
  if (!/^\s*DATA\s*;/m.test(headText)) {
    throw new IfcInputError('MISSING_DATA', `${label} has no DATA section, so it contains no IFC entities.`);
  }

  return bytes;
}

/** Load STEP/IFCZIP bytes with input validation and structured record-scan coverage.
 * Existing IfcParser.parseColumnar remains tolerant for callers that need recovery.
 */
export async function parseModel(input: Uint8Array | ArrayBuffer, options: ParseModelOptions = {}): Promise<ParsedModel> {
  const bytes = await validateStepInput(input, options.label);
  let report: EntityScanReport | undefined;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const store = await new IfcParser().parseColumnar(buffer, {
    ...options,
    onScanReport(value) { report = value; options.onScanReport?.(value); },
  });
  if (!report) throw new Error('Parser completed without a record-scan report');
  return { store, report };
}
