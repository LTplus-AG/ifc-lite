/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitSelectionGroups, selectionGroupBaseline } from './selection-group-admission';

const pin = { modelId: 'a', status: 'available', expectedJsonParts: ['{"scope":"no-group-context"}'] };
const refused = { modelId: 'b', status: 'unavailable-complete-graph', expectedJsonParts: null };
const original = { kind: 'selection', nativeGroups: [pin, refused], byModel: [] };
const hasAvailable = (summary: unknown) => JSON.stringify(summary).includes('"available"');

test('#7346 Group status entries are left out of the baseline and admitted after rows, in adapter key order', () => {
  const baseline = selectionGroupBaseline(original) as Record<string, unknown>;
  assert.equal('nativeGroups' in baseline, false);
  const statusOnly = admitSelectionGroups(original, baseline, summary => !hasAvailable(summary));
  assert.equal(statusOnly.omitted, false);
  assert.deepEqual(Object.keys(statusOnly.summary as object), ['kind', 'nativeGroups', 'byModel']);
  assert.deepEqual((statusOnly.summary as typeof original).nativeGroups,
    [{ ...pin, status: 'unavailable-transport-budget', expectedJsonParts: null }, refused]);
  assert.deepEqual(admitSelectionGroups(original, baseline, () => true), { summary: original, omitted: false });
});

test('#7346 when not even the Group status fits, nativeGroups is absent and the omission is reported', () => {
  const baseline = selectionGroupBaseline(original);
  assert.deepEqual(admitSelectionGroups(original, baseline, () => false), { summary: baseline, omitted: true });
});
