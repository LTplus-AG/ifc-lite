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
 * Shape of `bim.ids.validate()`'s real return value that this file needs.
 * `ids.validate` is typed `Promise<unknown>` (the SDK namespace stays
 * decoupled from `@ifc-lite/ids` at compile time), so this is the minimal
 * structural contract this file relies on — kept narrow deliberately so a
 * real shape mismatch (see below on why that bit us before) fails to
 * compile rather than silently reading `undefined` off the wrong field
 * names.
 */
interface IdsSpecificationResult {
  status?: 'pass' | 'fail' | 'not_applicable';
  entityResults: Array<{ passed: boolean }>;
  /** Present whenever the specification declares `minOccurs`/`maxOccurs`. */
  cardinalityResult?: {
    actualCount: number;
    minExpected?: number;
    maxExpected?: number | 'unbounded';
  };
}

interface IdsValidateReport {
  specificationResults: IdsSpecificationResult[];
}

/**
 * A specification counts as genuinely evaluated only when its cardinality
 * bound could actually have been violated by SOME entity count, or it
 * checked at least one entity's requirements. `minOccurs="0"` with no
 * finite upper bound (the IDS "optional, if present" cardinality) is
 * satisfied by zero matches for every possible model — no entity count
 * could ever fail it — so treating that as `pass` reports success for a
 * rule that could not possibly have failed and checked nothing. That is
 * distinct from a `maxOccurs="0"` prohibition ("must not exist"), which a
 * nonzero applicable count WOULD have violated, so zero matches there is
 * real evidence, not a vacuous result — `@ifc-lite/ids`'s own corpus fixture
 * `pass-prohibited_specifications_passes_if_the_applicability_does_not_matches.ids`
 * exercises exactly this and must keep reading `pass`.
 */
function isVacuousSpecification(spec: IdsSpecificationResult): boolean {
  if (spec.status === 'not_applicable') return true;
  const c = spec.cardinalityResult;
  if (!c || c.actualCount !== 0) return false;
  return c.minExpected === 0 && (c.maxExpected === undefined || c.maxExpected === 'unbounded');
}

interface IdsReportSummary {
  totalSpecifications: number;
  passedSpecifications: number;
  failedSpecifications: number;
  notApplicableSpecifications: number;
  totalEntities: number;
  passedEntities: number;
  failedEntities: number;
}

/**
 * Summarize a real `IDSValidationReport` for the delivery checker.
 *
 * This intentionally does NOT call `bim.ids.summarize()` (`@ifc-lite/sdk`)
 * for the specification-level bucketing: that helper defers entirely to
 * the validator's own per-specification `status`, and the validator marks
 * a `minOccurs="0"`/unbounded-`maxOccurs` specification `pass` whenever it
 * matches zero entities (see `isVacuousSpecification` above) — correct IDS
 * semantics for an "optional" clause, but exactly the vacuous-check defect
 * a delivery checker must not fold into `pass`. Entity counts ARE summed
 * directly here for the same reason `bim.ids.summarize()` would need
 * `includePassingEntities: true` to get them right: that option controls
 * whether PASSING entities are even present in `entityResults`, and this
 * file used to call `validate()` with it `false`, which is harmless for the
 * raw validator's own `summary.totalEntitiesChecked` (computed from each
 * specification's `passedCount`/`failedCount`, not from `entityResults`)
 * but would silently undercount any per-entity tally derived from
 * `entityResults` directly, `bim.ids.summarize()` included.
 */
function summarizeIdsReport(report: IdsValidateReport): IdsReportSummary {
  let passedSpecifications = 0;
  let failedSpecifications = 0;
  let notApplicableSpecifications = 0;
  let totalEntities = 0;
  let passedEntities = 0;
  let failedEntities = 0;

  for (const spec of report.specificationResults) {
    for (const entity of spec.entityResults) {
      totalEntities++;
      if (entity.passed) passedEntities++;
      else failedEntities++;
    }

    if (spec.status === 'fail') {
      failedSpecifications++;
    } else if (isVacuousSpecification(spec)) {
      notApplicableSpecifications++;
    } else {
      passedSpecifications++;
    }
  }

  return {
    totalSpecifications: report.specificationResults.length,
    passedSpecifications,
    failedSpecifications,
    notApplicableSpecifications,
    totalEntities,
    passedEntities,
    failedEntities,
  };
}

/**
 * Run one IDS rule file against one already-loaded model.
 *
 * `status` is `error` when the IDS file itself could not be read/parsed, or
 * when it declares zero specifications (nothing was actually evaluated —
 * reporting that as `pass` would hide an empty ruleset behind a green
 * check). Otherwise `fail` iff at least one specification failed; a
 * specification whose applicability matched no entities counts as neither
 * pass nor fail (`notApplicableSpecifications`) — if EVERY specification
 * lands there (nothing was definitively satisfied OR violated), the check
 * reports `error` rather than a `pass` that would rest on zero actual
 * evidence.
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
  let report: IdsValidateReport;
  try {
    report = (await ids.validate(idsDoc, {
      accessor,
      modelInfo: { schemaVersion: store.schemaVersion },
      locale: 'en',
      includePassingEntities: true,
    })) as IdsValidateReport;
  } catch (err) {
    return { ...base, status: 'error', error: `validation failed: ${(err as Error).message}` };
  }

  const s = summarizeIdsReport(report);
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
