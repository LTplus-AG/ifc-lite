/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `column.place` (charter #6232, M2): one click puts a column's base centre
 * on the workplane. Width, Depth and Height are the column defaults (typed
 * in the bar), or a picked section (I, L, T, U, C, circle, hollow: the bar's
 * Section picker) in place of Width and Depth; Rotation turns the section counter-clockwise, R steps it by
 * 15°. The builder writes the turn as the placement's RefDirection, so a
 * turned column is one entity graph and one undo step.
 */

import { commandGhostId } from '../ghost.js';
import { centredRectOutline, prismGhostMesh } from '../ghost-shapes.js';
import type { CommandField, ModelingCommand } from '../types.js';
import type { Vec2 } from '@/lib/snap/types';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';
import { rectangleOnly, sectionExtentOf, sectionGhost, sectionOf } from './linear-section.js';
import { ColumnPlaceProfileBar } from '@/components/viewer/tools/command/ProfileBars';

const columnOwner = () => 'column' as const;

export const COLUMN_ROTATION_STEP = 15;

export interface ColumnPlaceGesture {
  readonly cursor: Vec2 | null;
  /** Degrees, counter-clockwise from storey-local +x; kept from one column to the next. */
  readonly rotation: number;
}

const normalise = (deg: number) => ((deg % 360) + 360) % 360;

const FIELDS: readonly CommandField<ColumnPlaceGesture>[] = [
  rectangleOnly(defaultsField('width', 'column', 'Width', 'modelingCommand.field.width'), columnOwner),
  rectangleOnly(defaultsField('depth', 'column', 'Depth', 'modelingCommand.field.depth'), columnOwner),
  defaultsField('height', 'column', 'Height', 'modelingCommand.field.height'),
  {
    id: 'rotation', labelKey: 'modelingCommand.field.rotation', unit: 'deg', group: 'rotation',
    read: (g) => g.rotation, write: (g, v) => ({ ...g, rotation: normalise(v) }),
  },
];

export const COLUMN_PLACE: ModelingCommand<ColumnPlaceGesture> = {
  id: 'column.place',
  labelKey: 'modelingCommand.column.label',
  hud: { Bar: ColumnPlaceProfileBar, hint: () => 'modelingCommand.column.hint' },
  fields: FIELDS,
  snap: 'modeling',
  keys: [{ commandKey: 'command.column.rotate', run: (g) => ({ ...g, rotation: normalise(g.rotation + COLUMN_ROTATION_STEP) }) }],
  init: () => ({ cursor: null, rotation: 0 }),
  snapQuery: () => ({ anchor: null, chain: [], locks: {} }),
  pointerMove: (g, s) => ({ ...g, cursor: s.local }),
  pointerDown: () => ({ commit: true }),
  // The first click of a double-click already placed the column; the second must not stack another on it.
  doubleClick: (g) => g,
  validate(g, ctx) {
    if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
    return g.cursor ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.column.hint' };
  },
  commit(g, tx) {
    if (!g.cursor || tx.storeyId === null) throw new Error('No column to place');
    const ctx = { get: () => tx.store };
    const turn = (g.rotation * Math.PI) / 180;
    const profile = sectionOf(ctx, 'column');
    const column = tx.store.addColumn(tx.modelId, tx.storeyId, {
      Position: [g.cursor[0], g.cursor[1], planeZ(tx.workplane)],
      ...(profile ? { Profile: profile } : { Width: dimOf(ctx, 'column', 'Width'), Depth: dimOf(ctx, 'column', 'Depth') }),
      Height: dimOf(ctx, 'column', 'Height'),
      // The section's Width axis, storey-local: the turn is written with the column.
      RefDirection: [Math.cos(turn), Math.sin(turn), 0],
    });
    if ('error' in column) throw new Error(`Couldn't add column: ${column.error}`);
    return { created: [column.expressId], authored: [column.expressId], deleted: [], remesh: [column.expressId], select: [column.expressId] };
  },
  // The next column keeps the rotation.
  afterCommit: (g) => ({ cursor: g.cursor, rotation: g.rotation }),
  cancel: (g) => (g.rotation !== 0 ? 'reset' : 'exit'),
  ghost(g, ctx) {
    if (!ctx.workplane || !g.cursor) return [];
    const profile = sectionOf(ctx, 'column');
    if (profile) {
      // The section's X runs along the turned RefDirection, as the builder writes it.
      const turn = (g.rotation * Math.PI) / 180;
      const [c, s] = [Math.cos(turn), Math.sin(turn)];
      const swept = sectionGhost(ctx, profile, { origin: [g.cursor[0], g.cursor[1], 0], u: [c, s, 0], v: [-s, c, 0], along: [0, 0, 1], length: dimOf(ctx, 'column', 'Height') });
      return swept ? [swept] : [];
    }
    const [width, depth] = sectionExtentOf(ctx, 'column');
    const outline = centredRectOutline(g.cursor, width, depth, g.rotation);
    const mesh = prismGhostMesh(ctx.workplane, outline, 0, dimOf(ctx, 'column', 'Height'), commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};
