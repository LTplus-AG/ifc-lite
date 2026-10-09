/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framework-free view model of the test suites ("Run tests" panel): one
 * row per specification with its cases and, after a run, their verdicts.
 */

import type { StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import type { CaseVerdict, TestRunReport } from './runner.js';
import type { TestExpectation, TestFixture } from './types.js';

export interface TestCaseRow {
  testId: Uuid;
  name: string;
  expect: TestExpectation;
  fixture: TestFixture['kind'];
  verdict?: CaseVerdict;
  message?: string;
}

export interface TestSuiteRow {
  specId: Uuid;
  specName: string;
  /** `untested`: no suite; `notRun`: suite, no result yet. */
  status: 'untested' | 'notRun' | 'passing' | 'failing';
  cases: TestCaseRow[];
}

export interface TestSuitesView {
  rows: TestSuiteRow[];
  /** Specifications with at least one case. */
  covered: number;
  total: number;
}

export function testSuitesView(doc: StudioDocument, report?: TestRunReport): TestSuitesView {
  const results = new Map((report?.results ?? []).map((r) => [r.testId, r]));
  const rows = doc.ids.specifications.map((spec): TestSuiteRow => {
    const cases = (doc.meta.tests[spec.id]?.cases ?? []).map((c): TestCaseRow => {
      const r = results.get(c.id);
      return {
        testId: c.id,
        name: c.name,
        expect: c.expect,
        fixture: c.fixture.kind,
        ...(r ? { verdict: r.verdict } : {}),
        ...(r?.message ? { message: r.message } : {}),
      };
    });
    const ran = cases.filter((c) => c.verdict);
    const status: TestSuiteRow['status'] = !cases.length
      ? 'untested'
      : !ran.length
        ? 'notRun'
        : ran.some((c) => c.verdict === 'failed' || c.verdict === 'error')
          ? 'failing'
          : 'passing';
    return { specId: spec.id, specName: spec.name, status, cases };
  });
  return { rows, covered: rows.filter((r) => r.cases.length).length, total: rows.length };
}
