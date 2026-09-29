/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `opening.place`, `door.place` and `window.place` (charter #6232, A1): point
 * at a wall and click. The host is the wall under the cursor
 * (`hosted-host.ts`); the element slides along it, its centre under the
 * cursor and clamped into the wall, and the ghost shows it in the wall.
 *
 * The bar edits the offset along the host (a typed offset pins the centre
 * that far from the wall's start), the sill and the size. A door's or a
 * window's size and sill are the kind's defaults, shared with the inspector;
 * a bare opening keeps its own in the gesture, from one opening to the next.
 *
 * Hosted only (decision D3): with no wall under the cursor nothing is placed
 * and the refusal says why. A commit is the store's `addHostedFill` in one
 * transaction: opening, voids and fills relationships, the door or window,
 * its type default, and the host re-meshed with its true void (#6391), one
 * undo step.
 */

import type { TranslationKey } from '@/i18n';
import type { AuthoredElementKind } from '@/store/slices/authoringDefaultsSlice';
import type { HostedFillKind, HostedFillSpec } from '@/store/slices/mutation-hosted-fill';
import { commandGhostId } from '../ghost.js';
import { prismGhostMesh } from '../ghost-shapes.js';
import type { CommandContext, CommandField, ModelingCommand } from '../types.js';
import { defaultsField, dimOf, planeZ } from './placement-shared.js';
import { fromHostLocal, hostUnderCursor, toHostLocal, type HostHit } from './hosted-host.js';

export interface OpeningSize {
  readonly Width: number;
  readonly Height: number;
  readonly Sill: number;
}

export interface HostedPlaceGesture {
  readonly host: HostHit | null;
  /** Along the host to the element's centre, metres; null with no host. */
  readonly offset: number | null;
  /** A typed offset: the centre stays this far along whichever wall is under the cursor. */
  readonly offsetLock: number | null;
  /** A bare opening's size and sill (a door's or window's are the kind's defaults). */
  readonly opening: OpeningSize;
}

const OPENING_DEFAULT: OpeningSize = { Width: 1, Height: 1, Sill: 1 };
/** Tolerance on the fit checks: a typed value exactly at the wall's edge fits. */
const FIT_EPS = 1e-6;

type Ctx = Pick<CommandContext, 'get'>;

const LABEL: Readonly<Record<HostedFillKind, TranslationKey>> = {
  opening: 'hostedPlace.tool.opening', door: 'hostedPlace.tool.door', window: 'hostedPlace.tool.window',
};
const HINT: Readonly<Record<HostedFillKind, TranslationKey>> = {
  opening: 'hostedPlace.hint.opening', door: 'hostedPlace.hint.door', window: 'hostedPlace.hint.window',
};

/** The size and sill the next commit builds with, metres. */
export function hostedSize(kind: HostedFillKind, g: HostedPlaceGesture, ctx: Ctx): OpeningSize {
  if (kind === 'opening') return g.opening;
  return { Width: dimOf(ctx, kind, 'Width'), Height: dimOf(ctx, kind, 'Height'), Sill: dimOf(ctx, kind, 'SillHeight') };
}

function placeOn(host: HostHit | null, cursor: readonly [number, number], lock: number | null, width: number): number | null {
  if (!host) return null;
  if (lock !== null) return lock;
  const along = toHostLocal(host, cursor)[0];
  const lo = host.x[0] + width / 2, hi = host.x[1] - width / 2;
  return lo <= hi ? Math.min(hi, Math.max(lo, along)) : along;
}

function fits(kind: HostedFillKind, g: HostedPlaceGesture, ctx: Ctx): boolean {
  const { host, offset } = g;
  if (!host || offset === null) return false;
  const { Width, Height, Sill } = hostedSize(kind, g, ctx);
  return offset - Width / 2 >= host.x[0] - FIT_EPS && offset + Width / 2 <= host.x[1] + FIT_EPS
    && Sill >= host.z[0] - FIT_EPS && Sill + Height <= host.z[1] + FIT_EPS;
}

/** A length the gesture keeps (a bare opening's size): positive, or zero for a sill. */
function openingField(id: keyof OpeningSize, labelKey: TranslationKey): CommandField<HostedPlaceGesture> {
  return {
    id: id.toLowerCase(), labelKey, unit: 'm', group: id === 'Sill' ? 'place' : 'dims',
    read: (g) => g.opening[id],
    write: (g, v) => (id === 'Sill' ? v >= 0 : v > 0) ? { ...g, opening: { ...g.opening, [id]: v } } : g,
  };
}

/** A door's or window's sill: the kind's `SillHeight` default; zero is a door at the floor. */
function sillDefaultField(kind: AuthoredElementKind): CommandField<HostedPlaceGesture> {
  return {
    id: 'sill', labelKey: 'hostedPlace.field.sill', unit: 'm', group: 'place',
    read: (_g, ctx) => dimOf(ctx, kind, 'SillHeight'),
    write: (g, v, ctx) => { if (v >= 0) ctx.get().setAuthoringDims(kind, { SillHeight: v }); return g; },
  };
}

const OFFSET_FIELD: CommandField<HostedPlaceGesture> = {
  id: 'offset', labelKey: 'hostedPlace.field.offset', unit: 'm', group: 'place',
  read: (g) => g.offsetLock ?? g.offset,
  write: (g, v) => ({ ...g, offsetLock: v, offset: g.host ? v : g.offset }),
};

function fieldsOf(kind: HostedFillKind): readonly CommandField<HostedPlaceGesture>[] {
  if (kind === 'opening') {
    return [OFFSET_FIELD, openingField('Sill', 'hostedPlace.field.sill'),
      openingField('Width', 'modelingCommand.field.width'), openingField('Height', 'modelingCommand.field.height')];
  }
  return [OFFSET_FIELD, sillDefaultField(kind),
    defaultsField('width', kind, 'Width', 'modelingCommand.field.width'), defaultsField('height', kind, 'Height', 'modelingCommand.field.height')];
}

/** The builder parameters for the gesture, in the host's frame. */
function specOf(kind: HostedFillKind, g: HostedPlaceGesture, ctx: Ctx): HostedFillSpec {
  const { Width, Height, Sill } = hostedSize(kind, g, ctx);
  const Offset = g.offset ?? 0;
  if (kind === 'opening') return { kind, params: { Offset, Sill, Width, Height } };
  const FrameThickness = dimOf(ctx, kind, 'FrameThickness');
  return { kind, params: { Offset, Sill, Width, Height, FrameThickness } };
}

function makeHostedPlace(kind: HostedFillKind): ModelingCommand<HostedPlaceGesture> {
  const init = (): HostedPlaceGesture => ({ host: null, offset: null, offsetLock: null, opening: OPENING_DEFAULT });
  return {
    id: `${kind}.place`,
    labelKey: LABEL[kind],
    hud: { hint: () => HINT[kind] },
    fields: fieldsOf(kind),
    snap: 'modeling',
    init,
    snapQuery: () => ({ anchor: null, chain: [], locks: {} }),
    pointerMove(g, s, ctx) {
      const host = hostUnderCursor(ctx, s);
      return { ...g, host, offset: placeOn(host, s.local, g.offsetLock, hostedSize(kind, g, ctx).Width) };
    },
    pointerDown: () => ({ commit: true }),
    // The first click of a double-click placed it; the second must not stack another in the same spot.
    doubleClick: (g) => g,
    validate(g, ctx) {
      if (!ctx.workplane || ctx.storeyId === null) return { ok: false, reasonKey: 'modelingCommand.noPlane' };
      if (!g.host) return { ok: false, reasonKey: 'hostedPlace.noHost' };
      return fits(kind, g, ctx) ? { ok: true } : { ok: false, reasonKey: 'hostedPlace.outsideHost' };
    },
    commit(g, tx) {
      if (!g.host || g.offset === null) throw new Error('Doors, windows and openings go in a wall: point at one on this storey');
      const ctx = { get: () => tx.store };
      const placed = tx.store.addHostedFill(tx.modelId, g.host.expressId, specOf(kind, g, ctx), tx.batchId);
      if ('error' in placed) throw new Error(placed.error);
      const created = [...new Set([placed.expressId, placed.openingId])];
      return {
        created,
        deleted: [],
        remesh: [placed.expressId, g.host.expressId],
        // An opening has no mesh to show selected; a door or window is selected to edit next.
        select: kind === 'opening' ? [] : [placed.expressId],
        // A door or window takes the kind's type default in the same step.
        authored: kind === 'opening' ? [] : [placed.expressId],
      };
    },
    // Keep the host, the offset lock and a bare opening's size for the next one.
    afterCommit: (g) => g,
    cancel: (g) => (g.offsetLock !== null ? 'reset' : 'exit'),
    ghost(g, ctx) {
      const { host, offset } = g;
      if (!ctx.workplane || !host || offset === null) return [];
      const { Width, Height, Sill } = hostedSize(kind, g, ctx);
      // Through the wall's body and a hair beyond, so it reads inside the host.
      const y0 = host.y[0] - 0.01, y1 = host.y[1] + 0.01;
      const outline = [[offset - Width / 2, y0], [offset + Width / 2, y0], [offset + Width / 2, y1], [offset - Width / 2, y1]]
        .map((p) => fromHostLocal(host, p as [number, number]));
      const base = host.origin[2] - planeZ(ctx.workplane) + Sill;
      const mesh = prismGhostMesh(ctx.workplane, outline, base, base + Height, commandGhostId(ctx.get()));
      return mesh ? [mesh] : [];
    },
  };
}

export const OPENING_PLACE = makeHostedPlace('opening');
export const DOOR_PLACE = makeHostedPlace('door');
export const WINDOW_PLACE = makeHostedPlace('window');
