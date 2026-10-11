/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-suite model and runner (IDS-110).
 *
 * Oracle: buildingSMART's IDS corpus, which is itself a test suite (IDS +
 * IFC + expected verdict). Each corpus pair becomes a Studio document with
 * one `file` test case expecting the corpus verdict; the runner, driven by
 * the real validator, must pass every case, and fail every case once the
 * expectation is flipped through ops.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { IfcParser } from '@ifc-lite/parser';
import { describe, expect, it } from 'vitest';
import { counterIds, loadCorpus } from '../../test/corpus.js';
import { fromIdsDocument } from '../document/from-ids.js';
import type { StudioDocument } from '../document/types.js';
import { checkOps } from '../gate/check.js';
import { createGateContext } from '../gate/context.js';
import type { PrimitiveOp, StudioOp } from '../ops/types.js';
import { apply } from '../reducer/apply.js';
import { junitXml } from './junit.js';
import { outcomeFromSpecResult } from './outcome.js';
import { runTestSuites, type CaseEvaluator } from './runner.js';
import { testSuitesView } from './view.js';

const ids = counterIds(0x7e5);
const op = <K extends PrimitiveOp['kind']>(kind: K, payload: Extract<PrimitiveOp, { kind: K }>['payload']): StudioOp =>
  ({ kind, opId: ids(), payload }) as StudioOp;

const CORPUS = fileURLToPath(new URL('../../../ids/src/__corpus__/buildingsmart-ids/', import.meta.url));

/** Evaluate `file` fixtures from the corpus directory with the real validator. */
const evaluateFile: CaseEvaluator = async ({ spec, testCase }) => {
  if (testCase.fixture.kind !== 'file') return { unsupported: `${testCase.fixture.kind} fixtures need @ifc-lite/ids-testgen` };
  const bytes = readFileSync(join(CORPUS, testCase.fixture.path));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const report = await validateIDS({ info: { title: 't' }, specifications: [spec] }, createDataAccessor(store), {
    modelId: testCase.fixture.path,
    schemaVersion: String(store.schemaVersion ?? 'IFC4'),
    entityCount: 0,
  });
  return outcomeFromSpecResult(report.specificationResults[0]);
};

function corpusSuite(count: number): StudioDocument {
  const cases = loadCorpus().filter((_, i) => i % Math.floor(loadCorpus().length / count) === 0).slice(0, count);
  let doc = fromIdsDocument({ info: { title: 'corpus' }, specifications: cases.flatMap((c) => c.ids.specifications) }, { newId: ids });
  const ops = cases.map((c, i) =>
    op('meta.test.add', {
      specId: doc.ids.specifications[i].id,
      testCase: {
        id: ids(),
        name: c.name,
        fixture: { kind: 'file', path: c.name.replace(/\.ids$/, '.ifc') },
        expect: c.name.includes('/pass-') ? 'pass' : 'fail',
      },
    }),
  );
  doc = apply(doc, ops).doc;
  return doc;
}

describe('runTestSuites', () => {
  it('passes every corpus case with the corpus verdict, fails every flipped one', async () => {
    const doc = corpusSuite(40);
    const report = await runTestSuites(doc, evaluateFile);
    expect(report.summary).toEqual({ total: 40, passed: 40, failed: 0, error: 0, skipped: 0 });
    const flips = Object.values(doc.meta.tests).flatMap((s) => s.cases).map((c) => op('meta.test.setExpectation', { testId: c.id, expect: c.expect === 'pass' ? 'fail' : 'pass', expectFailureOn: null }));
    const flipped = await runTestSuites(apply(doc, flips).doc, evaluateFile);
    expect(flipped.summary.failed).toBe(40);
    expect(flipped.results.every((r) => /^expected (pass|fail), the specification reported (fail|pass)/.test(r.message ?? ''))).toBe(true);
  }, 120_000);

  it('checks expectFailureOn exactly', async () => {
    const doc = corpusSuite(60);
    const report = await runTestSuites(doc, evaluateFile);
    const failing = report.results.find((r) => r.expect === 'fail' && r.outcome && r.outcome.failedRequirements.length > 0);
    expect(failing).toBeDefined();
    if (!failing?.outcome) return;
    const exact = apply(doc, [op('meta.test.setExpectation', { testId: failing.testId, expect: 'fail', expectFailureOn: failing.outcome.failedRequirements })]).doc;
    const ok = await runTestSuites(exact, evaluateFile, { specIds: [failing.specId] });
    expect(ok.summary.passed).toBe(1);
    const wrong = apply(doc, [op('meta.test.setExpectation', { testId: failing.testId, expect: 'fail', expectFailureOn: [ids()] })]).doc;
    const bad = await runTestSuites(wrong, evaluateFile, { specIds: [failing.specId] });
    expect(bad.results[0]).toMatchObject({ verdict: 'failed', message: expect.stringMatching(/^expected failures on/) });
  }, 120_000);

  it('reports unsupported fixtures as skipped and evaluator crashes as errors', async () => {
    const doc = corpusSuite(3);
    const specId = doc.ids.specifications[0].id;
    const withSynthetic = apply(doc, [
      op('meta.test.add', { specId, testCase: { id: ids(), name: 'generated', fixture: { kind: 'synthetic', recipe: { generator: 'ids-testgen/1', ifcVersion: 'IFC4', variant: { kind: 'pass' } } }, expect: 'pass' } }),
    ]).doc;
    const report = await runTestSuites(withSynthetic, evaluateFile);
    expect(report.summary).toMatchObject({ total: 4, passed: 3, skipped: 1 });
    const crash = await runTestSuites(doc, async () => {
      throw new Error('worker died');
    });
    expect(crash.results.map((r) => [r.verdict, r.message])).toEqual(Array(3).fill(['error', 'worker died']));
  }, 60_000);

  it('writes JUnit XML with one suite per specification', async () => {
    const doc = corpusSuite(4);
    const flips = [op('meta.test.setExpectation', { testId: Object.values(doc.meta.tests)[0].cases[0].id, expect: 'notApplicable', expectFailureOn: null })];
    const report = await runTestSuites(apply(doc, flips).doc, evaluateFile, { now: () => 0 });
    const xml = junitXml(report, { name: 'Fire & safety <IDS>\u0007' });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Fire &amp; safety &lt;IDS&gt;" tests="4" failures="1" errors="0" skipped="0" time="0.000">')).toBe(true);
    expect(xml.match(/<testsuite /g)).toHaveLength(4);
    expect(xml.match(/<testcase /g)).toHaveLength(4);
    expect(xml.match(/<failure /g)).toHaveLength(1);
    expect(xml.endsWith('</testsuites>\n')).toBe(true);
  }, 60_000);
});

describe('test-suite ops and view model', () => {
  it('gate-checks test ops and the view shows coverage and verdicts', async () => {
    const ctx = await createGateContext();
    const doc = corpusSuite(3);
    const reqId = doc.ids.specifications[1].requirements[0]?.id ?? ids();
    const bad = checkOps(
      [
        op('meta.test.add', { specId: ids(), testCase: { id: ids(), name: 'x', fixture: { kind: 'file', path: 'x.ifc' }, expect: 'pass' } }),
        op('meta.test.add', { specId: doc.ids.specifications[0].id, testCase: { id: ids(), name: 'x', fixture: { kind: 'file', path: 'x.ifc' }, expect: 'pass', expectFailureOn: [reqId] } }),
      ],
      doc,
      ctx,
    );
    expect(bad.issues.map((i) => i.code)).toEqual(['GATE-STR-001', 'GATE-STR-003']);
    const before = testSuitesView(doc);
    expect(before.covered).toBe(3);
    expect(before.rows.map((r) => r.status)).toEqual(['notRun', 'notRun', 'notRun']);
    const report = await runTestSuites(doc, evaluateFile);
    const after = testSuitesView(doc, report);
    expect(after.rows.map((r) => r.status)).toEqual(['passing', 'passing', 'passing']);
    const removed = apply(doc, [op('meta.test.remove', { testId: after.rows[0].cases[0].testId })]).doc;
    expect(testSuitesView(removed).rows[0].status).toBe('untested');
  }, 60_000);
});
