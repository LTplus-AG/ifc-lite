/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `grid.place` (charter #6232, D3): a rectangular design grid (IfcGrid) on the
 * session workplane. Two corners size it (Shift squares it), or typed Width
 * and Depth do; the bar's U and V spacing set where the axes fall and its tag
 * scheme (1, 2, 3 across and A, B, C down, or the other way round) names them.
 * The ghost is the grid's real axes, so what is previewed is what is written.
 *
 * The commit writes the IfcGrid with its tagged IfcGridAxis curves
 * (`addGridToStore`) as ONE undo step. Grids are lines, not bodies: they draw
 * from their axes, and snap (`ifc-grid` source) to the storey's grid axes and
 * intersections once placed.
 */

import { GridPlaceBar } from '@/components/viewer/tools/command/GridPlaceBar';
import { GridPlaceScene } from '@/components/viewer/tools/command/GridPlaceScene';
import { addGridIn } from '@/store/slices/mutation-curtain-grid';
import { useViewerStore } from '@/store';
import { commandGhostId } from '../ghost.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { planeZ } from './placement-shared.js';
import { gridGhost, initGrid, planGrid, withGridSettings, type GridPlaceGesture } from './grid-place-geometry.js';
import { rectangleCorner } from './slab-place-geometry.js';

const side = (axis: 0 | 1) => (g: GridPlaceGesture): number | null => {
  const first = g.points[0];
  const corner = rectangleCorner(g);
  return first && corner ? Math.abs(corner[axis] - first[axis]) : (axis === 0 ? g.width : g.depth);
};

const spacing = (id: string, key: 'spacingU' | 'spacingV', labelKey: CommandField<GridPlaceGesture>['labelKey']): CommandField<GridPlaceGesture> => ({
  id, labelKey, unit: 'm', group: 'spacing',
  read: (g) => g[key],
  write: (g, v) => (v > 0 ? withGridSettings(g, { [key]: v }) : g),
});

const FIELDS: readonly CommandField<GridPlaceGesture>[] = [
  { id: 'width', labelKey: 'modelingCommand.field.width', unit: 'm', group: 'rect', read: side(0), write: (g, v) => ({ ...g, width: Math.abs(v) }) },
  { id: 'depth', labelKey: 'modelingCommand.field.depth', unit: 'm', group: 'rect', read: side(1), write: (g, v) => ({ ...g, depth: Math.abs(v) }) },
  spacing('spacingU', 'spacingU', 'grid.field.spacingU'),
  spacing('spacingV', 'spacingV', 'grid.field.spacingV'),
];

export const GRID_PLACE: ModelingCommand<GridPlaceGesture> = {
  id: 'grid.place',
  labelKey: 'grid.label',
  hud: {
    Bar: GridPlaceBar,
    Scene: GridPlaceScene,
    hint: (g) => (g.points.length === 0 ? 'grid.hint.corner' : 'grid.hint.opposite'),
  },
  fields: FIELDS,
  snap: 'modeling',
  init: () => initGrid(),
  // A rectangle has no drawing anchor: its locks are sides, not a length and angle.
  snapQuery: () => ({ anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local, square: s.modifiers?.shift ?? false }),
  pointerDown: (g, s) => (g.points.length === 0 ? { ...g, points: [s.local], cursor: s.local } : { commit: true }),
  // The first click of a double-click already set the corner; the second must not close the grid on it.
  doubleClick: (g) => g,
  undoPoint: (g) => ({ ...g, points: [], width: null, depth: null }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    if (g.points.length === 0) return { ok: false, reasonKey: 'grid.hint.corner' };
    const plan = planGrid(g, planeZ(ctx.workplane));
    if (plan.ok) return { ok: true };
    return { ok: false, reasonKey: plan.reason === 'noArea' ? 'grid.noArea' : 'grid.tooManyAxes' };
  },
  commit(g, tx) {
    const plan = planGrid(g, planeZ(tx.workplane));
    if (!plan.ok || tx.storeyId === null) throw new Error('No grid to place');
    const made = addGridIn(useViewerStore, tx.modelId, tx.storeyId, plan.params);
    if ('error' in made) throw new Error(`Couldn't add the grid: ${made.error}`);
    // A grid has no body to mesh: it draws from its axes.
    return { created: [made.expressId], deleted: [], remesh: [], select: [made.expressId] };
  },
  afterCommit: () => initGrid(),
  cancel: (g) => (g.points.length > 0 ? 'reset' : 'exit'),
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const plan = planGrid(g, planeZ(ctx.workplane));
    return plan.ok ? gridGhost(ctx.workplane, plan, commandGhostId(ctx.get())) : [];
  },
};
