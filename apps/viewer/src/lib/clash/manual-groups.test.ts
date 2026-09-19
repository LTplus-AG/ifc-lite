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
  manualClashGroupBcfRefs,
  normalizeManualClashGroups,
  resolveManualClashGroups,
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
    const groups = [{ id: 'manual-1', name: 'Riser issue', clashKeys: ['key-1', 'key-2'] }];
    assert.deepEqual(saveManualClashGroups(groups), { ok: true });
    assert.deepEqual(loadManualClashGroups(), groups);
  });

  it('keeps absent keys and resolves a rerun even when transient clash ids change', () => {
    const first = clash('first');
    const absent = clash('absent');
    const definitions = [{ id: 'manual-1', name: 'Riser issue', clashKeys: [clashReviewKey(first), clashReviewKey(absent)] }];
    const rerun = { ...first, id: 'different-runtime-id' };
    const resolved = resolveManualClashGroups(definitions, [rerun]);
    assert.deepEqual(resolved[0].members.map((member) => member.id), ['different-runtime-id']);
    assert.deepEqual(resolved[0].definition.clashKeys, definitions[0].clashKeys);
  });

  it('repairs overlapping/corrupt storage into disjoint named groups', () => {
    assert.deepEqual(normalizeManualClashGroups({ groups: [
      { id: 'g1', name: ' First ', clashKeys: ['c1', 'c1', 'c2', 7] },
      { id: 'g2', name: 'Second', clashKeys: ['c2', 'c3'] },
      { id: 'g3', name: ' ', clashKeys: ['c4'] },
    ] }), [
      { id: 'g1', name: 'First', clashKeys: ['c1', 'c2'] },
      { id: 'g2', name: 'Second', clashKeys: ['c3'] },
    ]);
  });

  it('uses a shared element name as the default group name', () => {
    assert.equal(defaultManualClashGroupName([clash('c1', true), clash('c2', true)], 3), 'Core wall');
    assert.equal(defaultManualClashGroupName([clash('c1'), clash('c2')], 3), 'Clash group 3');
  });

  it('builds one de-duplicated BCF selection and deterministic A/B colors for the whole group', () => {
    const first = clash('c1');
    const second = clash('c2');
    second.a.ref = first.b.ref;
    second.b.ref = 3;

    assert.deepEqual(manualClashGroupBcfRefs([first, second]), {
      selectedRefs: [1, 2, 3],
      aRefs: [1, 2],
      bRefs: [3],
    });
  });
});
