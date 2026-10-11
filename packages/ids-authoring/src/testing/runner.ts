/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IDS test runner (headless). It owns the bookkeeping: which cases
 * to run, comparing each outcome with its expectation, and the report.
 * Turning a fixture into a verdict is the host's `evaluate` callback:
 * `@ifc-lite/ids-testgen` provides one that builds or loads the IFC and
 * runs `@ifc-lite/ids`' validator; the viewer can pass its worker.
 *
 * A case passes when the specification reports the expected status
 * and, for `fail` cases with `expectFailureOn`, exactly those
 * requirement facets fail.
 */

import type { IDSSpecification } from '@ifc-lite/ids';
import type { StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import type { TestCase, TestExpectation } from './types.js';

/** What the specification reported on a fixture. */
export interface SpecOutcome {
  status: TestExpectation;
  /** Requirement node ids that failed on at least one applicable element. */
  failedRequirements: Uuid[];
  applicableCount: number;
}

export type EvaluateResult = SpecOutcome | { unsupported: string } | { error: string };

export type CaseEvaluator = (input: { doc: StudioDocument; spec: IDSSpecification; testCase: TestCase }) => Promise<EvaluateResult>;

export type CaseVerdict = 'passed' | 'failed' | 'error' | 'skipped';

export interface CaseResult {
  specId: Uuid;
  specName: string;
  testId: Uuid;
  name: string;
  expect: TestExpectation;
  verdict: CaseVerdict;
  outcome?: SpecOutcome;
  /** Why it failed, errored or was skipped. */
  message?: string;
  durationMs: number;
}

export interface TestRunReport {
  results: CaseResult[];
  summary: { total: number; passed: number; failed: number; error: number; skipped: number };
}

export interface RunOptions {
  /** Only these specifications (default: all with a suite). */
  specIds?: readonly Uuid[];
  /** Called after each case (progress UI). */
  onCase?: (result: CaseResult, index: number, total: number) => void;
  /** Clock for durations (tests pass a fake). */
  now?: () => number;
}

/** Compare an outcome with a case's expectation; `undefined` means it holds. */
export function expectationMismatch(testCase: TestCase, outcome: SpecOutcome): string | undefined {
  if (outcome.status !== testCase.expect) {
    return `expected ${testCase.expect}, the specification reported ${outcome.status} (${outcome.applicableCount} applicable)`;
  }
  if (testCase.expect === 'fail' && testCase.expectFailureOn?.length) {
    const want = [...testCase.expectFailureOn].sort();
    const got = [...new Set(outcome.failedRequirements)].sort();
    if (want.join() !== got.join()) return `expected failures on [${want.join(', ')}], got [${got.join(', ')}]`;
  }
  return undefined;
}

/** Every case of the selected suites, in document order. */
export function selectCases(doc: StudioDocument, specIds?: readonly Uuid[]): { spec: IDSSpecification; testCase: TestCase }[] {
  const wanted = specIds ? new Set(specIds) : undefined;
  const out: { spec: IDSSpecification; testCase: TestCase }[] = [];
  for (const spec of doc.ids.specifications) {
    if (wanted && !wanted.has(spec.id)) continue;
    for (const testCase of doc.meta.tests[spec.id]?.cases ?? []) out.push({ spec, testCase });
  }
  return out;
}

export async function runTestSuites(doc: StudioDocument, evaluate: CaseEvaluator, options: RunOptions = {}): Promise<TestRunReport> {
  const now = options.now ?? (() => Date.now());
  const cases = selectCases(doc, options.specIds);
  const results: CaseResult[] = [];
  for (const [i, { spec, testCase }] of cases.entries()) {
    const start = now();
    const base = { specId: spec.id, specName: spec.name, testId: testCase.id, name: testCase.name, expect: testCase.expect };
    let result: CaseResult;
    try {
      const r = await evaluate({ doc, spec, testCase });
      if ('unsupported' in r) result = { ...base, verdict: 'skipped', message: r.unsupported, durationMs: now() - start };
      else if ('error' in r) result = { ...base, verdict: 'error', message: r.error, durationMs: now() - start };
      else {
        const mismatch = expectationMismatch(testCase, r);
        result = { ...base, verdict: mismatch ? 'failed' : 'passed', outcome: r, ...(mismatch ? { message: mismatch } : {}), durationMs: now() - start };
      }
    } catch (err) {
      result = { ...base, verdict: 'error', message: err instanceof Error ? err.message : String(err), durationMs: now() - start };
    }
    results.push(result);
    options.onCase?.(result, i, cases.length);
  }
  const count = (v: CaseVerdict) => results.filter((r) => r.verdict === v).length;
  return {
    results,
    summary: { total: results.length, passed: count('passed'), failed: count('failed'), error: count('error'), skipped: count('skipped') },
  };
}
