/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APPEARANCE_SETTINGS } from '../settings.js';
import type { AppearanceAssignment } from './types.js';
import { compareAssignmentMembership, resolveAppearanceAssignments } from './resolve.js';
function row(id: string, modelId: string, ids: number[], excluded: number[] = []): AppearanceAssignment {
  return { id, model: { slotId: `slot-${modelId}`, modelId, name: modelId, sourceSha256: 'a'.repeat(64), revision: 'reviewed' },
    source: { id: 'b'.repeat(64), name: 'Brick', width: 100, height: 100 },
    settings: { ...DEFAULT_APPEARANCE_SETTINGS }, query: { kind: 'model' },
    members: ids.map(expressId => ({ expressId, GlobalId: `guid-${expressId}` })),
    excludedGlobalIds: excluded.map(id => `guid-${id}`) };
}
describe('ordered appearance assignment scope #4420', () => {
  it('keeps colliding local IDs in two explicitly pinned models independent', () => {
    const rows = [row('base-a', 'a', [10, 11]), row('base-b', 'b', [10, 11]), row('override-a', 'a', [10])];
    assert.deepEqual(resolveAppearanceAssignments(rows).map(r => r.productIds), [[11], [10, 11], [10]]);
    assert.deepEqual(rows[0].members.map(p => p.expressId), [10, 11]);
  });
  it('row exclusions expose earlier assignments and reordered rows change the winner', () => {
    const base = row('base', 'a', [10, 11]), top = row('top', 'a', [10, 11], [11]);
    const result = resolveAppearanceAssignments([base, top]);
    assert.deepEqual(result.map(r => [r.productIds, r.excluded, r.overridden]), [[[11], 0, 1], [[10], 1, 0]]);
    assert.deepEqual(resolveAppearanceAssignments([top, base]).map(r => r.productIds), [[], [10, 11]]);
  });
  it('rejects mixed revisions, stale exclusions and conflicting object identities before planning', () => {
    const first = row('first', 'a', [10]), other = row('other', 'a', [10]);
    other.model.revision = 'changed';
    assert.throws(() => resolveAppearanceAssignments([first, other]), /different versions/);
    other.model.revision = first.model.revision;
    other.members[0].GlobalId = 'replacement';
    assert.throws(() => resolveAppearanceAssignments([first, other]), /identity changed/);
    first.excludedGlobalIds = ['removed'];
    assert.throws(() => resolveAppearanceAssignments([first]), /excluded object/);
  });
  it('reports added, removed and renumbered GlobalIds after an explicitly rebound reload', () => {
    const original = row('original', 'a', [10, 11]).members;
    const current = [{ expressId: 90, GlobalId: 'guid-10' }, { expressId: 11, GlobalId: 'new-object' }];
    assert.deepEqual(compareAssignmentMembership(original, current), {
      added: ['new-object'], removed: ['guid-11'], renumbered: [{ GlobalId: 'guid-10', expressId: 90 }],
    });
    assert.throws(() => compareAssignmentMembership(original, [...current, current[0]]), /unique IFC GlobalIds/);
  });
  it('does not silently bind two different models to one saved slot or accept an unavailable image derivative', () => {
    const a = row('a', 'a', [10]), b = row('b', 'b', [10]);
    b.model.slotId = a.model.slotId;
    assert.throws(() => resolveAppearanceAssignments([a, b]), /different versions/);
    a.source.id = 'document-without-rendered-page';
    assert.throws(() => resolveAppearanceAssignments([a]), /exact image derivative/);
  });
});
