/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveZoneSelection } from './useZoneSelection.js';
import type { ZoneAssignment, ZoneAssignmentsByElement } from '@/lib/zones/types';

function assignment(overrides: Partial<ZoneAssignment>): ZoneAssignment {
  return { zoneId: null, zoneName: null, straddles: false, touchedZoneIds: [], ...overrides };
}

const SET = 'set-1';

function makeAssignments(): ZoneAssignmentsByElement {
  return new Map([
    [1, { [SET]: assignment({ zoneId: 'a', zoneName: 'A', touchedZoneIds: ['a'] }) }],
    [2, { [SET]: assignment({ zoneId: 'b', zoneName: 'B', straddles: true, touchedZoneIds: ['a', 'b'] }) }],
    [3, { [SET]: assignment({}) }], // unassigned bucket
    [4, { [SET]: assignment({ zoneId: 'a', zoneName: 'A', touchedZoneIds: ['a'] }) }],
  ]);
}

const resolveAll = (globalId: number) => ({ modelId: 'm1', expressId: globalId });

describe('zones/resolveZoneSelection (PR #1869 review: channels must not diverge)', () => {
  it('selects direct members plus straddlers touching the zone', () => {
    const { globalIds, refs } = resolveZoneSelection(makeAssignments(), SET, 'a', resolveAll);
    assert.deepStrictEqual(globalIds, [1, 2, 4]);
    assert.deepStrictEqual(refs.map((r) => r.expressId), [1, 2, 4]);
  });

  it('zoneId null selects only the unassigned bucket', () => {
    const { globalIds } = resolveZoneSelection(makeAssignments(), SET, null, resolveAll);
    assert.deepStrictEqual(globalIds, [3]);
  });

  it('drops unresolvable ids from BOTH channels so the count matches what is highlighted', () => {
    // Element 2's model was unloaded: fromGlobalId no longer resolves it.
    const resolveExcept2 = (globalId: number) => (globalId === 2 ? null : resolveAll(globalId));
    const { globalIds, refs } = resolveZoneSelection(makeAssignments(), SET, 'a', resolveExcept2);
    // Previously globalIds kept 2 (highlight channel + toast count) while
    // refs silently dropped it (model-aware channel) — the channels diverged.
    assert.deepStrictEqual(globalIds, [1, 4]);
    assert.strictEqual(refs.length, globalIds.length);
    assert.deepStrictEqual(refs.map((r) => r.expressId), [1, 4]);
  });

  it('an unknown zone set matches nothing', () => {
    const { globalIds, refs } = resolveZoneSelection(makeAssignments(), 'nope', 'a', resolveAll);
    assert.deepStrictEqual(globalIds, []);
    assert.deepStrictEqual(refs, []);
  });
});
