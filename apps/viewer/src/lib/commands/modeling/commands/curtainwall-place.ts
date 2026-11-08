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
 * The dimensions carry to the next curtain wall. Its top follows the same
 * "Storey above / Fixed height" default as a wall's (`wall-top.ts`): it is
 * laid out to reach the storey above and recorded attached to it, in the same
 * undo step, so a later level edit lays it out again; a typed height makes it fixed.
 */

import { CurtainWallPlaceBar } from '@/components/viewer/tools/command/CurtainWallPlaceBar';
import { CurtainWallPlaceScene } from '@/components/viewer/tools/command/CurtainWallPlaceScene';
import { CurtainWallPlacePlan } from '@/components/viewer/tools/command/CurtainWallPlacePlan';
import { addCurtainWallIn } from '@/store/slices/mutation-curtain-grid';
import { useViewerStore } from '@/store';
import { commandGhostId } from '../ghost.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { planeZ } from './placement-shared.js';
import { recordWallTop, resolveElementTop } from '../wall-top.js';
import type { CommandContext } from '../types.js';
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

/** The gesture at the height it is drawn: up to the storey above, or its own typed height. */
function withTop(g: CurtainWallGesture, ctx: Pick<CommandContext, 'get' | 'modelId' | 'storeyId' | 'workplane'>) {
  const top = resolveElementTop(ctx.get(), ctx.modelId, ctx.storeyId, planeZ(ctx.workplane) + g.baseOffset, g.height);
  // Not withDimensions: the storey spacing is not a dimension to carry to the next curtain wall.
  return { g: top.above ? { ...g, height: top.Height } : g, top };
}

const FIELDS: readonly CommandField<CurtainWallGesture>[] = [
  { id: 'length', labelKey: 'modelingCommand.wall.length', unit: 'm', group: 'segment', read: currentLength, write: (g, v) => ({ ...g, length: Math.abs(v) }) },
  { id: 'angle', labelKey: 'modelingCommand.wall.angle', unit: 'deg', group: 'segment', read: currentAngle, write: (g, v) => ({ ...g, angle: v }) },
  // The storey spacing while it goes to the storey above. Typing a height means that height: it becomes fixed.
  {
    ...dimension('height', 'modelingCommand.field.height', 'height', 'wall'),
    read: (g, ctx) => withTop(g, ctx).g.height,
    write: (g, v, ctx) => {
      if (!(v > 0)) return g;
      ctx.get().setAuthoringDefaults({ wallTop: 'fixed' });
      return withDimensions(g, { height: v });
    },
  },
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
    const plan = planCurtainWall(withTop(g, ctx).g, planeZ(ctx.workplane));
    if (!plan.ok) {
      if (plan.reason === 'noPath') return { ok: false, reasonKey: 'curtainWall.hint.start' };
      return { ok: false, reasonKey: plan.reason === 'tooShort' ? 'curtainWall.tooShort' : 'curtainWall.tooManyPanels' };
    }
    return layoutOf(plan) ? { ok: true } : { ok: false, reasonKey: 'curtainWall.noOpening' };
  },
  commit(g, tx) {
    const drawn = withTop(g, { get: () => tx.store, modelId: tx.modelId, storeyId: tx.storeyId, workplane: tx.workplane });
    const plan = planCurtainWall(drawn.g, planeZ(tx.workplane));
    if (!plan.ok || tx.storeyId === null) throw new Error('No curtain wall to place');
    const made = addCurtainWallIn(useViewerStore, tx.modelId, tx.storeyId, plan.params);
    if ('error' in made) throw new Error(`Couldn't add the curtain wall: ${made.error}`);
    // The attachment is part of the same undo step as the curtain wall.
    if (drawn.top.attachTo) recordWallTop(tx.store, tx.modelId, made.expressId, drawn.top.attachTo);
    // The curtain wall has no body of its own; its parts are what is meshed.
    const created = [made.expressId, ...made.partIds];
    return { created, deleted: [], remesh: created, select: [made.expressId] };
  },
  // The path starts over; the dimensions carry (initCurtainWall).
  afterCommit: () => initCurtainWall(),
  cancel: (g) => (g.chain.length > 0 ? 'reset' : 'exit'),
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const drawn = withTop(g, ctx).g;
    const plan = planCurtainWall(drawn, planeZ(ctx.workplane));
    const layout = plan.ok ? layoutOf(plan) : null;
    if (!plan.ok || !layout) return [];
    return curtainWallGhosts(ctx.workplane, plan, layout, drawn, [commandGhostId(ctx.get(), 0), commandGhostId(ctx.get(), 1)]);
  },
};
