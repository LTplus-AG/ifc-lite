/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `railing.place` (charter #6232, D1): click the points of a polyline on the
 * workplane, snapping to slab edges and stair sides like any command, and
 * double-click (or press Enter) to finish. The rail is one sweep along the
 * path with a post at every point and at most `Posts` apart in between.
 *
 * The bar edits the next segment (Length, Angle), the rail Height and the post
 * spacing. Backspace drops the last point; Escape starts the path over. A
 * commit is the store's `addRailingIn` in one transaction: one undo step, and
 * the railing re-meshed (#6391).
 */

import { useViewerStore } from '@/store';
import { addRailingIn } from '@/store/slices/mutation-stair-railing';
import { RailingPlaceBar } from '@/components/viewer/tools/command/StairRailingBars';
import { WallPlaceScene } from '@/components/viewer/tools/command/WallPlaceScene';
import { WallPlacePlan } from '@/components/viewer/tools/command/WallPlacePlan';
import { commandGhostId } from '../ghost.js';
import { railingGhostMesh } from '../stair-railing-ghost.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { planeZ } from './placement-shared.js';
import { railingSettings, setRailingSettings } from './stair-railing-settings.js';
import {
  MIN_RAILING_SEGMENT, initRailingGesture, pathOf, riseOf, type RailingPlaceGesture,
} from './railing-place-geometry.js';
import { anchorOf, currentAngle, currentLength, endPoint } from './wall-place-geometry.js';
import { dist } from '@/lib/snap/constraints';

/** The rail is 50 mm across: the height must clear it (the builder's own rule). */
const MIN_HEIGHT = 0.05;

const FIELDS: readonly CommandField<RailingPlaceGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', group: 'segment', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v) }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', group: 'segment', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
  {
    id: 'height', labelKey: 'modelingCommand.field.height', unit: 'm', group: 'rail',
    read: () => railingSettings().Height,
    write: (g, v) => { if (v > MIN_HEIGHT) setRailingSettings({ Height: v }); return g; },
  },
  {
    id: 'spacing', labelKey: 'stairRailing.field.postSpacing', unit: 'm', group: 'rail',
    read: () => railingSettings().PostSpacing,
    write: (g, v) => { if (v > 0) setRailingSettings({ PostSpacing: v }); return g; },
  },
];

export const RAILING_PLACE: ModelingCommand<RailingPlaceGesture> = {
  id: 'railing.place',
  labelKey: 'stairRailing.railing.label',
  hud: {
    Bar: RailingPlaceBar,
    Scene: WallPlaceScene,
    Plan: WallPlacePlan,
    hint: (g) => (g.chain.length === 0 ? 'stairRailing.railing.hintStart' : 'stairRailing.railing.hintNext'),
  },
  fields: FIELDS,
  snap: 'modeling',
  init: initRailingGesture,
  snapQuery: (g) => ({
    anchor: anchorOf(g),
    chain: g.chain,
    locks: { ...(g.length !== null ? { length: g.length } : {}), ...(g.angle !== null ? { angleDeg: g.angle } : {}) },
  }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local, cursorRise: riseOf(s) }),
  pointerDown(g, s) {
    const last = anchorOf(g);
    if (!last) return { ...g, chain: [s.local], rise: [riseOf(s)], cursor: s.local, cursorRise: riseOf(s) };
    // The point the rubber band shows, typed locks included.
    const at = endPoint(g) ?? s.local;
    if (dist(last, at) < MIN_RAILING_SEGMENT) return g;
    return { ...g, chain: [...g.chain, at], rise: [...g.rise, g.cursorRise], length: null, angle: null };
  },
  // The first click of a double-click placed the last point; the second finishes the path.
  doubleClick: (g) => (g.chain.length >= 2 ? { commit: true } : g),
  undoPoint: (g) => ({ ...g, chain: g.chain.slice(0, -1), rise: g.rise.slice(0, -1), length: null, angle: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    return pathOf(g).length >= 2 ? { ok: true } : { ok: false, reasonKey: 'stairRailing.railing.needTwo' };
  },
  commit(g, tx) {
    const path = pathOf(g);
    if (path.length < 2 || tx.storeyId === null) throw new Error('No railing to place');
    const z = planeZ(tx.workplane);
    const { Height, PostSpacing } = railingSettings();
    const placed = addRailingIn(useViewerStore, tx.modelId, tx.storeyId, {
      Path: path.map((p) => [p[0], p[1], z + p[2]] as [number, number, number]),
      Height,
      PostSpacing,
    }, { batchId: tx.batchId });
    if ('error' in placed) throw new Error(`Couldn't add the railing: ${placed.error}`);
    return { created: [placed.expressId], deleted: [], remesh: [placed.expressId], select: [placed.expressId] };
  },
  afterCommit: () => initRailingGesture(),
  ghost(g, ctx) {
    const path = pathOf(g);
    if (!ctx.workplane || path.length < 2) return [];
    const { Height, PostSpacing } = railingSettings();
    const mesh = railingGhostMesh(ctx.workplane, path, Height, PostSpacing, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
