/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: classify the entire physical cut before a slab split writes.
 * Conservative canonical body bounds may refuse a crossing cut; a cut is
 * never assigned from its origin alone. The shared placement writer commits
 * the plan after the destination host exists. */
import { placedBodyExtent, resolveSpatialAnchor, toNativeLength } from '@ifc-lite/create';
import { readHostedOpeningBatch } from '../../../../packages/create/src/in-store/hosted-fill-read.js';
import { AnchorEntityReader } from '../../../../packages/create/src/in-store/resolve-anchor.js';
import { refId } from '../../../../packages/create/src/in-store/host-geometry-frame.js';
import type { SplitEnv } from '@/store/slices/mutation-split.js';
import type { SlabEditChain } from './slab-edit.js';
import type { Point2D } from './polygon-clip.js';

export interface SlabOpeningCarry {
  readonly openingId: number;
  /** Native-unit location in the new host, which starts at the body base. */
  readonly location: [number, number, number];
}

export function planSlabOpeningCarry(
  env: SplitEnv, sourceId: number, chain: SlabEditChain, cut: readonly Point2D[],
  cutA: Point2D, cutB: Point2D, baseElevation: number,
): SlabOpeningCarry[] {
  const reader = new AnchorEntityReader(env.dataStore, env.view), openingIds = new Set<number>();
  for (const id of reader.ids('IFCRELVOIDSELEMENT')) {
    const rel = reader.entity(id);
    if (!rel || refId(rel.attributes[4]) !== sourceId) continue;
    const openingId = refId(rel.attributes[5]);
    if (openingId === null || openingIds.has(openingId)) throw new Error('A slab cut requires one readable void relationship per opening');
    openingIds.add(openingId);
  }
  if (openingIds.size === 0) return [];
  // The footprint reader's accepted frame is unrotated and storey-local.
  // Refuse a different placement parent rather than infer world offsets.
  const host = reader.entity(sourceId), placementId = host ? refId(host.attributes[5]) : null;
  const placement = placementId === null ? null : reader.entity(placementId);
  const anchor = resolveSpatialAnchor(env.dataStore, env.storeyExpressId, env.view);
  if (refId(placement?.attributes[0]) !== anchor.storeyPlacementId) throw new Error('A slab with openings must be placed directly in its storey to split safely');
  const dx = cutB[0] - cutA[0], dy = cutB[1] - cutA[1], length = Math.hypot(dx, dy);
  const distance = (x: number, y: number) => (dx * (y - cutA[1]) - dy * (x - cutA[0])) / length;
  const epsilon = 1e-7;
  const sample = cut.map(([x, y]) => distance(x, y)).find(value => Math.abs(value) > epsilon);
  if (sample === undefined) throw new Error('The destination slab has no readable side of the cut');
  const moves: SlabOpeningCarry[] = [], k = env.lengthUnitScale;
  const native = (metres: number) => toNativeLength({ lengthUnitScale: k }, metres);
  const reads = readHostedOpeningBatch(env.dataStore, openingIds, env.view);
  for (const openingId of openingIds) {
    const read = reads.get(openingId);
    const bounds = placedBodyExtent(env.dataStore, openingId, env.view);
    if (!read || read.hostId !== sourceId || !bounds) throw new Error('An unreadable slab opening cannot be carried safely');
    const values = [bounds.min[0], bounds.max[0]].flatMap(x => [bounds.min[1], bounds.max[1]].map(y =>
      distance(x * k + chain.placementOrigin[0], y * k + chain.placementOrigin[1])));
    const min = Math.min(...values), max = Math.max(...values);
    if (min < -epsilon && max > epsilon) throw new Error('The slab split crosses a hosted opening');
    const side = max > epsilon ? 1 : min < -epsilon ? -1 : 0;
    if (side === 0) throw new Error('The slab opening has no readable side of the cut');
    if (side !== Math.sign(sample)) continue;
    moves.push({ openingId, location: [
      read.location[0] + native(chain.placementOrigin[0]),
      read.location[1] + native(chain.placementOrigin[1]),
      read.location[2] + native(chain.placementOrigin[2] - baseElevation),
    ] });
  }
  return moves;
}
