/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `stair.place` (charter #6232, D1): two clicks draw a straight run on the
 * workplane, the foot of the first riser and the end of the run, snapping like
 * a wall. The flight climbs the storey: the riser height is fitted so the top
 * tread lands exactly on the storey above (`stair-place-geometry.ts`).
 *
 * The bar edits the run (Length, Angle), the riser height it is fitted to,
 * the Tread depth (which fixes the run), the Width and the Waist thickness.
 * The drawn line is the stair's centre line. A commit is the store's
 * `addStairIn` in one transaction: IfcStair, its IfcStairFlight and the
 * relationships, re-meshed (#6391), one undo step.
 */

import { useViewerStore } from '@/store';
import { addStairIn } from '@/store/slices/mutation-stair-railing';
import { StairPlaceBar } from '@/components/viewer/tools/command/StairRailingBars';
import { WallPlaceScene } from '@/components/viewer/tools/command/WallPlaceScene';
import { WallPlacePlan } from '@/components/viewer/tools/command/WallPlacePlan';
import { commandGhostId } from '../ghost.js';
import { stairGhostMesh } from '../stair-railing-ghost.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { planeZ } from './placement-shared.js';
import { setStairSettings, stairSettings } from './stair-railing-settings.js';
import {
  MIN_TREAD, alongRun, flightOf, initStairGesture, stairRise, waistFits, type StairPlaceGesture,
} from './stair-place-geometry.js';
import { anchorOf, currentAngle, currentLength } from './wall-place-geometry.js';

const positive = (v: number) => Number.isFinite(v) && v > 0;

const FIELDS: readonly CommandField<StairPlaceGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', group: 'segment', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v), treadLock: null }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', group: 'segment', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
  {
    // The riser asked for; the built one is the rise over the nearest whole number of risers, shown back here.
    id: 'riser', labelKey: 'stairRailing.field.riser', unit: 'm', group: 'flight',
    read: (g, ctx) => stairRise(ctx).riser,
    write: (g, v, ctx) => {
      if (!positive(v)) return g;
      setStairSettings({ RiserTarget: v });
      // A typed tread keeps its depth: the run follows the new number of risers.
      return g.treadLock === null ? g : { ...g, length: g.treadLock * stairRise(ctx).risers };
    },
  },
  {
    id: 'tread', labelKey: 'stairRailing.field.tread', unit: 'm', group: 'flight',
    read: (g, ctx) => flightOf(g, ctx)?.tread ?? (g.treadLock ?? null),
    write: (g, v, ctx) => (positive(v) ? { ...g, treadLock: v, length: v * stairRise(ctx).risers } : g),
  },
  {
    id: 'width', labelKey: 'modelingCommand.field.width', unit: 'm', group: 'section',
    read: () => stairSettings().Width,
    write: (g, v) => { if (positive(v)) setStairSettings({ Width: v }); return g; },
  },
  {
    id: 'waist', labelKey: 'stairRailing.field.waist', unit: 'm', group: 'section',
    read: () => stairSettings().Waist,
    write: (g, v) => { if (positive(v)) setStairSettings({ Waist: v }); return g; },
  },
];

export const STAIR_PLACE: ModelingCommand<StairPlaceGesture> = {
  id: 'stair.place',
  labelKey: 'stairRailing.stair.label',
  hud: {
    Bar: StairPlaceBar,
    Scene: WallPlaceScene,
    Plan: WallPlacePlan,
    hint: (g) => (g.chain.length === 0 ? 'stairRailing.stair.hintStart' : 'stairRailing.stair.hintEnd'),
  },
  fields: FIELDS,
  snap: 'modeling',
  init: initStairGesture,
  snapQuery: (g) => ({
    anchor: anchorOf(g),
    chain: g.chain,
    locks: { ...(g.length !== null ? { length: g.length } : {}), ...(g.angle !== null ? { angleDeg: g.angle } : {}) },
  }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown: (g, s) => (g.chain.length === 0 ? { ...g, chain: [s.local], cursor: s.local } : { commit: true }),
  // A double-click ends where its first click placed the run; the second must not stack another.
  doubleClick: (g) => g,
  undoPoint: (g) => ({ ...g, chain: [], length: null, angle: null, treadLock: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    if (!anchorOf(g)) return { ok: false, reasonKey: 'stairRailing.stair.hintStart' };
    const flight = flightOf(g, ctx);
    if (!flight || flight.tread < MIN_TREAD) return { ok: false, reasonKey: 'stairRailing.stair.tooShort' };
    return waistFits(flight) ? { ok: true } : { ok: false, reasonKey: 'stairRailing.stair.waistTooThick' };
  },
  commit(g, tx) {
    const ctx = { get: () => tx.store, modelId: tx.modelId, storeyId: tx.storeyId, workplane: tx.workplane };
    const flight = flightOf(g, ctx);
    if (!flight || tx.storeyId === null) throw new Error('No stair to place');
    // The drawn line is the centre line; the builder's Position is the flight's right-hand foot.
    const foot = alongRun(flight, 0, -flight.width / 2);
    const placed = addStairIn(useViewerStore, tx.modelId, tx.storeyId, {
      Position: [foot[0], foot[1], planeZ(tx.workplane)],
      Direction: flight.direction,
      NumberOfRisers: flight.risers,
      RiserHeight: flight.riser,
      TreadLength: flight.tread,
      Width: flight.width,
      WaistThickness: flight.waist,
    }, { batchId: tx.batchId });
    if ('error' in placed) throw new Error(`Couldn't add the stair: ${placed.error}`);
    const flightId = placed.flightId ?? placed.expressId;
    // The flight carries the body; selecting it shows the stair the user drew.
    return { created: [placed.expressId, flightId], deleted: [], remesh: [placed.expressId, flightId], select: [flightId] };
  },
  afterCommit: () => initStairGesture(),
  ghost(g, ctx) {
    const flight = flightOf(g, ctx);
    if (!ctx.workplane || !flight || flight.tread < MIN_TREAD) return [];
    const mesh = stairGhostMesh(
      ctx.workplane, (x, y) => alongRun(flight, x, y), flight.risers, flight.riser, flight.tread, flight.width, commandGhostId(ctx.get()),
    );
    return mesh ? [mesh] : [];
  },
};
