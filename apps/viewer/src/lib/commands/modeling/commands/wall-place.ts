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
 * (`authoringDefaultsSlice`).
 * Escape stops chaining; a second Escape leaves the command.
 */

import { WallPlaceScene } from '@/components/viewer/tools/command/WallPlaceScene';
import { dist } from '@/lib/snap/constraints';
import { commandGhostId, wallGhostMesh } from '../ghost.js';
import { MIN_WALL_LENGTH, anchorOf, endPoint, type WallPlaceGesture } from './wall-place-geometry.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { authoringDim, type AuthoringDefaults } from '@/store/slices/authoringDefaultsSlice';

const wallDims = (d: AuthoringDefaults) => ({ Thickness: authoringDim(d, 'wall', 'Thickness'), Height: authoringDim(d, 'wall', 'Height') });

function currentLength(g: WallPlaceGesture): number | null {
  const anchor = anchorOf(g);
  const end = endPoint(g);
  return g.length ?? (anchor && end ? dist(anchor, end) : null);
}

function currentAngle(g: WallPlaceGesture): number | null {
  const anchor = anchorOf(g);
  const end = endPoint(g);
  if (g.angle !== null) return g.angle;
  if (!anchor || !end || dist(anchor, end) < 1e-9) return null;
  return ((Math.atan2(end[1] - anchor[1], end[0] - anchor[0]) * 180) / Math.PI + 360) % 360;
}

const FIELDS: readonly CommandField<WallPlaceGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v) }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
];

export const WALL_PLACE: ModelingCommand<WallPlaceGesture> = {
  id: 'wall.place',
  labelKey: 'modelingCommand.wall.label',
  hud: {
    Scene: WallPlaceScene,
    hint: (g) => (g.chain.length === 0 ? 'modelingCommand.wall.hintStart' : 'modelingCommand.wall.hintNext'),
  },
  fields: FIELDS,
  snap: 'modeling',
  init: () => ({ chain: [], cursor: null, length: null, angle: null }),
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
  undoPoint: (g) => ({ ...g, chain: g.chain.slice(0, -1), length: null, angle: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.wall.noPlane' };
    const anchor = anchorOf(g);
    const end = endPoint(g);
    if (!anchor) return { ok: false, reasonKey: 'modelingCommand.wall.hintStart' };
    return end && dist(anchor, end) >= MIN_WALL_LENGTH ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.wall.tooShort' };
  },
  commit(g, tx) {
    const anchor = anchorOf(g);
    const end = endPoint(g);
    if (!anchor || !end || tx.storeyId === null) throw new Error('No wall to place');
    const { Thickness, Height } = wallDims(tx.store.authoringDefaults);
    const wall = tx.store.addWall(tx.modelId, tx.storeyId, {
      Start: [anchor[0], anchor[1], 0], End: [end[0], end[1], 0], Thickness, Height,
    });
    if ('error' in wall) throw new Error(`Couldn't add wall: ${wall.error}`);
    return { created: [wall.expressId], deleted: [], remesh: [wall.expressId], select: [wall.expressId] };
  },
  // Chain: the next wall starts where this one ended; typed locks are per segment.
  afterCommit: (g) => {
    const end = endPoint(g);
    return { ...g, chain: end ? [...g.chain, end] : g.chain, length: null, angle: null };
  },
  ghost(g, ctx) {
    const anchor = anchorOf(g);
    const end = endPoint(g);
    if (!ctx.workplane || !anchor || !end) return [];
    const { Thickness, Height } = wallDims(ctx.get().authoringDefaults);
    const mesh = wallGhostMesh(ctx.workplane, anchor, end, Thickness, Height, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
