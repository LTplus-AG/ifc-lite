/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clashReviewKey, type Clash } from '@ifc-lite/clash';
import {
  MANUAL_CLASH_GROUPS_KEY,
  defaultManualClashGroupName,
  loadManualClashGroups,
  manualClashMember,
  normalizeManualClashGroups,
  resolveManualClashGroups,
  removeResolvedManualClashMember,
  saveManualClashGroups,
} from './manual-groups.js';

function clash(id: string, shared = false): Clash {
  return {
    id,
    a: { key: shared ? 'shared' : `${id}-a`, ref: 1, model: 'm', tag: 'IfcWall', name: shared ? 'Core wall' : undefined },
    b: { key: `${id}-b`, ref: 2, model: 'm', tag: 'IfcPipeSegment' },
    rule: 'all', status: 'hard', distance: -0.1, point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] }, severity: 'major',
  };
}

describe('manual clash groups (#4921)', () => {
  beforeEach(() => localStorage.removeItem(MANUAL_CLASH_GROUPS_KEY));

  it('persists durable clash keys and restores them after panel/reload state is recreated', () => {
    const groups = [{ id: 'manual-1', name: 'Riser issue', members: [
      { reviewKey: 'key-1', occurrenceKey: 'occurrence-1' },
      { reviewKey: 'key-2', occurrenceKey: 'occurrence-2' },
    ] }];
    assert.deepEqual(saveManualClashGroups(groups), { ok: true });
    assert.deepEqual(loadManualClashGroups(), groups);
  });

  it('quarantines unreadable saved groups before accepting a replacement (#4921 review)', () => {
    const unreadable = '{not-json';
    localStorage.setItem(MANUAL_CLASH_GROUPS_KEY, unreadable);

    assert.deepEqual(loadManualClashGroups(), []);
    assert.equal(localStorage.getItem(MANUAL_CLASH_GROUPS_KEY), null);
    assert.equal(localStorage.getItem(`${MANUAL_CLASH_GROUPS_KEY}:unreadable`), unreadable);

    const groups = [{ id: 'manual-1', name: 'Recovered', members: [
      { reviewKey: 'key-1', occurrenceKey: 'occurrence-1' },
    ] }];
    assert.deepEqual(saveManualClashGroups(groups), { ok: true });
    assert.deepEqual(loadManualClashGroups(), groups);
  });

  it('keeps absent keys and resolves a rerun even when transient clash ids change', () => {
    const first = clash('first');
    const absent = clash('absent');
    const definitions = [{ id: 'manual-1', name: 'Riser issue', members: [manualClashMember(first), manualClashMember(absent)] }];
    const rerun = { ...first, id: 'different-runtime-id' };
    const resolved = resolveManualClashGroups(definitions, [rerun]);
    assert.deepEqual(resolved[0].members.map((member) => member.id), ['different-runtime-id']);
    assert.deepEqual(resolved[0].definition.members, definitions[0].members);
  });

  it('keeps model-qualified occurrences when durable review keys collide', () => {
    const first = clash('first');
    const second = clash('second');
    second.a = { ...first.a, model: 'other-a' };
    second.b = { ...first.b, model: 'other-b' };
    assert.equal(clashReviewKey(first), clashReviewKey(second));

    const definitions = [{ id: 'manual-1', name: 'Both copies', members: [
      manualClashMember(first), manualClashMember(second),
    ] }];
    assert.deepEqual(
      resolveManualClashGroups(definitions, [first, second])[0].members.map((member) => member.id),
      ['first', 'second'],
    );
  });

  it('reserves later exact occurrences before assigning stale fallbacks (#4921 review)', () => {
    const stale = clash('stale');
    const exact = clash('exact');
    exact.a = { ...stale.a, model: 'current-a' };
    exact.b = { ...stale.b, model: 'current-b' };
    const definitions = [
      { id: 'stale-group', name: 'Stale', members: [manualClashMember(stale)] },
      { id: 'exact-group', name: 'Exact', members: [manualClashMember(exact)] },
    ];

    const resolved = resolveManualClashGroups(definitions, [exact]);
    assert.deepEqual(resolved.map((group) => group.definition.id), ['exact-group']);
    assert.equal(resolved[0].members[0].id, 'exact');
  });

  it('removes every stale duplicate claim after one ambiguous fallback (#4921 review)', () => {
    const first = clash('first');
    const second = clash('second');
    second.a = { ...first.a, model: 'old-a-2' };
    second.b = { ...first.b, model: 'old-b-2' };
    const definitions = [{ id: 'manual-1', name: 'Both copies', members: [
      manualClashMember(first), manualClashMember(second),
    ] }];
    const rerun = clash('rerun');
    rerun.a = { ...first.a, model: 'new-a' };
    rerun.b = { ...first.b, model: 'new-b' };
    const resolved = resolveManualClashGroups(definitions, [rerun]);
    assert.equal(resolved[0].members.length, 1, 'one stale record falls back to the only current clash');
    assert.deepEqual(removeResolvedManualClashMember(definitions, resolved, 'manual-1', rerun), [],
      'the sibling stale record cannot immediately claim the removed clash');
  });

  it('removes stale duplicate claims without deleting an exact sibling (#4921 review)', () => {
    const stale = clash('stale');
    const exact = clash('exact');
    exact.a = { ...stale.a, model: 'exact-a' };
    exact.b = { ...stale.b, model: 'exact-b' };
    const fallback = clash('fallback');
    fallback.a = { ...stale.a, model: 'fallback-a' };
    fallback.b = { ...stale.b, model: 'fallback-b' };
    const definitions = [{ id: 'manual-1', name: 'Copies', members: [
      manualClashMember(stale), manualClashMember(exact),
    ] }];
    const resolved = resolveManualClashGroups(definitions, [fallback, exact]);
    assert.deepEqual(resolved[0].members.map((member) => member.id), ['fallback', 'exact']);

    assert.deepEqual(
      removeResolvedManualClashMember(definitions, resolved, 'manual-1', fallback),
      [{ id: 'manual-1', name: 'Copies', members: [manualClashMember(exact)] }],
    );
  });

  it('removes stale same-review claims when deleting the exact occurrence (#4921 review)', () => {
    const stale = clash('stale');
    const exact = clash('exact');
    exact.a = { ...stale.a, model: 'exact-a' };
    exact.b = { ...stale.b, model: 'exact-b' };
    const definitions = [{ id: 'manual-1', name: 'Copies', members: [
      manualClashMember(stale), manualClashMember(exact),
    ] }];
    const resolved = resolveManualClashGroups(definitions, [exact]);
    assert.deepEqual(resolved[0].members.map((member) => member.id), ['exact']);

    assert.deepEqual(removeResolvedManualClashMember(definitions, resolved, 'manual-1', exact), [],
      'the stale claim must not make the deleted exact occurrence reappear');
  });

  it('repairs overlapping/corrupt storage into disjoint named groups', () => {
    assert.deepEqual(normalizeManualClashGroups({ groups: [
      { id: 'g1', name: ' First ', clashKeys: ['c1', 'c1', 'c2', 7] },
      { id: 'g2', name: 'Second', clashKeys: ['c2', 'c3'] },
      { id: 'g3', name: ' ', clashKeys: ['c4'] },
    ] }), [
      { id: 'g1', name: 'First', members: [
        { reviewKey: 'c1', occurrenceKey: '' },
        { reviewKey: 'c2', occurrenceKey: '' },
      ] },
      { id: 'g2', name: 'Second', members: [{ reviewKey: 'c3', occurrenceKey: '' }] },
    ]);
  });

  it('keeps a legacy review-key claim disjoint from v2 occurrence records', () => {
    const current = clash('current');
    const member = manualClashMember(current);
    assert.deepEqual(normalizeManualClashGroups({ groups: [
      { id: 'legacy', name: 'Legacy', clashKeys: [member.reviewKey] },
      { id: 'v2', name: 'Duplicate', members: [member] },
    ] }), [{
      id: 'legacy',
      name: 'Legacy',
      members: [{ reviewKey: member.reviewKey, occurrenceKey: '' }],
    }]);
  });

  it('uses a shared element name as the default group name', () => {
    assert.equal(defaultManualClashGroupName([clash('c1', true), clash('c2', true)], 3), 'Core wall');
    assert.equal(defaultManualClashGroupName([clash('c1'), clash('c2')], 3), 'Clash group 3');
  });

});
