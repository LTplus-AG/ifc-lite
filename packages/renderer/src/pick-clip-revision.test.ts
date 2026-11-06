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
  const changes = [
    { sectionPlane: { ...plane(), distance: 3 } },
    { sectionPlane: { ...plane(), flipped: true } },
    { sectionPlane: plane(), extraPlanes: [{ normal: [1, 0, 0] as [number, number, number], distance: 1, flipped: false }] },
    { sectionPlane: plane(), clipBox: { enabled: true, min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] } },
    { sectionPlane: plane(), sectionExcludedIds: new Set([7]) },
  ];
  for (const change of changes) {
    const before = clip.revision;
    clip.note(change);
    assert.ok(clip.revision > before, `no bump for ${JSON.stringify(change, (_k, v) => (v instanceof Set ? [...v] : v))}`);
  }
});
