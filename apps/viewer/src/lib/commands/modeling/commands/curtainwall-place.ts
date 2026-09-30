/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `curtainwall.place` (charter #6232, D3): a straight curtain wall on the
 * session workplane from two clicks (start, end; a typed length or angle locks
 * the end like a wall's). The bar's fields are the wall's Height, its Base
 * offset above the workplane, the Panel width and height it is divided into
 * (target sizes: the fewest equal bays and rows no larger) and the Mullion
 * section. The ghost is the real layout, `curtainWallLayout`'s mullions,
 * transoms and panels, so what is previewed is what is written.
 *
 * The commit writes the IfcCurtainWall with its IfcMember and IfcPlate parts
 * (`addCurtainWallToStore`) as ONE undo step and re-meshes every part (#6391).
 * The dimensions carry to the next curtain wall.
 */

import { CurtainWallPlaceBar } from '@/components/viewer/tools/command/CurtainWallPlaceBar';
import { CurtainWallPlaceScene } from '@/components/viewer/tools/command/CurtainWallPlaceScene';
import { CurtainWallPlacePlan } from '@/components/viewer/tools/command/CurtainWallPlacePlan';
import { addCurtainWallIn } from '@/store/slices/mutation-curtain-grid';
import { useViewerStore } from '@/store';
import { commandGhostId } from '../ghost.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { planeZ } from './placement-shared.js';
import {
  curtainWallGhosts,
  initCurtainWall,
  withDimensions,
  layoutOf,
  planCurtainWall,
  currentAngle,
  currentLength,
  anchorOf,
  type CurtainWallGesture,
} from './curtainwall-place-geometry.js';

/** A positive number typed into a gesture-held dimension; anything else is ignored. */
const dimension = (
  id: string,
  labelKey: CommandField<CurtainWallGesture>['labelKey'],
  key: 'height' | 'panelWidth' | 'panelHeight' | 'mullionWidth' | 'mullionDepth',
  group: string,
): CommandField<CurtainWallGesture> => ({
  id, labelKey, unit: 'm', group,
  read: (g) => g[key],
  write: (g, v) => (v > 0 ? withDimensions(g, { [key]: v }) : g),
});

const FIELDS: readonly CommandField<CurtainWallGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', group: 'segment', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v) }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', group: 'segment', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
  dimension('height', 'modelingCommand.field.height', 'height', 'wall'),
  {
    id: 'baseOffset', labelKey: 'curtainWall.field.baseOffset', unit: 'm', group: 'wall',
    read: (g) => g.baseOffset, write: (g, v) => withDimensions(g, { baseOffset: v }),
  },
  dimension('panelWidth', 'curtainWall.field.panelWidth', 'panelWidth', 'panels'),
  dimension('panelHeight', 'curtainWall.field.panelHeight', 'panelHeight', 'panels'),
  dimension('mullionWidth', 'curtainWall.field.mullionWidth', 'mullionWidth', 'mullion'),
  dimension('mullionDepth', 'curtainWall.field.mullionDepth', 'mullionDepth', 'mullion'),
];

export const CURTAINWALL_PLACE: ModelingCommand<CurtainWallGesture> = {
  id: 'curtainwall.place',
  labelKey: 'curtainWall.label',
  hud: {
    Bar: CurtainWallPlaceBar,
    Scene: CurtainWallPlaceScene,
    Plan: CurtainWallPlacePlan,
    hint: (g) => (g.chain.length === 0 ? 'curtainWall.hint.start' : 'curtainWall.hint.end'),
  },
  fields: FIELDS,
  snap: 'modeling',
  init: () => initCurtainWall(),
  snapQuery: (g) => ({
    anchor: anchorOf(g),
    chain: g.chain,
    locks: { ...(g.length !== null ? { length: g.length } : {}), ...(g.angle !== null ? { angleDeg: g.angle } : {}) },
  }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown: (g, s) => (g.chain.length === 0 ? { ...g, chain: [s.local], cursor: s.local } : { commit: true }),
  // The first click of a double-click already set the start; the second must not end the wall on it.
  doubleClick: (g) => g,
  undoPoint: (g) => ({ ...g, chain: [], length: null, angle: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    const plan = planCurtainWall(g, planeZ(ctx.workplane));
    if (!plan.ok) {
      if (plan.reason === 'noPath') return { ok: false, reasonKey: 'curtainWall.hint.start' };
      return { ok: false, reasonKey: plan.reason === 'tooShort' ? 'curtainWall.tooShort' : 'curtainWall.tooManyPanels' };
    }
    return layoutOf(plan) ? { ok: true } : { ok: false, reasonKey: 'curtainWall.noOpening' };
  },
  commit(g, tx) {
    const plan = planCurtainWall(g, planeZ(tx.workplane));
    if (!plan.ok || tx.storeyId === null) throw new Error('No curtain wall to place');
    const made = addCurtainWallIn(useViewerStore, tx.modelId, tx.storeyId, plan.params);
    if ('error' in made) throw new Error(`Couldn't add the curtain wall: ${made.error}`);
    // The curtain wall has no body of its own; its parts are what is meshed.
    const created = [made.expressId, ...made.partIds];
    return { created, deleted: [], remesh: created, select: [made.expressId] };
  },
  // The path starts over; the dimensions carry (initCurtainWall).
  afterCommit: () => initCurtainWall(),
  cancel: (g) => (g.chain.length > 0 ? 'reset' : 'exit'),
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const plan = planCurtainWall(g, planeZ(ctx.workplane));
    const layout = plan.ok ? layoutOf(plan) : null;
    if (!plan.ok || !layout) return [];
    return curtainWallGhosts(ctx.workplane, plan, layout, g, [commandGhostId(ctx.get(), 0), commandGhostId(ctx.get(), 1)]);
  },
};
