/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `beam.place` (charter #6232, M2): two clicks per beam, drawn like a wall
 * (typed Length / Angle lock the segment, Chain continues from the last
 * end, Backspace drops a point, a double-click ends the chain). The section
 * is the class's Width × Height default, its underside `Bottom at` above
 * the workplane. The class segment picks `addBeam` or `addMember`. Each
 * beam is one transaction, one undo step.
 */

import { BeamPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import { WallPlaceScene } from '@/components/viewer/tools/command/WallPlaceScene';
import { dist } from '@/lib/snap/constraints';
import type { BeamClass } from '@/store/slices/authoringDefaultsSlice';
import type { Vec2 } from '@/lib/snap/types';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh, segmentOutline } from '../ghost-shapes.js';
import type { CommandContext, CommandField, ModelingCommand } from '../types.js';
import { chainOn, defaultsField, dimOf, planeZ } from './placement-shared.js';
import { MIN_WALL_LENGTH, anchorOf, currentAngle, currentLength, endPoint, type WallPlaceGesture } from './wall-place-geometry.js';

/** A beam is drawn exactly like a wall: a chain of points, a cursor and per-segment locks. */
export type BeamPlaceGesture = WallPlaceGesture;

const beamClassOf = (ctx: Pick<CommandContext, 'get'>): BeamClass => ctx.get().authoringDefaults.beamClass;
const init = (): BeamPlaceGesture => ({ chain: [], cursor: null, length: null, angle: null });

function segment(g: BeamPlaceGesture): [Vec2, Vec2] | null {
  const anchor = anchorOf(g);
  const end = endPoint(g);
  return anchor && end && dist(anchor, end) >= MIN_WALL_LENGTH ? [anchor, end] : null;
}

/** The beam's section and its underside above the workplane, for the current class. */
function section(ctx: Pick<CommandContext, 'get'>) {
  const cls = beamClassOf(ctx);
  return { cls, Width: dimOf(ctx, cls, 'Width'), Height: dimOf(ctx, cls, 'Height'), Bottom: dimOf(ctx, cls, 'Bottom') };
}

const FIELDS: readonly CommandField<BeamPlaceGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', group: 'segment', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v) }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', group: 'segment', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
  defaultsField('width', beamClassOf, 'Width', 'modelingCommand.field.width'),
  defaultsField('height', beamClassOf, 'Height', 'modelingCommand.field.height'),
  defaultsField('bottom', beamClassOf, 'Bottom', 'modelingCommand.beam.bottom', 'offset'),
];

export const BEAM_PLACE: ModelingCommand<BeamPlaceGesture> = {
  id: 'beam.place',
  labelKey: 'modelingCommand.beam.label',
  hud: {
    Bar: BeamPlaceBar,
    // The chain and rubber band read the same gesture as a wall's.
    Scene: WallPlaceScene,
    hint: (g) => (g.chain.length === 0 ? 'modelingCommand.beam.hintStart' : 'modelingCommand.wall.hintNext'),
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
  pointerDown: (g, s) => (g.chain.length === 0 ? { ...g, chain: [s.local], cursor: s.local } : { commit: true }),
  doubleClick: () => init(),
  undoPoint: (g) => ({ ...g, chain: g.chain.slice(0, -1), length: null, angle: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.wall.noPlane' };
    if (!anchorOf(g)) return { ok: false, reasonKey: 'modelingCommand.beam.hintStart' };
    return segment(g) ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.beam.tooShort' };
  },
  commit(g, tx) {
    const seg = segment(g);
    if (!seg || tx.storeyId === null) throw new Error('No beam to place');
    const { cls, Width, Height, Bottom } = section({ get: () => tx.store });
    // The section is centred on the builder's axis: lift it by half its height.
    const z = planeZ(tx.workplane) + Bottom + Height / 2;
    const params = { Start: [seg[0][0], seg[0][1], z] as [number, number, number], End: [seg[1][0], seg[1][1], z] as [number, number, number], Width, Height };
    const made = cls === 'member' ? tx.store.addMember(tx.modelId, tx.storeyId, params) : tx.store.addBeam(tx.modelId, tx.storeyId, params);
    if ('error' in made) throw new Error(`Couldn't add the ${cls}: ${made.error}`);
    return { created: [made.expressId], deleted: [], remesh: [made.expressId], select: [made.expressId] };
  },
  afterCommit: (g, _result, ctx) => {
    if (!chainOn(ctx)) return init();
    const end = endPoint(g);
    return { ...g, chain: end ? [...g.chain, end] : g.chain, length: null, angle: null };
  },
  ghost(g, ctx) {
    const seg = segment(g);
    if (!ctx.workplane || !seg) return [];
    const { Width, Height, Bottom } = section(ctx);
    const mesh = prismGhostMesh(ctx.workplane, segmentOutline(seg[0], seg[1], Width), Bottom, Bottom + Height, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
