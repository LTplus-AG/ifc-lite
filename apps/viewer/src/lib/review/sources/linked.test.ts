/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Resolution, SemanticDocument, ValidationFinding } from '@ifc-lite/semantic';
import { fakeModel } from '../test-support';
import { linkedFindings } from './linked';

const models = [fakeModel('m1', 'arch.ifc', ['W1', 'W2'])];
const document = (completeness: string) => ({ profile: 'dpp', completeness, resources: [
  { id: 'r1', type: 'Wall', label: 'Wall 1', GlobalId: 'W1' }, { id: 'r2', type: 'Wall', label: 'Wall 2', GlobalId: 'W2' },
  { id: 'r3', type: 'Wall', label: 'Wall 3', GlobalId: 'W2' }] }) as unknown as SemanticDocument;
const finding = (resourceId: string): ValidationFinding =>
  ({ engine: 'shacl', resourceId, path: '/p', message: `bad ${resourceId}`, severity: 'Violation' }) as unknown as ValidationFinding;
const resolutions: Record<string, Resolution> = {
  r1: { status: 'resolved', ref: { modelId: 'm1', expressId: 1 } } as Resolution,
  r2: { status: 'ambiguous', candidates: [] } as unknown as Resolution,
  r3: { status: 'unmatched' } as unknown as Resolution,
};
const input = (completeness: string, truncated = false) => ({ document: document(completeness), findings: ['r1', 'r2', 'r3'].map(finding),
  reportTruncated: truncated, retrievedAt: '2026-01-01T00:00:00Z', resolve: (resource: { id: string }) => resolutions[resource.id] });

test('identity comes only from the native resolver: resolved is placed, ambiguous and unmatched are never re-matched by GlobalId', () => {
  const [r1, r2, r3] = linkedFindings(input('complete'), models).findings;
  assert.deepEqual(r1.elements, [{ globalId: 'W1', modelId: 'm1', modelName: 'arch.ifc' }]);
  assert.equal(r2.elements[0].nativeUnresolved, 'ambiguous');
  assert.equal(r3.elements[0].nativeUnresolved, 'unmatched');
});

test('a partial document or a truncated report is an incomplete run', () => {
  assert.deepEqual(linkedFindings(input('partial', true), models).runs[0].incomplete.map(gap => gap.code), ['partial-source', 'truncated']);
  assert.equal(linkedFindings(input('complete'), models).runs[0].complete, true);
});

test('no findings or no document contributes nothing', () => {
  assert.deepEqual(linkedFindings(null, models), { runs: [], findings: [] });
});
