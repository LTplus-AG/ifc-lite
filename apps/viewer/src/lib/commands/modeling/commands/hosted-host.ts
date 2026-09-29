/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The host of a hosted placement (charter #6232, A1): the wall under the
 * cursor, and what the gesture needs to know about it.
 *
 * The candidates are the semantic snap source's walls: the session storey's
 * wall axes (`storeyWallAxes`, the same reader the snap engine and the plan
 * use). A snap onto a wall's axis, end or middle names that wall; otherwise
 * the wall whose body the cursor is over (in 3D, the pointer lands on a
 * wall face, which is within half its thickness of the axis) is the host.
 *
 * A host is read in its own frame, like the builders write it: `x` runs along
 * the wall from its placement origin, `y` across it, `z` up. Reads are cached
 * per host and edit (`mutationVersion`), not per pointer move.
 */

import { hostPlanFrame, resolveHostAnchor } from '@ifc-lite/create';
import type { SnapResult, Vec2 } from '@/lib/snap/types';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import type { WallAxis } from '@/lib/snap/sources/semantic';
import type { ViewerState } from '@/store';
import type { CommandContext, Vec3 } from '../types.js';

/** A wall to host an opening, door or window; lengths in metres. */
export interface HostHit {
  readonly expressId: number;
  /** The wall's placement origin, storey-local (z: above the storey). */
  readonly origin: Vec3;
  /** Its local +X on the storey plane (unit). */
  readonly axisX: Vec2;
  /** Its body's extent in its own frame: along, across and up. */
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly z: readonly [number, number];
}

/** How far off a wall's axis a cursor may be and still pick it, beyond half its thickness. */
const REACH = 0.05;

let axesCache: { key: string; axes: readonly WallAxis[] } | null = null;
const hostCache = new Map<string, HostHit | null>();

function storeyAxes(s: ViewerState, modelId: string, storeyId: number): readonly WallAxis[] {
  const key = `${modelId}:${storeyId}:${s.mutationVersion}`;
  if (axesCache?.key === key) return axesCache.axes;
  const store = s.models.get(modelId)?.ifcDataStore;
  const view = s.mutationViews.get(modelId);
  const axes = store && view ? storeyWallAxes(store, view, storeyId) : [];
  axesCache = { key, axes };
  return axes;
}

/** The wall `expressId` as a host, or null when it cannot take one (no placement or readable body). */
export function readHost(s: ViewerState, modelId: string, expressId: number): HostHit | null {
  const key = `${modelId}:${expressId}:${s.mutationVersion}`;
  if (hostCache.has(key)) return hostCache.get(key)!;
  if (hostCache.size > 64) hostCache.clear();
  const host = readHostUncached(s, modelId, expressId);
  hostCache.set(key, host);
  return host;
}

function readHostUncached(s: ViewerState, modelId: string, expressId: number): HostHit | null {
  const store = s.models.get(modelId)?.ifcDataStore;
  if (!store) return null;
  const view = s.mutationViews.get(modelId) ?? null;
  let anchor: ReturnType<typeof resolveHostAnchor>;
  try {
    anchor = resolveHostAnchor(store, expressId, view);
  } catch (error) {
    // Not a host (a slab, no placement, no containing storey): the cursor keeps looking.
    console.debug(`[modeling] #${expressId} cannot host an opening`, error);
    return null;
  }
  const frame = hostPlanFrame(store, expressId, anchor.storeyId, view);
  const bounds = anchor.hostBounds;
  if (anchor.hostKind !== 'wall' || !frame || !bounds) return null;
  const k = anchor.lengthUnitScale ?? 1;
  const span = (i: number) => [bounds.min[i] * k, bounds.max[i] * k] as const;
  return { expressId, origin: frame.origin, axisX: frame.axisX, x: span(0), y: span(1), z: span(2) };
}

/** A storey-local point in the host's own frame: [along, across]. */
export function toHostLocal(host: HostHit, p: Vec2): Vec2 {
  const dx = p[0] - host.origin[0], dy = p[1] - host.origin[1];
  const [ax, ay] = host.axisX;
  return [dx * ax + dy * ay, -dx * ay + dy * ax];
}

/** A point of the host's own frame on the storey plane. */
export function fromHostLocal(host: HostHit, p: Vec2): Vec2 {
  const [ax, ay] = host.axisX;
  return [host.origin[0] + p[0] * ax - p[1] * ay, host.origin[1] + p[0] * ay + p[1] * ax];
}

function distanceToAxis(p: Vec2, w: WallAxis): number {
  const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((p[0] - w.a[0]) * dx + (p[1] - w.a[1]) * dy) / len2));
  return Math.hypot(p[0] - (w.a[0] + t * dx), p[1] - (w.a[1] + t * dy));
}

/** Whether `p` is over the host's body in plan (its footprint, grown by `REACH`). */
function over(host: HostHit, p: Vec2): boolean {
  const [u, v] = toHostLocal(host, p);
  return u >= host.x[0] - REACH && u <= host.x[1] + REACH && v >= host.y[0] - REACH && v <= host.y[1] + REACH;
}

/**
 * The wall under the solved cursor on the session storey, or null. A snap
 * target on a wall of the session model wins; otherwise the nearest wall
 * axis whose body the cursor is over.
 */
export function hostUnderCursor(ctx: Pick<CommandContext, 'get' | 'modelId' | 'storeyId'>, s: SnapResult): HostHit | null {
  if (ctx.storeyId === null) return null;
  const state = ctx.get();
  const axes = storeyAxes(state, ctx.modelId, ctx.storeyId);
  const snapped = s.winner?.entity?.modelId === ctx.modelId ? s.winner.entity.expressId : null;
  if (snapped !== null && axes.some((w) => w.expressId === snapped)) {
    const host = readHost(state, ctx.modelId, snapped);
    if (host) return host;
  }
  const ranked = axes
    .map((w) => ({ id: w.expressId, d: distanceToAxis(s.local, w) }))
    .sort((a, b) => a.d - b.d);
  for (const { id } of ranked.slice(0, 4)) {
    const host = readHost(state, ctx.modelId, id);
    if (host && over(host, s.local)) return host;
  }
  return null;
}
