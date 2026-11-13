/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { withHostedFillings, copyElements } from '../copy-elements.js';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { copyGhosts, sourceMeshes } from '../copy-ghost.js';
import { readTransformSelection, type TransformSelection } from './element-transform-shared.js';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';
import { joinPlacedWallIn } from '@/store/slices/mutation-wall-joins';
import type { ModelingCommand, Workplane } from '../types.js';
import type { Vec2 } from '@/lib/snap/types';

interface OffsetGesture {
  selection: TransformSelection | null;
  plane: Workplane | null;
  storey: number | null;
  start: Vec2 | null;
  normal: Vec2 | null;
  distance: number;
  side: number;
}
const offset = (g: OffsetGesture): [number, number, number] => [g.normal![0] * g.distance * g.side, g.normal![1] * g.distance * g.side, 0];

export const ELEMENT_OFFSET: ModelingCommand<OffsetGesture> = {
  id: 'element.offset', labelKey: 'moveRotate.offset.label',
  hud: { hint: g => g.normal ? 'moveRotate.offset.hint' : 'moveRotate.offset.wallOnly' },
  fields: [{ id: 'distance', labelKey: 'moveRotate.field.distance', unit: 'm', read: g => g.distance, write: (g, distance) => ({ ...g, distance }) }],
  snap: 'modeling',
  init(ctx) {
    const selection = readTransformSelection(ctx.get());
    if (selection) modelEditTarget(ctx.get(), selection.modelId);
    const s = ctx.get();
    const id = selection?.ids.length === 1 ? selection.ids[0] : null;
    const wall = id !== null && selection ? s.readWallEndpoints(selection.modelId, id) : null;
    const storey = id !== null && selection ? elementStoreyId(s, selection.modelId, id) : null;
    const plane = selection && storey !== null ? buildStoreyWorkplane(s, selection.modelId, storey, 0) : null;
    const dx = wall ? wall.end[0] - wall.start[0] : 0, dy = wall ? wall.end[1] - wall.start[1] : 0, length = Math.hypot(dx, dy);
    return { selection, storey, plane: plane && isWorkplane(plane) ? plane : null, start: wall ? [wall.start[0], wall.start[1]] : null, normal: length > 1e-9 ? [-dy / length, dx / length] : null, distance: 1, side: 1 };
  },
  pointerMove(g, s) {
    const p = g.plane && s.render ? g.plane.renderToLocal(s.render) : s.local;
    return g.start && g.normal ? { ...g, side: (p[0] - g.start[0]) * g.normal[0] + (p[1] - g.start[1]) * g.normal[1] < 0 ? -1 : 1 } : g;
  },
  pointerDown: () => ({ commit: true }), doubleClick: g => g,
  validate: g => g.normal && g.plane && Number.isFinite(g.distance) && g.distance > 0 ? { ok: true } : { ok: false, reasonKey: g.normal ? 'moveRotate.offset.hint' : 'moveRotate.offset.wallOnly' },
  commit(g, tx) {
    if (!g.selection || !g.normal || g.storey === null) throw new Error('Offset requires one wall');
    const result = copyElements(tx.api, g.selection.modelId, g.selection.ids, [{ offset: offset(g) }], { batchId: tx.batchId });
    const remesh = new Set(result.meshed);
    for (const id of result.copies) {
      const joined = joinPlacedWallIn(tx.api, g.selection.modelId, g.storey, id, []);
      if (!joined.ok) throw new Error(joined.reason);
      for (const partner of joined.joined) remesh.add(partner);
    }
    return { modelId: g.selection.modelId, created: [...result.copies], deleted: [], remesh: [...remesh], remeshCause: 'hostsChanged', select: [...result.copies] };
  },
  afterCommit: () => ({ exit: true }),
  ghost(g, ctx) {
    if (!g.selection || !g.plane || !g.normal || !(g.distance > 0)) return [];
    return copyGhosts(ctx.get(), sourceMeshes(ctx.get(), g.selection.modelId, withHostedFillings(ctx.get(), g.selection.modelId, g.selection.ids)), g.plane, g.plane, [{ offset: offset(g) }]);
  },
};
