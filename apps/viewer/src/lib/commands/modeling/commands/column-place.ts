/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `column.place` (charter #6232, M2): one click puts a column's base centre
 * on the workplane. Width, Depth and Height are the column defaults (typed
 * in the bar); Rotation turns the section counter-clockwise, R steps it by
 * 15°. The column and its turn are one transaction, so one undo step: the
 * builder writes it axis-aligned and `rotateEntity` turns its placement.
 */

import { commandGhostId } from '../ghost.js';
import { centredRectOutline, prismGhostMesh } from '../ghost-shapes.js';
import type { CommandField, ModelingCommand } from '../types.js';
import type { Vec2 } from '@/lib/snap/types';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';

export const COLUMN_ROTATION_STEP = 15;

export interface ColumnPlaceGesture {
  readonly cursor: Vec2 | null;
  /** Degrees, counter-clockwise from storey-local +x; kept from one column to the next. */
  readonly rotation: number;
}

const normalise = (deg: number) => ((deg % 360) + 360) % 360;

const FIELDS: readonly CommandField<ColumnPlaceGesture>[] = [
  defaultsField('width', 'column', 'Width', 'modelingCommand.field.width'),
  defaultsField('depth', 'column', 'Depth', 'modelingCommand.field.depth'),
  defaultsField('height', 'column', 'Height', 'modelingCommand.field.height'),
  {
    id: 'rotation', labelKey: 'modelingCommand.field.rotation', unit: 'deg', group: 'rotation',
    read: (g) => g.rotation, write: (g, v) => ({ ...g, rotation: normalise(v) }),
  },
];

export const COLUMN_PLACE: ModelingCommand<ColumnPlaceGesture> = {
  id: 'column.place',
  labelKey: 'modelingCommand.column.label',
  hud: { hint: () => 'modelingCommand.column.hint' },
  fields: FIELDS,
  snap: 'modeling',
  keys: [{ commandKey: 'command.column.rotate', run: (g) => ({ ...g, rotation: normalise(g.rotation + COLUMN_ROTATION_STEP) }) }],
  init: () => ({ cursor: null, rotation: 0 }),
  snapQuery: () => ({ anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown: () => ({ commit: true }),
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.wall.noPlane' };
    return g.cursor ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.column.hint' };
  },
  commit(g, tx) {
    if (!g.cursor || tx.storeyId === null) throw new Error('No column to place');
    const ctx = { get: () => tx.store };
    const column = tx.store.addColumn(tx.modelId, tx.storeyId, {
      Position: [g.cursor[0], g.cursor[1], planeZ(tx.workplane)],
      Width: dimOf(ctx, 'column', 'Width'),
      Depth: dimOf(ctx, 'column', 'Depth'),
      Height: dimOf(ctx, 'column', 'Height'),
    });
    if ('error' in column) throw new Error(`Couldn't add column: ${column.error}`);
    if (g.rotation !== 0) {
      const turned = tx.store.rotateEntity(tx.modelId, column.expressId, (g.rotation * Math.PI) / 180);
      if (!turned.ok) throw new Error(`Couldn't rotate the column: ${turned.reason}`);
    }
    return { created: [column.expressId], deleted: [], remesh: [column.expressId], select: [column.expressId] };
  },
  // The next column keeps the rotation.
  afterCommit: (g) => ({ cursor: g.cursor, rotation: g.rotation }),
  cancel: (g) => (g.rotation !== 0 ? 'reset' : 'exit'),
  ghost(g, ctx) {
    if (!ctx.workplane || !g.cursor) return [];
    const outline = centredRectOutline(g.cursor, dimOf(ctx, 'column', 'Width'), dimOf(ctx, 'column', 'Depth'), g.rotation);
    const mesh = prismGhostMesh(ctx.workplane, outline, 0, dimOf(ctx, 'column', 'Height'), commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
