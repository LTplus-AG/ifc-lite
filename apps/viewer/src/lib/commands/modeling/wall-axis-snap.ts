/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Wall placement resolves mesh and plan body targets to the design reference (#9296). */
import { useViewerStore } from '@/store';
import { modelWallAxes } from './model-wall-axes';
import { buildLocus, projectCandidate } from '@/lib/snap/constraints';
import { closestOnSegment } from '@/lib/snap/sources/linework';
import type { SnapQuery, SnapResult, Vec2 } from '@/lib/snap/types';
import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import type { CommandSnapInput } from './snap-solve';
import type { Workplane } from './types';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from './workplane';

export function remapWallBodySnap(snap: SnapResult, plane: Workplane, query: Pick<SnapQuery, 'anchor' | 'chain' | 'locks'>, input: CommandSnapInput): SnapResult {
  const winner = snap.winner;
  if (!winner || !['mesh', 'linework'].includes(winner.source) || !winner.entity || !['endpoint', 'vertex', 'midpoint'].includes(winner.kind)) return snap;
  const s = useViewerStore.getState();
  const { modelId, expressId } = winner.entity;
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (storeyId == null) return snap;
  const original = modelWallAxes(modelId, storeyId).get(expressId);
  if (!original) return snap;
  const source = buildStoreyWorkplane(s, modelId, storeyId, 0);
  if (!isWorkplane(source)) return snap;
  const toLocal = (p: Vec2): Vec2 => {
    const q = plane.renderToLocal(source.localToRender([p[0], p[1], 0]));
    return [q[0] + 0, q[1] + 0];
  };
  const axis = { a: toLocal(original.a), b: toLocal(original.b) };
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
