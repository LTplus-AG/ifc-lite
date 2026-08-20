/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reconstruct-side placement sweep.
 *
 * Geometry reaches a recipient as content-addressed mesh blobs, baked at the
 * `usd::xformop` the owner held when the blob was seeded — recorded in the
 * entity's room-only `meta.placementBaseline` (see `packages/collab`'s
 * `placement.ts`). Every client is therefore supposed to render
 * `blob + (current xformop relative to that baseline)`, which is what the
 * baseline docstring promises: *"a late joiner that hydrates a blob baked at M₀
 * while `usd::xformop` already reads M₁ still places it correctly"*.
 *
 * Nothing implemented that. `hydrateGeometryFromRoom` reads `GeometryRef` /
 * `blobHash` only — never `usd::xformop`, never the baseline — so a hydrated
 * mesh always lands at M₀, and the only code that moved it was the *event*
 * handler for a live `usd::xformop` change. An event a client never received,
 * or received before it had a model to move, is never re-derived. Three ways
 * that shows up, in increasing severity:
 *
 *   1. a placement change delivered while the room model is not yet registered
 *      is dropped, and stays dropped until someone moves that entity again;
 *   2. a plain late joiner gets no event at all — it hydrates at the baseline
 *      and simply renders the model in the wrong place;
 *   3. any peer create/delete changes the doc's geometry count, which
 *      re-hydrates every mesh from its baked blob — so already-applied moves
 *      snap back to the baseline, silently, while two people work normally.
 *
 * The fix is to derive placement from the doc at hydrate time instead of only
 * from events: after each reconstruct, compare every entity's live
 * `usd::xformop` against its baseline and reconcile the ones that differ.
 *
 * `collectPlacementDrift` is that comparison, and it is deliberately the same
 * decision the live reconciler makes: "target (relative to baseline) differs
 * from what this client has already applied". It reads the same
 * `placementAppliedLoc` / `placementAppliedYaw` bookkeeping through the same
 * `rendererDeltaForPlacement` / `yawOf` (moved here from `collabSlice` so there
 * is one spelling, not two that must agree), so a sweep never re-applies a move
 * that is already on screen — it is idempotent, and safe to run after every
 * reconstruct.
 *
 * Which is exactly why case 3 needs `clearAppliedPlacements`: after a
 * re-hydrate the meshes are back at their baked baseline, but the applied maps
 * still claim the move is on screen. Left alone, that bookkeeping turns the
 * sweep into a no-op and *pins* the reverted state. The clear must happen
 * whenever meshes are rebuilt, before the sweep.
 */

import type { CollabSession } from '@ifc-lite/collab';
import type { LocalPlacement } from '@ifc-lite/collab';

/** Renderer-frame translation below which a move is not worth pushing. */
export const PLACEMENT_EPS = 1e-6;
/** Yaw (radians) below which a rotation is not worth pushing. */
export const YAW_EPS = 1e-4;

/** Yaw (radians, about Z) encoded by a placement's refDirection (local +X). */
export function yawOf(placement: LocalPlacement | null): number {
  const ref = placement?.refDirection ?? [1, 0, 0];
  return Math.atan2(ref[1], ref[0]);
}

/**
 * Renderer-frame (Y-up) translation that positions an entity's mesh per
 * `placement`, measured from its baked `baseline`. The mesh is baked at the
 * baseline, so only the difference is applied. IFC is Z-up storey-local; the
 * renderer is Y-up: (x, y, z) → (x, z, -y). (This matches the owner's existing
 * `translateEntity` mapping, and shares its "parent placement is unrotated"
 * simplification — fine for storey-local edits.)
 */
export function rendererDeltaForPlacement(
  baseline: LocalPlacement | null,
  placement: LocalPlacement,
): [number, number, number] {
  const bx = baseline?.location[0] ?? 0;
  const by = baseline?.location[1] ?? 0;
  const bz = baseline?.location[2] ?? 0;
  const dx = placement.location[0] - bx;
  const dy = placement.location[1] - by;
  const dz = placement.location[2] - bz;
  return [dx, dz, -dy];
}

/** The doc reads the sweep needs, injected exactly as `collabSlice` wires them. */
export interface PlacementSweepApi {
  iterEntities(doc: CollabSession['doc']): IterableIterator<[string, unknown]>;
  getEntityPlacement(doc: CollabSession['doc'], path: string): LocalPlacement | null;
  getPlacementBaseline(doc: CollabSession['doc'], path: string): LocalPlacement | null;
}

/** One entity whose rendered mesh is not where the doc says it should be. */
export interface PlacementDrift {
  /** Entity path in the room document. */
  path: string;
  /** expressId in the reconstructed (room) store's id space. */
  entityId: number;
  /** The live `usd::xformop` placement to reconcile the mesh to. */
  placement: LocalPlacement;
}

/**
 * Entities whose live `usd::xformop` puts their mesh somewhere other than where
 * this client has already placed it.
 *
 * Skipped:
 *   - entities with no `usd::xformop` (never moved — the blob is authoritative);
 *   - entities with no recorded baseline. A missing baseline means nobody
 *     stamped what the blob was baked at, so the delta is unknowable; the live
 *     reconciler's lazy stamp handles that on the next real edit. A sweep must
 *     not stamp it, because stamping is a doc write and "first writer wins" —
 *     every late joiner would race to freeze the baseline at whatever it
 *     happened to read.
 *   - entities not in `pathToId` (not in this client's reconstructed store).
 */
export function collectPlacementDrift(
  api: PlacementSweepApi,
  doc: CollabSession['doc'],
  pathToId: Map<string, number> | undefined,
  appliedLoc: ReadonlyMap<number, [number, number, number]> | null,
  appliedYaw: ReadonlyMap<number, number> | null,
): PlacementDrift[] {
  if (!pathToId) return [];
  const out: PlacementDrift[] = [];
  for (const [path] of api.iterEntities(doc)) {
    const entityId = pathToId.get(path);
    if (entityId === undefined) continue;
    const placement = api.getEntityPlacement(doc, path);
    if (!placement) continue;
    const baseline = api.getPlacementBaseline(doc, path);
    if (!baseline) continue;

    const target = rendererDeltaForPlacement(baseline, placement);
    const applied = appliedLoc?.get(entityId) ?? [0, 0, 0];
    const movedEnough =
      Math.abs(target[0] - applied[0]) >= PLACEMENT_EPS ||
      Math.abs(target[1] - applied[1]) >= PLACEMENT_EPS ||
      Math.abs(target[2] - applied[2]) >= PLACEMENT_EPS;

    const targetYaw = yawOf(placement) - yawOf(baseline);
    const turnedEnough = Math.abs(targetYaw - (appliedYaw?.get(entityId) ?? 0)) >= YAW_EPS;

    if (movedEnough || turnedEnough) out.push({ path, entityId, placement });
  }
  return out;
}

/**
 * Forget what this client believes is already applied for `entityIds`.
 *
 * Call this whenever meshes are re-hydrated from blobs: the fresh meshes are
 * back at their baked baseline, so every applied entry is now a claim about a
 * mesh that no longer exists. With no argument, forgets everything — which is
 * what a full re-hydrate warrants, since it rebuilds the whole mesh set.
 */
export function clearAppliedPlacements(
  appliedLoc: Map<number, [number, number, number]> | null,
  appliedYaw: Map<number, number> | null,
  entityIds?: Iterable<number>,
): void {
  if (!entityIds) {
    appliedLoc?.clear();
    appliedYaw?.clear();
    return;
  }
  for (const id of entityIds) {
    appliedLoc?.delete(id);
    appliedYaw?.delete(id);
  }
}

/**
 * Re-derive every drifted entity's mesh position from the doc, by handing each
 * to the caller's live reconciler. Returns how many entities were reconciled
 * (0 on a room where nothing has moved since its blobs were baked — the common
 * case, and the reason this is cheap to run on every reconstruct).
 */
export function sweepPlacements(
  api: PlacementSweepApi,
  doc: CollabSession['doc'],
  pathToId: Map<string, number> | undefined,
  appliedLoc: Map<number, [number, number, number]> | null,
  appliedYaw: Map<number, number> | null,
  reconcile: (entityId: number, placement: LocalPlacement) => void,
): number {
  const drift = collectPlacementDrift(api, doc, pathToId, appliedLoc, appliedYaw);
  for (const d of drift) reconcile(d.entityId, d.placement);
  return drift.length;
}
