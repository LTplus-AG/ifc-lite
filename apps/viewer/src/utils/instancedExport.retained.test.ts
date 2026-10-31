/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7955: the georeferencing panel's KMZ button withholds geometry when `resolveInstancedExportGate` says the export
 * may not proceed. An incomplete or shape-only retained model would export partial meshes as the model, so it says no;
 * a complete, final retained model and an ordinary model are unaffected.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstancedExportGate } from './instancedExport.js';
import type { RetainedGeometrySummary } from '@/store/retainedGeometry';

const FINAL: RetainedGeometrySummary = {
  kernel: 'retained', candidates: 1, started: true, published: 1, refused: [], cancelled: 0, obligationsUnmet: [], completeness: 'complete',
};
const gate = (retainedGeometry?: RetainedGeometrySummary) =>
  resolveInstancedExportGate('m', new Map([['m', { idOffset: 0, maxExpressId: 10, ...(retainedGeometry ? { retainedGeometry } : {}) }]])).canExport;

it('withholds the export of an incomplete or shape-only retained model', () => {
  assert.equal(gate({ ...FINAL, completeness: 'incomplete', published: 0 }), false);
  assert.equal(gate({ ...FINAL, obligationsUnmet: ['IfcAppearance'] }), false);
  assert.equal(gate({ ...FINAL, failure: 'stalled' }), false);
});

it('control: a complete final retained model and a model without a retained summary export', () => {
  assert.equal(gate(FINAL), true);
  assert.equal(gate(undefined), true);
});

// #8415: an unrelated retained model must not withhold the selected exact model's KMZ.
it('scopes the KMZ refusal to the selected model in a mixed session', () => {
  const models = new Map([
    ['exact', { idOffset: 0, maxExpressId: 10 }],
    ['retained', { idOffset: 1_000_000, maxExpressId: 10,
      retainedGeometry: { ...FINAL, completeness: 'incomplete' as const, published: 0 } }],
  ]);
  assert.equal(resolveInstancedExportGate('exact', models).canExport, true);
  assert.equal(resolveInstancedExportGate('retained', models).canExport, false);
  assert.equal(resolveInstancedExportGate(undefined, models).canExport, false, 'an unresolved federated owner still refuses');
});
