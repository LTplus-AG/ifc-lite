/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `slab.place` (charter #6232, M2): a slab, roof or plate on the session
 * workplane, drawn as a rectangle (two corners; Shift squares it; typed
 * Width / Depth lock a side) or a polygon (a click per vertex; Enter, a
 * double-click or a click on the first vertex closes it once it has three;
 * Backspace drops the last). The bar's class segment picks the builder
 * (`addSlab` / `addRoof` / `addPlate`); Thickness is that class's default.
 * Each outline is one transaction, one undo step.
 */

import { SlabPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import { SlabPlaceScene } from '@/components/viewer/tools/command/SlabPlaceScene';
import type { SlabClass } from '@/store/slices/authoringDefaultsSlice';
import type { ViewerState } from '@/store';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import type { CommandContext, CommandField, ModelingCommand } from '../types.js';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';
import {
  closesPolygon,
  initSlabGesture,
  previewOutline,
  rectangleCorner,
  rectangleExtent,
  type SlabPlaceGesture,
} from './slab-place-geometry.js';

const slabClassOf = (ctx: Pick<CommandContext, 'get'>): SlabClass => ctx.get().authoringDefaults.slabClass;

const rectSide = (axis: 0 | 1) => (g: SlabPlaceGesture): number | null => {
  const first = g.points[0];
  const corner = rectangleCorner(g);
  return first && corner ? Math.abs(corner[axis] - first[axis]) : (axis === 0 ? g.width : g.depth);
};

const FIELDS: readonly CommandField<SlabPlaceGesture>[] = [
  {
    id: 'width', labelKey: 'modelingCommand.field.width', unit: 'm', group: 'rect',
    hidden: (g) => g.mode !== 'rectangle', read: rectSide(0), write: (g, v) => ({ ...g, width: Math.abs(v) || null }),
  },
  {
    id: 'depth', labelKey: 'modelingCommand.field.depth', unit: 'm', group: 'rect',
    hidden: (g) => g.mode !== 'rectangle', read: rectSide(1), write: (g, v) => ({ ...g, depth: Math.abs(v) || null }),
  },
  defaultsField('thickness', slabClassOf, 'Thickness', 'modelingCommand.field.thickness'),
];

/** The builder for each class; slab, roof and plate take the same params. */
const BUILDERS: Record<SlabClass, (s: ViewerState) => ViewerState['addSlab']> = {
  slab: (s) => s.addSlab,
  roof: (s) => s.addRoof,
  plate: (s) => s.addPlate,
};

function slabParams(g: SlabPlaceGesture, z: number, thickness: number): Parameters<ViewerState['addSlab']>[2] {
  if (g.mode === 'polygon') {
    return { Profile: 'polygon', OuterCurve: g.points.map((p) => [p[0], p[1]]), Position: [0, 0, z], Thickness: thickness };
  }
  const rect = rectangleExtent(g);
  if (!rect) throw new Error('The rectangle has no area');
  return { Position: [rect.min[0], rect.min[1], z], Width: rect.width, Depth: rect.depth, Thickness: thickness };
}

export const SLAB_PLACE: ModelingCommand<SlabPlaceGesture> = {
  id: 'slab.place',
  labelKey: 'modelingCommand.slab.label',
  hud: {
    Bar: SlabPlaceBar,
    Scene: SlabPlaceScene,
    hint: (g) => {
      if (g.mode === 'rectangle') return g.points.length === 0 ? 'modelingCommand.slab.hintCorner' : 'modelingCommand.slab.hintOpposite';
      return g.points.length < 3 ? 'modelingCommand.slab.hintVertex' : 'modelingCommand.slab.hintClose';
    },
  },
  fields: FIELDS,
  snap: 'modeling',
  init: (ctx) => initSlabGesture(ctx.get().authoringDefaults.slabMode),
  // A rectangle has no drawing anchor: its locks are sides, not a length and angle.
  snapQuery: (g) => (g.mode === 'polygon'
    ? { anchor: g.points.at(-1) ?? null, chain: g.points, locks: {} }
    : { anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local, square: s.modifiers?.shift ?? false }),
  pointerDown(g, s) {
    if (g.mode === 'rectangle') return g.points.length === 0 ? { ...g, points: [s.local], cursor: s.local } : { commit: true };
    if (closesPolygon(g, s.local)) return { commit: true };
    return { ...g, points: [...g.points, s.local] };
  },
  doubleClick: (g) => (g.mode === 'polygon' && g.points.length >= 3 ? { commit: true } : g),
  undoPoint: (g) => ({ ...g, points: g.points.slice(0, -1), ...(g.mode === 'rectangle' ? { width: null, depth: null } : {}) }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.wall.noPlane' };
    if (g.mode === 'polygon') return g.points.length >= 3 ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.slab.needThree' };
    if (g.points.length === 0) return { ok: false, reasonKey: 'modelingCommand.slab.hintCorner' };
    return rectangleExtent(g) ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.slab.noArea' };
  },
  commit(g, tx) {
    if (tx.storeyId === null) throw new Error('No storey to draw on');
    const cls = tx.store.authoringDefaults.slabClass;
    const thickness = dimOf({ get: () => tx.store }, cls, 'Thickness');
    const made = BUILDERS[cls](tx.store)(tx.modelId, tx.storeyId, slabParams(g, planeZ(tx.workplane), thickness));
    if ('error' in made) throw new Error(`Couldn't add the ${cls}: ${made.error}`);
    return { created: [made.expressId], deleted: [], remesh: [made.expressId], select: [made.expressId] };
  },
  afterCommit: (g) => initSlabGesture(g.mode),
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const thickness = dimOf(ctx, slabClassOf(ctx), 'Thickness');
    const mesh = prismGhostMesh(ctx.workplane, previewOutline(g), 0, thickness, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
