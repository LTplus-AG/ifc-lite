/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orchestrates VOLUME apportionment for zone straddlers (issue #2508, item 1) —
 * the gather-and-run step, the way `useZoneAssignmentSync` owns v1's and
 * `useClash` owns clash's, while `zonesSlice` only holds state.
 *
 * Three things this deliberately does NOT do:
 *
 *  - **Run on load.** There is no effect here and nothing subscribes. Clipping
 *    is memory-bandwidth bound (more workers gave zero speedup, threaded wasm
 *    measured 0.87x), so the only lever is doing less of it. It runs when a
 *    user asks, over straddlers only, and the answer is cached.
 *  - **Clear the cache on a zone edit.** Entries carry the `zoneSetRevision`
 *    they were computed against and every read goes through `validEntry`. A
 *    forgotten clear is invisible; a forgotten check is impossible.
 *  - **Guess a volume it cannot prove.** An element only apportions when the
 *    mesher certified a single closed orientable solid (#1891/#1993). The rest
 *    are recorded with a REASON, so a per-zone total can say what it left out
 *    instead of quietly omitting it.
 *
 * Federation is free: the renderer's `Scene` is shared across every loaded
 * model and is already keyed by the same federated global id `zoneAssignments`
 * uses, so this walks one map rather than N.
 */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from './useBCF.js';
import {
  apportionElementVolume,
  volumeGateVerdict,
  zoneSetRevision,
  type ApportionmentRefusal,
  type ElementApportionment,
  type ElementMeshPiece,
  type ZoneApportionmentEntry,
} from '../lib/zones/index.js';
import type { ZoneSet } from '../lib/zones/types.js';

/** `globalId -> proved enclosed volume (m3)` across every loaded model.
 *
 *  Read from each model's `geometryResult`, not from the Scene: the Scene's
 *  per-entity extraction rebuilds `MeshData` and does not carry
 *  `geometryVolume` through, so asking it would refuse every element in a
 *  colour-merged batch. */
function gatherProvedVolumes(): Map<number, number> {
  const state = useViewerStore.getState();
  const out = new Map<number, number>();
  const absorb = (result: { meshes?: Array<{ expressId: number; geometryVolume?: number }>; instancedGeometryVolumes?: Map<number, number> } | null | undefined) => {
    if (!result) return;
    for (const mesh of result.meshes ?? []) {
      if (typeof mesh.geometryVolume === 'number' && Number.isFinite(mesh.geometryVolume)) {
        out.set(mesh.expressId, mesh.geometryVolume);
      }
    }
    if (result.instancedGeometryVolumes) {
      for (const [id, v] of result.instancedGeometryVolumes) {
        if (Number.isFinite(v)) out.set(id, v);
      }
    }
  };
  absorb(state.geometryResult);
  for (const model of state.models.values()) absorb(model.geometryResult);
  return out;
}

/** World-space CPU triangles for one element, or `null` when the renderer has
 *  none (never had geometry, or geometry was released for memory, #2183). */
function piecesFor(globalId: number): ElementMeshPiece[] | null {
  const scene = getGlobalRenderer()?.getScene();
  if (!scene) return null;
  const pieces = scene.getMeshDataPieces(globalId) ?? scene.getInstancedMeshDataPieces?.(globalId);
  if (!pieces || pieces.length === 0) return null;
  return pieces.map((p) => ({ positions: p.positions, indices: p.indices, origin: p.origin }));
}

/** The straddlers of `zoneSet` per v1's classification — the only elements
 *  worth clipping, and the reason this stays cheap. */
export function straddlerIdsFor(zoneSetId: string): number[] {
  const assignments = useViewerStore.getState().zoneAssignments;
  const ids: number[] = [];
  for (const [globalId, record] of assignments) {
    if (record[zoneSetId]?.straddles) ids.push(globalId);
  }
  return ids;
}

export interface ApportionOneResult {
  apportionment: ElementApportionment | null;
  refusal: ApportionmentRefusal | null;
}

/** Clip ONE element against a zone set, without touching the store. Exported so
 *  the per-element path and the whole-set path share the gate rather than
 *  reimplementing it. */
export function apportionOne(
  globalId: number,
  zoneSet: ZoneSet,
  proved: Map<number, number>,
): ApportionOneResult {
  const pieces = piecesFor(globalId);
  const result = pieces ? apportionElementVolume(pieces, zoneSet.zones) : null;
  const verdict = volumeGateVerdict(proved.get(globalId), result);
  if (verdict !== 'ok' || !result) return { apportionment: null, refusal: verdict === 'ok' ? 'no-geometry' : verdict };
  return { apportionment: result, refusal: null };
}

/**
 * Apportion every straddler of `zoneSet` and write the result into the store.
 * Synchronous and on the main thread: measured at 44-52 us per element over 241
 * straddlers of a 1516-element structural model (~11 ms for the lot), which is
 * inside AGENTS.md's interaction budget without a worker. Returns the entry it
 * stored so a caller can report counts without re-reading the store.
 */
export function computeZoneApportionmentNow(zoneSet: ZoneSet): ZoneApportionmentEntry {
  const proved = gatherProvedVolumes();
  const byElement = new Map<number, ElementApportionment>();
  const refused = new Map<number, ApportionmentRefusal>();
  const t0 = performance.now();
  for (const globalId of straddlerIdsFor(zoneSet.id)) {
    const { apportionment, refusal } = apportionOne(globalId, zoneSet, proved);
    if (apportionment) byElement.set(globalId, apportionment);
    else if (refusal) refused.set(globalId, refusal);
  }
  const entry: ZoneApportionmentEntry = {
    revision: zoneSetRevision(zoneSet),
    byElement,
    refused,
    computedAt: Date.now(),
    elapsedMs: performance.now() - t0,
  };
  useViewerStore.getState().setZoneApportionment(zoneSet.id, entry);
  return entry;
}

/**
 * Apportion ONE element and merge it into the set's entry, so selecting a
 * straddler in the properties panel costs one element's clip rather than the
 * whole model's. Merging is only legal while the revision still matches; when
 * it does not, the stale entry is replaced rather than extended.
 */
export function computeZoneApportionmentForElement(zoneSet: ZoneSet, globalId: number): ApportionOneResult {
  const proved = gatherProvedVolumes();
  const t0 = performance.now();
  const result = apportionOne(globalId, zoneSet, proved);
  const elapsedMs = performance.now() - t0;

  const revision = zoneSetRevision(zoneSet);
  const previous = useViewerStore.getState().zoneApportionment.get(zoneSet.id);
  const fresh = previous && previous.revision === revision;
  const byElement = new Map(fresh ? previous.byElement : undefined);
  const refused = new Map(fresh ? previous.refused : undefined);
  byElement.delete(globalId);
  refused.delete(globalId);
  if (result.apportionment) byElement.set(globalId, result.apportionment);
  else if (result.refusal) refused.set(globalId, result.refusal);

  useViewerStore.getState().setZoneApportionment(zoneSet.id, {
    revision,
    byElement,
    refused,
    computedAt: Date.now(),
    elapsedMs: (fresh ? previous.elapsedMs : 0) + elapsedMs,
  });
  return result;
}

/** React-facing handles for the two entry points above. */
export function useZoneApportionment() {
  const computeSet = useCallback((zoneSet: ZoneSet) => computeZoneApportionmentNow(zoneSet), []);
  const computeElement = useCallback(
    (zoneSet: ZoneSet, globalId: number) => computeZoneApportionmentForElement(zoneSet, globalId),
    [],
  );
  return { computeSet, computeElement };
}
