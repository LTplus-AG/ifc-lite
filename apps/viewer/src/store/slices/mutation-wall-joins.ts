/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall joins in the viewer (#6232 B2): the store glue behind `wall.place`
 * (an L at every chained corner, a T where a wall ends on another's path) and
 * `wall.moveEndpoint` / wall resize (a dragged corner brings the walls joined
 * there along; every join that touches a moved wall is recomputed).
 *
 * The geometry and the IFC live in `@ifc-lite/create`
 * (`joinWallsInStore`, `reshapeWallsInStore`): pure, metres, storey-local.
 * Here they run inside `recordModellingEdit`, which is all-or-nothing and puts
 * every record written (rewritten bodies and axes, the relationship, the ones
 * it replaces) on the undo stack, so the surrounding transaction makes the
 * lot ONE step. Re-meshing is the caller's: the ids come back.
 *
 * Joins are authored in IFC2X3, IFC4 and IFC4X3 models (D2); an IFC5 / IFCX
 * model keeps its walls unjoined.
 */

import {
  joinWallsInStore,
  readWallJoinRels,
  readWallJoinTarget,
  reshapeWallsInStore,
  resolveWallJoinAnchor,
  type WallReshape,
  type WallReshapeOptions,
} from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { mutationDenial } from '../mutation-permission.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';

/** Why a model cannot take wall joins at all, or null. */
export function wallJoinRefusal(state: ViewerState, modelId: string): string | null {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return `No model loaded for id "${modelId}"`;
  const schema = String(dataStore.schemaVersion ?? 'IFC4').toUpperCase();
  if (schema === 'IFC5' || !dataStore.source || dataStore.source.byteLength === 0) {
    return 'Wall joins are authored in IFC2X3, IFC4 and IFC4X3 models only';
  }
  return null;
}

export interface WallJoinPlacedOutcome {
  ok: true;
  /** The walls the new wall was joined to. */
  joined: number[];
  /** Candidates that did not join, with the reason (a fold-back, walls that do not meet). */
  skipped: Array<{ wallId: number; reason: string }>;
}

export type WallJoinOutcome = WallJoinPlacedOutcome | { ok: false; reason: string };

/** How far (metres) from a wall's axis a new wall's end may fall and still land ON that wall: a T. */
const PATH_SLACK = 0.001;
/** Walls further than this from an end are not looked at. */
const NEAR = 1;

interface Segment { a: readonly [number, number]; b: readonly [number, number] }

function distanceToSegment(p: readonly [number, number], { a, b }: Segment): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Join a wall just placed to the walls it meets: `chain` (the walls before it
 * in the same chain, whose ends it starts from or closes on) and any other wall
 * of its storey that an end of it lands on. The new wall is the `b` side, so on
 * a tie the earlier wall runs through the corner.
 */
export function joinPlacedWallIn(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  wallId: number,
  chain: readonly number[],
): WallJoinOutcome {
  const state = store.getState();
  const refusal = mutationDenial(state, modelId) ?? wallJoinRefusal(state, modelId);
  if (refusal) return { ok: false, reason: refusal };
  const target = modelEditTarget(state, modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  const { dataStore, view } = target;
  const scale = getModelLengthUnitScale(dataStore);
  const placed = readWallJoinTarget(dataStore, view, wallId, scale);
  if (!placed) return { ok: false, reason: `Wall #${wallId} cannot be joined: its body is not one a join can rewrite` };

  // Chain neighbours first, then the walls an end of this one lands on.
  const partners = new Set<number>(chain.filter((id) => id !== wallId));
  const ends = [placed.wall.start, placed.wall.end];
  for (const axis of storeyWallAxes(dataStore, view, storeyId)) {
    if (axis.expressId === wallId || partners.has(axis.expressId)) continue;
    const near = ends.map((end) => distanceToSegment(end, axis));
    if (Math.min(...near) > NEAR) continue;
    const other = readWallJoinTarget(dataStore, view, axis.expressId, scale);
    if (!other) continue;
    const reach = (placed.wall.thickness + other.wall.thickness) / 2 + PATH_SLACK;
    if (Math.min(...near) <= reach) partners.add(axis.expressId);
  }
  if (partners.size === 0) return { ok: true, joined: [], skipped: [] };

  const joined: number[] = [];
  const skipped: Array<{ wallId: number; reason: string }> = [];
  try {
    recordModellingEdit(store, modelId, (_methods, draft) => {
      const anchor = resolveWallJoinAnchor(dataStore, draft.getMutationView());
      for (const partner of partners) {
        // A pair that does not meet (a fold-back, a wall in another frame) is refused before anything is written.
        try {
          joinWallsInStore(draft, dataStore, anchor, partner, wallId);
          joined.push(partner);
        } catch (error) {
          skipped.push({ wallId: partner, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, joined, skipped };
}

export type WallReshapeOutcome =
  | { ok: true; /** Every wall whose geometry was written: the ones to re-mesh. */ walls: number[]; droppedJoins: number }
  | { ok: false; reason: string };

/**
 * Give walls new axis ends (metres, storey-local) and keep the joins that
 * touch them current, as one recorded edit tagged `batchId`.
 */
export function reshapeWallsIn(
  store: ModellingStore,
  modelId: string,
  edits: readonly WallReshape[],
  options: WallReshapeOptions,
  batchId?: string,
): WallReshapeOutcome {
  const state = store.getState();
  const denial = mutationDenial(state, modelId);
  if (denial) return { ok: false, reason: denial };
  const target = modelEditTarget(state, modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  try {
    const result = recordModellingEdit(store, modelId, (_methods, draft) => {
      const anchor = resolveWallJoinAnchor(target.dataStore, draft.getMutationView());
      return reshapeWallsInStore(draft, target.dataStore, anchor, edits, options);
    }, batchId);
    return { ok: true, walls: result.walls, droppedJoins: result.droppedRelIds.length };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The walls joined to any of `wallIds` (not those themselves): the ones a change to `wallIds` re-cuts. */
export function joinedPartnersOf(state: ViewerState, modelId: string, wallIds: readonly number[]): number[] {
  const target = modelEditTarget(state, modelId);
  if (!target) return [];
  const own = new Set(wallIds);
  const partners = new Set<number>();
  for (const rel of readWallJoinRels(target.dataStore, target.view, own)) {
    for (const id of [rel.relatingId, rel.relatedId]) if (!own.has(id)) partners.add(id);
  }
  return [...partners];
}
