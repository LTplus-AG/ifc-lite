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
 * A floor slab hangs from the workplane, so its top is the level and stays
 * there when its thickness changes (#9198); a roof or plate sits on the plane,
 * which the session raises to the top of the walls for a roof (#9202).
 * Each outline is one transaction, one undo step.
 */

import { roofGhostMeshes } from './roof-place-ghost.js';
import { nextRoof, roofEdgeSlopes, withRoofPitch } from './roof-place-params.js';
import { SlabPlaceBar } from '@/components/viewer/tools/command/PlacementBars';
import { SlabPlaceScene } from '@/components/viewer/tools/command/SlabPlaceScene';
import type { SlabClass } from '@/store/slices/authoringDefaultsSlice';
import type { TranslationKey } from '@/i18n';
import type { ViewerState } from '@/store';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import type { CommandContext, CommandField, ModelingCommand } from '../types.js';
import { defaultsField, dimOf, planeHeightField, planeZ } from './placement-shared.js';
import {
  closesPolygon,
  initSlabGesture,
  previewOutline,
  rectangleCorner,
  rectangleExtent,
  slabBodyRange,
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
    hidden: (g) => g.mode !== 'rectangle', read: rectSide(0), write: (g, v) => ({ ...g, width: Math.abs(v) }),
  },
  {
    id: 'depth', labelKey: 'modelingCommand.field.depth', unit: 'm', group: 'rect',
    hidden: (g) => g.mode !== 'rectangle', read: rectSide(1), write: (g, v) => ({ ...g, depth: Math.abs(v) }),
  },
  defaultsField('thickness', slabClassOf, 'Thickness', 'modelingCommand.field.thickness'),
  planeHeightField(),
  {
    id: 'roofPitch', labelKey: 'modelingCommand.roof.pitch', unit: 'deg', group: 'roof',
    hidden: (_g, ctx) => slabClassOf(ctx) !== 'roof', read: (g) => g.roof.pitch,
    write: (g, pitch) => ({ ...g, roof: withRoofPitch(g.roof, pitch) }),
  },
  {
    id: 'roofOverhang', labelKey: 'modelingCommand.roof.overhang', unit: 'm', group: 'roof',
    hidden: (_g, ctx) => slabClassOf(ctx) !== 'roof', read: (g) => g.roof.overhang,
    write: (g, overhang) => ({ ...g, roof: { ...g.roof, overhang: Math.max(0, overhang) } }),
  },
];

/** The builder for each class; slab, roof and plate take the same params. */
const BUILDERS: Record<SlabClass, (s: ViewerState) => ViewerState['addSlab']> = {
  slab: (s) => s.addSlab,
  roof: (s) => s.addRoof,
  plate: (s) => s.addPlate,
};

function slabParams(g: SlabPlaceGesture, cls: SlabClass, z: number, thickness: number): Parameters<ViewerState['addSlab']>[2] {
  const extrusion = cls === 'slab' ? { ExtrudedDirection: [0, 0, -1] as [0, 0, -1] } : {};
  if (g.mode === 'polygon') {
    return { Profile: 'polygon', OuterCurve: g.points.map((p) => [p[0], p[1]]), Position: [0, 0, z], Thickness: thickness, ...extrusion };
  }
  const rect = rectangleExtent(g);
  if (!rect) throw new Error('The rectangle has no area');
  return { Position: [rect.min[0], rect.min[1], z], Width: rect.width, Depth: rect.depth, Thickness: thickness, ...extrusion };
}

const SLAB_CLASS_TITLES: Record<SlabClass, TranslationKey | undefined> = {
  slab: undefined,
  roof: 'modelWorkspace.tool.roof',
  plate: 'modelingCommand.class.plate',
};

export const SLAB_PLACE: ModelingCommand<SlabPlaceGesture> = {
  id: 'slab.place',
  labelKey: 'modelingCommand.slab.label',
  hud: {
    // The rail's Roof entry is this command: the bar says what is being drawn,
    // roof or plate, and a slab keeps the command's own label.
    title: (s) => SLAB_CLASS_TITLES[s.authoringDefaults.slabClass],
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
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    if (g.mode === 'polygon') return g.points.length >= 3 ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.slab.needThree' };
    if (g.points.length === 0) return { ok: false, reasonKey: 'modelingCommand.slab.hintCorner' };
    return rectangleExtent(g) ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.slab.noArea' };
  },
  commit(g, tx) {
    if (tx.storeyId === null) throw new Error('No storey to draw on');
    const cls = tx.store.authoringDefaults.slabClass;
    const thickness = dimOf({ get: () => tx.store }, cls, 'Thickness');
    const params = slabParams(g, cls, planeZ(tx.workplane), thickness);
    const outline = g.mode === 'polygon' ? g.points : (() => {
      const r = rectangleExtent(g)!;
      return [[r.min[0], r.min[1]], [r.min[0] + r.width, r.min[1]], [r.min[0] + r.width, r.min[1] + r.depth], [r.min[0], r.min[1] + r.depth]] as const;
    })();
    const slopes = cls === 'roof' ? roofEdgeSlopes(g.roof, outline) : [];
    const footprintRoof = slopes.some(slope => slope > 0) || g.roof.overhang > 0;
    const made = cls === 'roof'
      ? tx.store.addRoof(tx.modelId, tx.storeyId, footprintRoof ? { ...params, EdgeSlopes: slopes, Overhang: g.roof.overhang } : params)
      : BUILDERS[cls](tx.store)(tx.modelId, tx.storeyId, params);
    if ('error' in made) throw new Error(`Couldn't add the ${cls}: ${made.error}`);
    return { created: [made.expressId], authored: [made.expressId], deleted: [], remesh: [made.expressId], select: [made.expressId] };
  },
  afterCommit: (g) => ({ ...initSlabGesture(g.mode), roof: nextRoof(g.roof) }),
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const cls = slabClassOf(ctx);
    if (cls === 'roof') {
      const r = rectangleExtent(g);
      const outline = g.mode === 'polygon' ? previewOutline(g) : r
        ? [[r.min[0], r.min[1]], [r.min[0] + r.width, r.min[1]], [r.min[0] + r.width, r.min[1] + r.depth], [r.min[0], r.min[1] + r.depth]] as const : null;
      return outline ? roofGhostMeshes(ctx.workplane, outline, g.roof, dimOf(ctx, cls, 'Thickness'), commandGhostId(ctx.get())) : [];
    }
    const [z0, z1] = slabBodyRange(cls, dimOf(ctx, cls, 'Thickness'));
    const mesh = prismGhostMesh(ctx.workplane, previewOutline(g), z0, z1, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
