/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { safeUtf8Decode } from '@ifc-lite/data';
import { IfcParser, type IfcDataStore, type ParseOptions } from './index.js';
import { unwrapIfcZipView } from './ifczip.js';
import type { EntityScanReport } from './scan-report.js';
import { STEP_TRIVIA } from './step-trivia.js';
import { inspectStepEnvelope } from './step-envelope.js';

const STEP_START = new RegExp(`^${STEP_TRIVIA}ISO-10303-21${STEP_TRIVIA};`);
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

/** Validate a STEP envelope and unwrap IFCZIP. Signature mode preserves recovery loaders. Never exits the process. */
export async function validateStepInput(input: Uint8Array | ArrayBuffer, label = 'input',
  options: { envelope?: 'complete' | 'signature' } = {}): Promise<Uint8Array> {
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
  // The shared decoder also handles browser SharedArrayBuffer restrictions.
  const headerSnippet = safeUtf8Decode(
    bytes.subarray(0, Math.min(bytes.byteLength, 256)),
  );
  const hasSignature = options.envelope === 'signature'
    ? headerSnippet.includes('ISO-10303-21') : STEP_START.test(headerSnippet);
  if (!hasSignature) {
    throw new IfcInputError('INVALID_STEP', `${label} is not a valid IFC/STEP file`);
  }

  if (options.envelope === 'signature') return bytes;

  // A marker is meaningful only outside STEP strings/comments. Walk bytes so
  // even very large files need no full-size decoded allocation.
  const envelope = inspectStepEnvelope(bytes);
  if (!envelope.footer) {
    throw new IfcInputError(
      'TRUNCATED_STEP', `${label} is truncated: it starts like a STEP file but has no ` +
        `END-ISO-10303-21; terminator, so any entity count or schema read from it ` +
        `would describe only the part that arrived.`,
    );
  }

  if (!envelope.data) {
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
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const store = await new IfcParser().parseColumnar(buffer, {
    ...options,
    onScanReport(value) { report = value; options.onScanReport?.(value); },
  });
  if (!report) throw new Error('Parser completed without a record-scan report');
  return { store, report };
}
