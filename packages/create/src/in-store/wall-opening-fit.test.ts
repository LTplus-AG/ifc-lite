/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: axes still span these cuts, but the joined body faces do not. */
import { describe, expect, it } from 'vitest';
import { addWallToStore } from './wall.js';
import { addHostedElementInStore, readHostOpeningExtents } from './hosted-element.js';
import { joinWallsInStore } from './wall-join-edit.js';
import { newStorey } from './wall-join-mesh.oracle.js';

describe('#6232 shared joined-wall hosted contract', () => {
  for (const end of ['start', 'end'] as const) {
    it(`refuses an opening stranded by the oblique ${end} near face with no writes`, async () => {
      const s = await newStorey();
      const a = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
      const b = addWallToStore(s.editor, s.anchor, end === 'end'
        ? { Start: [4, 0, 0], End: [5, 1, 0], Thickness: 0.4, Height: 3, Axis: true }
        : { Start: [-1, 1, 0], End: [0, 0, 0], Thickness: 0.4, Height: 3, Axis: true }).wallId;
      addHostedElementInStore(s.store, s.editor, a, { kind: 'window', params: { Offset: end === 'end' ? 3.9 : 0.1, Sill: 1, Width: 0.1, Height: 1 } });
      const before = s.view.getMutations();
      expect(() => joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b, { priority: 'b' })).toThrow(/would not fit between the joined end faces/);
      expect(s.view.getMutations()).toEqual(before);
    });
  }

  it('keeps a readable door away from the join in its original host frame', async () => {
    const s = await newStorey();
    const a = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
    const b = addWallToStore(s.editor, s.anchor, { Start: [4, 0, 0], End: [5, 1, 0], Thickness: 0.4, Height: 3, Axis: true }).wallId;
    const door = addHostedElementInStore(s.store, s.editor, a, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } });
    const before = readHostOpeningExtents(s.store, a, s.view).cuts[0];
    joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b, { priority: 'b' });
    const after = readHostOpeningExtents(s.store, a, s.view).cuts[0];
    expect(after.openingId).toBe(door.openingId);
    expect(after.fillingId).toBe(door.expressId);
    expect(after.locationPointId).toBe(before.locationPointId);
    expect(after.bounds).toEqual(before.bounds);
  });

  for (const broken of ['host', 'opening'] as const) {
    it(`refuses an unreadable ${broken} reference before rewriting either wall`, async () => {
      const s = await newStorey();
      const a = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
      const b = addWallToStore(s.editor, s.anchor, { Start: [4, 0, 0], End: [4, 3, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
      const door = addHostedElementInStore(s.store, s.editor, a, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } });
      const rel = s.view.getNewEntities().find(e => e.type === 'IfcRelVoidsElement' && e.attributes[5] === `#${door.openingId}`)!;
      s.editor.setPositionalAttribute(rel.expressId, broken === 'host' ? 4 : 5, broken === 'host' ? null : '#999999');
      const before = s.view.getNewEntities();
      const journal = s.view.getMutations();
      expect(() => joinWallsInStore(s.editor, s.store, s.joinAnchor, a, b)).toThrow(/unreadable opening geometry/);
      expect(s.view.getNewEntities()).toEqual(before);
      expect(s.view.getMutations()).toEqual(journal);
    });
  }
});
