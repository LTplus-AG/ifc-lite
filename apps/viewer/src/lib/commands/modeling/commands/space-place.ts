/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `space.place` (charter #6232, M2): an IfcSpace on the session workplane,
 * drawn exactly like a slab outline (a rectangle from two corners, or a
 * polygon closed by Enter, a double-click or its first vertex) and extruded
 * by the space Height default through the in-store `addSpace`. Each outline
 * is one transaction, one undo step.
 *
 * Interim: the M4 Room tool supersedes this command's UI (it keeps the
 * params → `addSpace` core below, `spaceParams`).
 */

import { SpacePlaceBar } from '@/components/viewer/tools/command/SpacePlaceBar';
import { SlabPlaceScene } from '@/components/viewer/tools/command/SlabPlaceScene';
import type { ViewerState } from '@/store';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import type { CommandField, ModelingCommand } from '../types.js';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';
import {
  closesPolygon,
  initSlabGesture,
  previewOutline,
  rectangleCorner,
  rectangleExtent,
  type SlabPlaceGesture,
} from './slab-place-geometry.js';

/** A space outline is drawn with the slab gesture: same corners, locks and closing rules. */
export type SpacePlaceGesture = SlabPlaceGesture;

type SpaceParams = Parameters<ViewerState['addSpace']>[2];

/** The `addSpace` params for an outline at storey-local height `z`, `height` tall. */
export function spaceParams(g: SpacePlaceGesture, z: number, height: number): SpaceParams {
  if (g.mode === 'polygon') {
    return { Profile: 'polygon', OuterCurve: g.points.map((p) => [p[0], p[1]]), Position: [0, 0, z], Height: height };
  }
  const rect = rectangleExtent(g);
  if (!rect) throw new Error('The rectangle has no area');
  return { Position: [rect.min[0], rect.min[1], z], Width: rect.width, Depth: rect.depth, Height: height };
}

const rectSide = (axis: 0 | 1) => (g: SpacePlaceGesture): number | null => {
  const first = g.points[0];
  const corner = rectangleCorner(g);
  return first && corner ? Math.abs(corner[axis] - first[axis]) : (axis === 0 ? g.width : g.depth);
};

const FIELDS: readonly CommandField<SpacePlaceGesture>[] = [
  {
    id: 'width', labelKey: 'modelingCommand.field.width', unit: 'm', group: 'rect',
    hidden: (g) => g.mode !== 'rectangle', read: rectSide(0), write: (g, v) => ({ ...g, width: Math.abs(v) }),
  },
  {
    id: 'depth', labelKey: 'modelingCommand.field.depth', unit: 'm', group: 'rect',
    hidden: (g) => g.mode !== 'rectangle', read: rectSide(1), write: (g, v) => ({ ...g, depth: Math.abs(v) }),
  },
  defaultsField('height', 'space', 'Height', 'modelingCommand.field.height'),
];

export const SPACE_PLACE: ModelingCommand<SpacePlaceGesture> = {
  id: 'space.place',
  labelKey: 'kindVariants.space.label',
  hud: {
    Bar: SpacePlaceBar,
    Scene: SlabPlaceScene,
    hint: (g) => {
      if (g.mode === 'rectangle') return g.points.length === 0 ? 'modelingCommand.slab.hintCorner' : 'modelingCommand.slab.hintOpposite';
      return g.points.length < 3 ? 'modelingCommand.slab.hintVertex' : 'modelingCommand.slab.hintClose';
    },
  },
  fields: FIELDS,
  snap: 'modeling',
  init: (ctx) => initSlabGesture(ctx.get().authoringDefaults.spaceMode),
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
    const height = dimOf({ get: () => tx.store }, 'space', 'Height');
    const made = tx.store.addSpace(tx.modelId, tx.storeyId, spaceParams(g, planeZ(tx.workplane), height));
    if ('error' in made) throw new Error(`Couldn't add the space: ${made.error}`);
    return { created: [made.expressId], authored: [made.expressId], deleted: [], remesh: [made.expressId], select: [made.expressId] };
  },
  afterCommit: (g, _result, ctx) => {
    // Spaces are hidden by default; a space just drawn must show.
    const s = ctx.get();
    if (!s.typeVisibility.spaces) s.toggleTypeVisibility('spaces');
    return initSlabGesture(g.mode);
  },
  ghost(g, ctx) {
    if (!ctx.workplane) return [];
    const mesh = prismGhostMesh(ctx.workplane, previewOutline(g), 0, dimOf(ctx, 'space', 'Height'), commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
