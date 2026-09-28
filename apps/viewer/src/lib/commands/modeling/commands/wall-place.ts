/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.place` (charter #6232, WP2): chained two-click walls on the session
 * workplane. The first click sets the start; every click after it commits
 * one wall (one transaction, one undo step) and continues from its end.
 *
 * Typed values lock the next segment: a length puts the end on a circle
 * round the anchor, an angle on a ray from it (the WP3 solver projects the
 * cursor onto that locus; `endPoint` applies it again for an Enter with no
 * pointer move since). Typing `3.5` then Enter places a 3.5 m wall towards
 * the cursor. Thickness and height are the wall defaults
 * (`authoringDefaultsSlice`), typed in the bar too. Align Left / Right makes
 * the drawn line that face of the wall; Chain off starts afresh after each
 * wall. Escape (or a double-click) stops chaining; a second Escape leaves.
 */

import { WallPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import { WallPlaceScene } from '@/components/viewer/tools/command/WallPlaceScene';
import { dist } from '@/lib/snap/constraints';
import { commandGhostId, wallGhostMesh } from '../ghost.js';
import { MIN_WALL_LENGTH, alignedAxis, anchorOf, currentAngle, currentLength, endPoint, type WallPlaceGesture } from './wall-place-geometry.js';
import { chainOn, defaultsField, planeZ } from './placement-shared.js';
import type { CommandContext, CommandField, ModelingCommand } from '../types.js';
import { authoringDim, type AuthoringDefaults } from '@/store/slices/authoringDefaultsSlice';

const wallDims = (d: AuthoringDefaults) => ({ Thickness: authoringDim(d, 'wall', 'Thickness'), Height: authoringDim(d, 'wall', 'Height') });

/** The wall axis the next commit writes: the drawn segment, offset by Align. */
function wallAxis(g: WallPlaceGesture, d: AuthoringDefaults) {
  const anchor = anchorOf(g);
  const end = endPoint(g);
  return anchor && end ? alignedAxis(anchor, end, wallDims(d).Thickness, d.wallAlign) : null;
}

const init = (): WallPlaceGesture => ({ chain: [], cursor: null, length: null, angle: null });

const FIELDS: readonly CommandField<WallPlaceGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', group: 'segment', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v) }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', group: 'segment', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
  defaultsField('thickness', 'wall', 'Thickness', 'modelingCommand.field.thickness'),
  defaultsField('height', 'wall', 'Height', 'modelingCommand.field.height'),
];

export const WALL_PLACE: ModelingCommand<WallPlaceGesture> = {
  id: 'wall.place',
  labelKey: 'modelingCommand.wall.label',
  hud: {
    Bar: WallPlaceBar,
    Scene: WallPlaceScene,
    hint: (g) => (g.chain.length === 0 ? 'modelingCommand.wall.hintStart' : 'modelingCommand.wall.hintNext'),
  },
  fields: FIELDS,
  snap: 'modeling',
  init,
  snapQuery: (g) => ({
    anchor: anchorOf(g),
    chain: g.chain,
    locks: { ...(g.length !== null ? { length: g.length } : {}), ...(g.angle !== null ? { angleDeg: g.angle } : {}) },
  }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown(g, s) {
    if (g.chain.length === 0) return { ...g, chain: [s.local], cursor: s.local };
    return { commit: true };
  },
  // A double-click ends the chain where the first of its clicks placed it.
  doubleClick: () => init(),
  undoPoint: (g) => ({ ...g, chain: g.chain.slice(0, -1), length: null, angle: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    const anchor = anchorOf(g);
    const end = endPoint(g);
    if (!anchor) return { ok: false, reasonKey: 'modelingCommand.wall.hintStart' };
    return end && dist(anchor, end) >= MIN_WALL_LENGTH ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.wall.tooShort' };
  },
  commit(g, tx) {
    const axis = wallAxis(g, tx.store.authoringDefaults);
    if (!axis || tx.storeyId === null) throw new Error('No wall to place');
    const [start, end] = axis;
    const { Thickness, Height } = wallDims(tx.store.authoringDefaults);
    const z = planeZ(tx.workplane);
    const wall = tx.store.addWall(tx.modelId, tx.storeyId, {
      Start: [start[0], start[1], z], End: [end[0], end[1], z], Thickness, Height,
    });
    if ('error' in wall) throw new Error(`Couldn't add wall: ${wall.error}`);
    return { created: [wall.expressId], deleted: [], remesh: [wall.expressId], select: [wall.expressId] };
  },
  // Chain: the next wall starts where this one ended; typed locks are per segment.
  afterCommit: (g, _result, ctx: CommandContext) => {
    if (!chainOn(ctx)) return init();
    const end = endPoint(g);
    return { ...g, chain: end ? [...g.chain, end] : g.chain, length: null, angle: null };
  },
  ghost(g, ctx) {
    const axis = wallAxis(g, ctx.get().authoringDefaults);
    if (!ctx.workplane || !axis) return [];
    const { Thickness, Height } = wallDims(ctx.get().authoringDefaults);
    const mesh = wallGhostMesh(ctx.workplane, axis[0], axis[1], Thickness, Height, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
