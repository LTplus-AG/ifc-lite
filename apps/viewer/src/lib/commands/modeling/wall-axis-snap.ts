/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Wall placement resolves mesh and plan body targets to the design reference (#9296). */
import { useViewerStore } from '@/store';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import type { WallAxis } from '@/lib/snap/sources/semantic';
import { buildLocus, projectCandidate } from '@/lib/snap/constraints';
import { closestOnSegment } from '@/lib/snap/sources/linework';
import type { SnapQuery, SnapResult, Vec2 } from '@/lib/snap/types';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import type { CommandSnapInput } from './snap-solve';

let cache: { modelId: string; version: number; storeyId: number; store: WeakRef<object>; view: WeakRef<object>; axes: Map<number, WallAxis> } | null = null;
export function remapWallBodySnap(snap: SnapResult, modelId: string, query: Pick<SnapQuery, 'anchor' | 'chain' | 'locks'>, input: CommandSnapInput): SnapResult {
  const winner = snap.winner;
  if (!winner || !['mesh', 'linework'].includes(winner.source) || !winner.entity || !['endpoint', 'vertex', 'midpoint'].includes(winner.kind)) return snap;
  const s = useViewerStore.getState();
  const storeyId = s.session?.storeyId;
  if (storeyId == null || winner.entity.modelId !== modelId) return snap;
  const store = s.models.get(modelId)?.ifcDataStore, view = s.mutationViews.get(modelId);
  if (!store || !view) return snap;
  if (!cache || cache.modelId !== modelId || cache.version !== s.mutationVersion || cache.storeyId !== storeyId || cache.store.deref() !== store || cache.view.deref() !== view) {
    cache = { modelId, version: s.mutationVersion, storeyId, store: new WeakRef(store), view: new WeakRef(view), axes: new Map(storeyWallAxes(store, view, storeyId).map((axis) => [axis.expressId, axis])) };
  }
  const axis = cache.axes.get(winner.entity.expressId);
  if (!axis) return snap;
  const points: Vec2[] = [axis.a, axis.b];
  if (winner.kind === 'midpoint') points.push([(axis.a[0] + axis.b[0]) / 2, (axis.a[1] + axis.b[1]) / 2]);
  const gap = (p: Vec2) => Math.hypot(p[0] - winner.local[0], p[1] - winner.local[1]);
  const reference = closestOnSegment(winner.local, axis.a, axis.b);
  const nearest = points.reduce((a, b) => gap(a) <= gap(b) ? a : b);
  // A vertex around an opening can be halfway down a long wall. Keep its
  // station on the reference line rather than jumping metres to a wall end.
  const reach = gap(reference) + (input.profile ?? MODELING_SNAP_PROFILE).radiusPx * input.metresPerPixel;
  const local = Math.hypot(nearest[0] - reference[0], nearest[1] - reference[1]) <= reach ? nearest : reference;
  const candidate = { ...winner, kind: winner.kind === 'vertex' ? 'endpoint' as const : winner.kind, local, elevation: undefined, source: 'semantic' as const, guide: undefined };
  const locus = buildLocus({ ...query, cursor: input.cursor, metresPerPixel: input.metresPerPixel, modifiers: { shift: input.mods.shiftKey, alt: false } }, input.profile ?? MODELING_SNAP_PROFILE);
  const landed = projectCandidate(candidate, locus, snap.local);
  return landed ? { ...snap, winner: candidate, local: landed } : snap;
}
