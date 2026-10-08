/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reducers for `meta.test.*`: the IDS test suites in the sidecar
 * (`meta.tests[specId]`). A case can only be added to a live
 * specification; like comments, a suite outlives its specification so an
 * undo of the removal brings the tests back.
 */

import { locateNode } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { MetaTestAddOp, MetaTestRemoveOp, MetaTestRestoreOp, MetaTestSetExpectationOp } from '../ops/types.js';
import type { TestCase } from '../testing/types.js';
import type { Uuid } from '../uuid.js';
import { insertAt, OpApplyError, removeAt, replaceAt, withKey } from './edit.js';
import { inv, type StepResult } from './spec-ops.js';

export function findTestCase(doc: StudioDocument, testId: Uuid): { specId: Uuid; index: number; testCase: TestCase } | undefined {
  for (const [specId, suite] of Object.entries(doc.meta.tests)) {
    const index = suite.cases.findIndex((c) => c.id === testId);
    if (index >= 0) return { specId, index, testCase: suite.cases[index] };
  }
  return undefined;
}

function withCases(doc: StudioDocument, specId: Uuid, cases: TestCase[]): StudioDocument {
  const tests = { ...doc.meta.tests };
  if (cases.length) tests[specId] = { specId, cases };
  else delete tests[specId];
  return { ...doc, meta: { ...doc.meta, tests } };
}

function insertCase(doc: StudioDocument, specId: Uuid, testCase: TestCase, index: number | undefined): StudioDocument {
  if (findTestCase(doc, testCase.id)) throw new OpApplyError('GATE-STR-001', `test case ${testCase.id} already exists`);
  const cases = doc.meta.tests[specId]?.cases ?? [];
  const at = index ?? cases.length;
  if (!Number.isInteger(at) || at < 0 || at > cases.length) throw new OpApplyError('GATE-STR-006', `test index ${at} is out of range 0..${cases.length}`);
  return withCases(doc, specId, insertAt(cases, at, testCase));
}

export function applyTestAdd(doc: StudioDocument, op: MetaTestAddOp): StepResult {
  const { specId, testCase, index } = op.payload;
  if (locateNode(doc, specId)?.kind !== 'spec') throw new OpApplyError('GATE-STR-001', `unknown specification ${specId}`);
  if (testCase.expectFailureOn?.length && testCase.expect !== 'fail') {
    throw new OpApplyError('GATE-STR-003', 'only a test expecting "fail" can name the requirements that fail');
  }
  return {
    doc: insertCase(doc, specId, testCase, index),
    inverse: [inv(op, 0, 'meta.test.remove', { testId: testCase.id })],
    touched: [specId],
  };
}

export function applyTestRestore(doc: StudioDocument, op: MetaTestRestoreOp): StepResult {
  const { specId, testCase, index } = op.payload;
  return {
    doc: insertCase(doc, specId, testCase, index),
    inverse: [inv(op, 0, 'meta.test.remove', { testId: testCase.id })],
    touched: [specId],
  };
}

export function applyTestRemove(doc: StudioDocument, op: MetaTestRemoveOp): StepResult {
  const site = findTestCase(doc, op.payload.testId);
  if (!site) throw new OpApplyError('GATE-STR-001', `unknown test case ${op.payload.testId}`);
  return {
    doc: withCases(doc, site.specId, removeAt(doc.meta.tests[site.specId].cases, site.index)),
    inverse: [inv(op, 0, 'meta.test.restore', { specId: site.specId, testCase: site.testCase, index: site.index })],
    touched: [site.specId],
  };
}

export function applyTestSetExpectation(doc: StudioDocument, op: MetaTestSetExpectationOp): StepResult {
  const { testId, expect, expectFailureOn } = op.payload;
  const site = findTestCase(doc, testId);
  if (!site) throw new OpApplyError('GATE-STR-001', `unknown test case ${testId}`);
  if (expectFailureOn?.length && expect !== 'fail') {
    throw new OpApplyError('GATE-STR-003', 'only a test expecting "fail" can name the requirements that fail');
  }
  const next = withKey({ ...site.testCase, expect }, 'expectFailureOn', expectFailureOn);
  return {
    doc: withCases(doc, site.specId, replaceAt(doc.meta.tests[site.specId].cases, site.index, next)),
    inverse: [
      inv(op, 0, 'meta.test.setExpectation', {
        testId,
        expect: site.testCase.expect,
        expectFailureOn: site.testCase.expectFailureOn ?? null,
      }),
    ],
    touched: [site.specId],
  };
}
