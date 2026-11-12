/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


import { commitElementMirror } from '@/lib/element-transform/commit';
import { MirrorBar } from '@/components/viewer/tools/command/MirrorBar';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { commandGhostId } from '../ghost.js';
import { readTransformSelection, selectionGhosts, type TransformSelection } from './element-transform-shared.js';
import type { ModelingCommand } from '../types.js';
import type { Vec2 } from '@/lib/snap/types';

export interface MirrorGesture {
  selection: TransformSelection | null;
  anchor: Vec2 | null;
  cursor: Vec2 | null;
  angle: number | null;
  copy: boolean;
  alt: boolean;
}

function axis(g: MirrorGesture): readonly [Vec2, Vec2] | null {
  if (!g.anchor) return null;
  const end: Vec2 | null = g.angle === null ? g.cursor : [g.anchor[0] + Math.cos(g.angle * Math.PI / 180), g.anchor[1] + Math.sin(g.angle * Math.PI / 180)];
  return end && Math.hypot(end[0] - g.anchor[0], end[1] - g.anchor[1]) > 1e-9 ? [g.anchor, end] : null;
}

export const ELEMENT_MIRROR: ModelingCommand<MirrorGesture> = {
  id: 'element.mirror', labelKey: 'moveRotate.mirror.label',
  hud: { Bar: MirrorBar, hint: g => !g.selection ? 'moveRotate.noSelection' : g.anchor ? 'moveRotate.mirror.hintEnd' : 'moveRotate.mirror.hintStart' },
  fields: [{ id: 'angle', labelKey: 'moveRotate.field.angle', unit: 'deg', read: g => g.angle ?? 0, write: (g, angle) => ({ ...g, angle }) }],
  snap: 'modeling',
  init(ctx) {
    const selection = readTransformSelection(ctx.get());
    if (selection) modelEditTarget(ctx.get(), selection.modelId);
    return { selection, anchor: null, cursor: null, angle: null, copy: false, alt: false };
  },
  snapQuery: g => ({ anchor: g.anchor, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local, alt: !!s.modifiers?.alt }),
  pointerDown: (g, s) => g.anchor ? { commit: true } : { ...g, anchor: s.local, cursor: s.local, alt: !!s.modifiers?.alt },
  doubleClick: g => g,
  undoPoint: g => ({ ...g, anchor: null, angle: null }),
  validate(g, ctx) {
    if (!g.selection) return { ok: false, reasonKey: 'moveRotate.noSelection' };
    if (!ctx.workplane) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    return axis(g) ? { ok: true } : { ok: false, reasonKey: 'moveRotate.mirror.hintEnd' };
  },
  commit(g, tx) {
    const a = axis(g);
    if (!a || !g.selection || !tx.workplane) throw new Error('Mirror requires an axis and a selection');
    return commitElementMirror(tx, g.selection.modelId, g.selection.ids, [tx.workplane.localToRender([...a[0], 0]), tx.workplane.localToRender([...a[1], 0])], g.copy || g.alt);
  },
  afterCommit: () => ({ exit: true }),
  ghost(g, ctx) {
    const a = axis(g), plane = ctx.workplane;
    if (!a || !plane || !g.selection) return [];
    const dx = a[1][0] - a[0][0], dy = a[1][1] - a[0][1], d2 = dx * dx + dy * dy;
    return selectionGhosts(ctx.get(), g.selection, p => {
      const q = plane.renderToLocal(p), x = q[0] - a[0][0], y = q[1] - a[0][1];
      const t = (x * dx + y * dy) / d2;
      return plane.localToRender([a[0][0] + 2 * t * dx - x, a[0][1] + 2 * t * dy - y, q[2]]);
    }, commandGhostId(ctx.get()), true);
  },
};
