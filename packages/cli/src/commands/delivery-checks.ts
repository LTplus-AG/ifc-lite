/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model loading and per-check evaluation for `ifc-lite delivery`.
 *
 * Three outcomes exist for every check, never just two:
 *  - `pass`   — the check ran and found nothing to report.
 *  - `fail`   — the check ran and found a violation.
 *  - `error`  — the check could NOT be run (unreadable model, unreadable or
 *               unparsable IDS file, an IDS document declaring zero
 *               specifications). An unevaluable check must never be folded
 *               into `pass`: a delivery report that silently skips a rule
 *               and still reads as clean is worse than no report.
 *
 * `loadModelForDelivery` deliberately does NOT reuse `loader.ts`'s
 * `loadIfcFile`/`loadIfcBytes`: those call `process.exit(1)` directly on an
 * empty, non-STEP, or unparsable file, which is correct for a single-file
 * command but would kill the whole `delivery` process on the SECOND model in
 * a multi-model recipe just because the first one was bad. This loader
 * performs the same validation (STEP signature, ifcZIP unwrap, parse) but
 * returns a `{ error }` result instead of exiting, so one unreadable model
 * becomes one `error` entry in the report — never a crashed run and never a
 * silently-passing verdict.
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { IfcParser, unwrapIfcZipView, type IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { IDSNamespace } from '@ifc-lite/sdk';
import { computeValidationIssues, type ValidationIssue } from './validate.js';

export type CheckStatus = 'pass' | 'fail' | 'error';

export interface LoadedModel {
  path: string;
  /** SHA-256 of the exact bytes read from disk (post ifcZIP unwrap: the STEP text actually checked). */
  sha256: string;
  store: IfcDataStore;
}

export interface ModelLoadError {
  path: string;
  error: string;
}

/** Load one model file for delivery checking, never throwing and never exiting the process. */
export async function loadModelForDelivery(path: string): Promise<LoadedModel | ModelLoadError> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (err) {
    return { path, error: `could not be read: ${(err as Error).message}` };
  }

  if (bytes.byteLength === 0) {
    return { path, error: 'is empty (0 bytes)' };
  }

  try {
    bytes = new Uint8Array(await unwrapIfcZipView(bytes));
  } catch (err) {
    return { path, error: `could not be unwrapped: ${(err as Error).message}` };
  }

  const headerSnippet = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 256)));
  if (!headerSnippet.includes('ISO-10303-21')) {
    return { path, error: 'is not a valid IFC/STEP file' };
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const parser = new IfcParser();
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const store = await parser.parseColumnar(arrayBuffer, {});
    store.fileSize = bytes.byteLength;
    return { path, sha256, store };
  } catch (err) {
    return { path, error: `could not be parsed: ${(err as Error).message}` };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

export interface StructuralCheckResult {
  type: 'structural';
  model: string;
  status: CheckStatus;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: ValidationIssue[];
  error?: string;
}

/** Run the same structural rules `ifc-lite validate` runs. `fail` iff at least one error-severity issue was found. */
export function runStructuralCheck(modelPath: string, store: IfcDataStore): StructuralCheckResult {
  const issues = computeValidationIssues(store);
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warningCount = issues.filter(i => i.severity === 'warning').length;
  const infoCount = issues.filter(i => i.severity === 'info').length;
  return {
    type: 'structural',
    model: modelPath,
    status: errorCount > 0 ? 'fail' : 'pass',
    errorCount,
    warningCount,
    infoCount,
    issues,
  };
}

export interface IdsCheckResult {
  type: 'ids';
  model: string;
  source: string;
  status: CheckStatus;
  totalSpecifications?: number;
  passedSpecifications?: number;
  failedSpecifications?: number;
  notApplicableSpecifications?: number;
  totalEntities?: number;
  passedEntities?: number;
  failedEntities?: number;
  error?: string;
}

/**
 * Run one IDS rule file against one already-loaded model.
 *
 * `status` is `error` when the IDS file itself could not be read/parsed, or
 * when it declares zero specifications (nothing was actually evaluated —
 * reporting that as `pass` would hide an empty ruleset behind a green
 * check). Otherwise `fail` iff at least one specification failed; a
 * specification whose applicability matched no entities counts as neither
 * pass nor fail (`notApplicableSpecifications`, mirrored from the IDS
 * summary) — if EVERY specification lands there (nothing was definitively
 * satisfied OR violated), the check reports `error` rather than a `pass`
 * that would rest on zero actual evidence.
 */
export async function runIdsCheck(modelPath: string, store: IfcDataStore, idsPath: string): Promise<IdsCheckResult> {
  const base = { type: 'ids' as const, model: modelPath, source: idsPath };

  let idsContent: string;
  try {
    idsContent = await readFile(idsPath, 'utf-8');
  } catch (err) {
    return { ...base, status: 'error', error: `could not be read: ${(err as Error).message}` };
  }

  const ids = new IDSNamespace();
  let idsDoc: unknown;
  try {
    idsDoc = await ids.parse(idsContent);
  } catch (err) {
    return { ...base, status: 'error', error: `could not be parsed: ${(err as Error).message}` };
  }

  const accessor = createDataAccessor(store);
  let report: {
    summary: {
      totalSpecifications: number;
      passedSpecifications: number;
      failedSpecifications: number;
      notApplicableSpecifications: number;
      totalEntities: number;
      passedEntities: number;
      failedEntities: number;
    };
  };
  try {
    report = (await ids.validate(idsDoc, {
      accessor,
      modelInfo: { schemaVersion: store.schemaVersion },
      locale: 'en',
      includePassingEntities: false,
    })) as typeof report;
  } catch (err) {
    return { ...base, status: 'error', error: `validation failed: ${(err as Error).message}` };
  }

  const s = report.summary;
  if (s.totalSpecifications === 0) {
    return { ...base, status: 'error', error: 'declares zero specifications', ...s };
  }

  const evaluated = s.passedSpecifications + s.failedSpecifications;
  const status: CheckStatus = s.failedSpecifications > 0 ? 'fail' : evaluated > 0 ? 'pass' : 'error';

  return {
    ...base,
    status,
    ...s,
    ...(status === 'error' ? { error: 'every specification was not-applicable — nothing was evaluated' } : {}),
  };
}
