/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { ValidationReport } from '@ifc-lite/ids';
import { fakeModel } from '../test-support';
import { validationFindings } from './validation';

const models = [fakeModel('m1', 'arch.ifc', ['W1', 'W2'], { W1: 'Level 2' })];
const spec = (id: string, entities: unknown[], extra: Record<string, unknown> = {}) => ({
  specification: { id, name: `Spec ${id}`, severity: 'error', applicability: [], requirements: [] }, entityResults: entities, ...extra });
const entity = (expressId: number, passed: boolean, globalId?: string) => ({
  expressId, modelId: 'm1', entityType: 'IfcWall', passed, ...(globalId ? { globalId } : {}),
  requirementResults: passed ? [] : [{ status: 'fail', checkedDescription: 'FireRating exists', failureReason: 'missing' }] });
const report = (specs: unknown[]) => ({ source: { kind: 'ids', document: { info: { title: 'Fire IDS' }, specifications: [] } },
  modelInfo: [{ modelId: 'm1' }], timestamp: new Date(Date.UTC(2026, 0, 1)), specificationResults: specs }) as unknown as ValidationReport;

test('only failed (specification, element) pairs become findings, with native detail and storey', () => {
  const out = validationFindings({ report: report([spec('s1', [entity(1, false), entity(2, true)])]), stale: false }, models);
  assert.equal(out.findings.length, 1);
  const [finding] = out.findings;
  assert.deepEqual([finding.elements[0].globalId, finding.nativeStatus, finding.title, finding.storeys], ['W1', 'failed', 'Spec s1', ['Level 2']]);
  assert.match(finding.detail[0], /FireRating exists · missing/);
  assert.equal(out.runs[0].label, 'Fire IDS');
  assert.equal(out.runs[0].capturedAt, '2026-01-01T00:00:00.000Z');
});

// Invariant: a check that errored or was truncated is an incomplete run, never a clean one.
test('an errored specification, truncated sets or an edit since the run make the run incomplete', () => {
  const out = validationFindings({ report: report([spec('s1', [], { error: 'boom' }), spec('s2', [], { setResultsTruncated: true })]), stale: true }, models);
  assert.deepEqual(out.runs[0].incomplete.map(gap => gap.code), ['check-error', 'sets-truncated', 'stale']);
  assert.equal(out.runs[0].complete, false);
});

test('a failed entity with no GlobalId anywhere has no element and is never merged by id', () => {
  const out = validationFindings({ report: report([spec('s1', [entity(99, false)])]), stale: false }, models);
  assert.deepEqual(out.findings[0].elements, []);
});

test('no report contributes nothing', () => {
  assert.deepEqual(validationFindings(null, models), { runs: [], findings: [] });
});
