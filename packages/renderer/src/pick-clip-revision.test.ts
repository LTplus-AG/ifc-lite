/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PickClipRevision } from './pick-clip-revision.js';

it('bumps only when the clip a pick mirrors changes, not on each frame\'s fresh snapshot (#8886)', () => {
  const clip = new PickClipRevision();
  const plane = () => ({ normal: [0, 1, 0] as [number, number, number], distance: 2, flipped: false });
  clip.note({ sectionPlane: null, extraPlanes: null, clipBox: null });
  const none = clip.revision;
  clip.note({ sectionPlane: null, extraPlanes: null, clipBox: null, sectionExcludedIds: new Set() });
  assert.equal(clip.revision, none, 'an unchanged, uncut frame bumped the revision');
  clip.note({ sectionPlane: plane(), extraPlanes: null, clipBox: null });
  const cut = clip.revision;
  assert.ok(cut > none, 'a new cut kept the revision');
  clip.note({ sectionPlane: plane(), extraPlanes: null, clipBox: null }); // the next frame's snapshot: a new object, same cut
  assert.equal(clip.revision, cut);
  // Each entry differs from one fixed baseline in exactly one field. The
  // baseline is noted first, so the revision is settled before each entry
  // and only that entry's own field can bump it.
  const baseline = { sectionPlane: plane(), extraPlanes: null, clipBox: null };
  const changes: Array<[string, Parameters<PickClipRevision['note']>[0]]> = [
    ['distance', { ...baseline, sectionPlane: { ...plane(), distance: 3 } }],
    ['normal', { ...baseline, sectionPlane: { ...plane(), normal: [1, 0, 0] } }],
    ['flipped', { ...baseline, sectionPlane: { ...plane(), flipped: true } }],
    ['sectionPlane removed', { ...baseline, sectionPlane: null }],
    ['extraPlanes', { ...baseline, extraPlanes: [{ normal: [1, 0, 0], distance: 1, flipped: false }] }],
    ['clipBox', { ...baseline, clipBox: { enabled: true, min: [0, 0, 0], max: [1, 1, 1] } }],
    ['sectionExcludedIds', { ...baseline, sectionExcludedIds: new Set([7]) }],
  ];
  for (const [field, change] of changes) {
    clip.note(baseline);
    const settled = clip.revision;
    clip.note(baseline);
    assert.equal(clip.revision, settled, `the baseline itself bumped the revision (before ${field})`);
    clip.note(change);
    assert.equal(clip.revision, settled + 1, `a change to ${field} alone did not bump the revision`);
  }
});

it('a transient (capture) clip moves the revision for its frame only (#9002)', () => {
  const clip = new PickClipRevision();
  const cut = (distance: number) => ({ sectionPlane: { normal: [0, 1, 0] as [number, number, number], distance, flipped: false }, extraPlanes: null, clipBox: null });
  const cleared = { sectionPlane: null, extraPlanes: null, clipBox: null };
  clip.note(cut(2));
  const before = clip.revision;
  clip.note(cleared, true);
  const during = clip.revision;
  assert.notEqual(during, before, 'a pick through the capture\'s cleared clip shares the cut\'s revision');
  clip.note(cleared, true); // a second capture frame in the same run
  assert.equal(clip.revision, during);
  clip.note(cut(2));
  assert.equal(clip.revision, before, 'restoring the pre-capture cut left a new revision');

  // The cut moved while the capture ran: a change against both earlier states.
  clip.note(cleared, true);
  const during2 = clip.revision;
  clip.note(cut(3));
  assert.ok(![before, during, during2].includes(clip.revision), 'a cut moved during a capture reused an earlier revision');

  // The cut was removed while a cleared capture ran: the capture's state is now the real one.
  const moved = clip.revision;
  clip.note(cleared, true);
  const during3 = clip.revision;
  clip.note(cleared);
  assert.equal(clip.revision, during3, 'the now-real cleared clip moved again');
  assert.notEqual(clip.revision, moved);
  // The run has ended: a later normal frame back at cut(3) is a change, not a restore.
  clip.note(cut(3));
  assert.ok(![moved, during3].includes(clip.revision), 'a normal frame after the run reused a revision');
});
