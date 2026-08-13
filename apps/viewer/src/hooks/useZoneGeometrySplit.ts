/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export one zone's geometry as a model of its own (issue #2508 item 2).
 *
 * #1810 asked for "either geometric splitting or a per-zone quantity
 * breakdown". #2515 shipped the breakdown; this is the splitting, and the
 * reason to want it is the sentence in #2508: actual splitting is what a user
 * needs to EXPORT a per-section model. So the deliverable is a file, not a
 * viewport state.
 *
 * What goes into one zone's file:
 *
 *  - every element whose home zone it is and which does not straddle, whole;
 *  - the CUT PIECE of every straddler that reaches it, from the exact kernel.
 *
 * Three things it refuses to do, each for a reason that already has a
 * precedent in this feature:
 *
 *  - **Run on load.** It is an explicit click, like the apportionment, and for
 *    a stronger reason: an exact arrangement per (element x zone) is orders of
 *    magnitude dearer than the divergence clip that produces the NUMBERS.
 *    Measured through this same wasm build on `AC20-FZK-Haus.ifc` with four
 *    zones tiling its 18 m length: 18 elements produced more than one piece, at
 *    ~357 ms each (6.4 s in total). So this runs per zone, on demand, over the
 *    elements that reach that zone, and its cost is reported back to the user
 *    rather than hidden.
 *  - **Split what the mesher could not prove.** A clip of an open shell
 *    produces pieces whose volumes are arbitrary, not approximate. Those
 *    elements are counted and reported, never quietly dropped.
 *  - **Publish a split that does not add up.** `splitElementByZones` refuses
 *    per element; the count reaches the user.
 */

import { useCallback } from 'react';
import * as IfcWasm from '@ifc-lite/wasm';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from './useBCF.js';
import { buildMergedGLB } from '@/lib/geo/cesium-glb';
import { downloadFile, sanitizeFilename } from '@/lib/export/download';
import { type SplitMeshByZonesFn } from '@/lib/zones/split.js';
import {
  splitZonesInWorker,
  zoneSplitWorkerSupported,
  type ZoneSplitBatchFn,
  type ZoneSplitJob,
  type ZoneSplitProgress,
} from '@/lib/zones/split-worker-client.js';
import { runZoneSplitBatch } from '@/workers/zoneSplit.worker.js';
import {
  compileZone,
  isPointInCompiledZone,
  volumeGateVerdict,
  PROVED_VOLUME_AGREEMENT_REL,
  type Zone,
  type ZoneSet,
} from '@/lib/zones';
import { gatherProvedVolumes } from './useZoneApportionment.js';

/**
 * The binding, read off the namespace rather than imported by name.
 *
 * The wasm runtime is gitignored and rebuilt per host, so a named import would
 * make this module fail to load wherever the bundle is older than this source
 * (the deployment-skew class of #2079) instead of degrading to a message.
 */
const splitFn = (IfcWasm as unknown as { splitMeshByZones?: SplitMeshByZonesFn }).splitMeshByZones;

export interface ZoneGeometryExport {
  /** Elements written whole (their home zone, no straddle). */
  whole: number;
  /** Straddlers contributed as a cut piece. */
  cut: number;
  /** Straddlers the kernel would not split, or whose pieces did not add up. */
  refused: number;
  /** Elements the renderer holds no triangles for at all (never had geometry,
   *  or it was released to reclaim memory). Counted apart from `refused`
   *  because the fix is different: load or re-load the model, rather than look
   *  at the element's own geometry. */
  noGeometry: number;
  /** Total volume in the exported file, cubic metres. `null` when a whole
   *  element's volume was never proved, so the total would understate. */
  volumeM3: number | null;
  bytes: number;
  elapsedMs: number;
}

export type ZoneGeometryExportResult =
  | { ok: true; summary: ZoneGeometryExport }
  | { ok: false; reason: 'no-binding' | 'no-geometry' | 'empty-zone' };

/**
 * Is every vertex of the element inside `zone`?
 *
 * Tested on the element's own AABB corners rather than on every vertex: the box
 * (or prism) is convex, so a bounding box entirely inside it contains only
 * points inside it. Conservative in the safe direction -- an element whose AABB
 * pokes out while its geometry does not is merely cut instead of copied, which
 * costs time and changes no number.
 */
function aabbInsideZone(pieces: readonly MeshData[], zone: Zone): boolean {
  const compiled = compileZone(zone);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const piece of pieces) {
    const ox = piece.origin?.[0] ?? 0;
    const oy = piece.origin?.[1] ?? 0;
    const oz = piece.origin?.[2] ?? 0;
    const p = piece.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i] + ox, y = p[i + 1] + oy, z = p[i + 2] + oz;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return false;
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        if (!isPointInCompiledZone(x, y, z, compiled)) return false;
      }
    }
  }
  return true;
}

/** World-space `MeshData` pieces for one element, or `null`. */
function meshPiecesFor(globalId: number): MeshData[] | null {
  const scene = getGlobalRenderer()?.getScene();
  if (!scene) return null;
  const pieces = scene.getMeshDataPieces(globalId) ?? scene.getInstancedMeshDataPieces?.(globalId);
  return pieces && pieces.length > 0 ? pieces : null;
}

/**
 * The three things this reaches outside itself for, injectable so the ROUTING
 * (which element's geometry lands in which file) is testable without a GPU, a
 * loaded model or a wasm runtime. The kernel's cutting is tested in Rust and
 * across the real boundary in `scripts/test-wasm-contract.mjs`; what is worth
 * testing here is that a straddler's piece goes to the zone that was asked for.
 */
export interface ZoneGeometryDeps {
  split?: SplitMeshByZonesFn;
  meshPieces?: (globalId: number) => MeshData[] | null;
  emit?: (bytes: Uint8Array, filename: string) => void;
  /** Overrides where the cutting runs. Defaults to the worker, falling back
   *  in-process; a test passes its own so no worker is spawned. */
  batch?: ZoneSplitBatchFn;
  /** Reported per element as the batch advances. */
  onProgress?: ZoneSplitProgress;
}

/**
 * Build and download one zone's geometry as a GLB.
 *
 * GLB rather than IFC on purpose: the cut pieces are new solids with no IFC
 * identity of their own, and inventing GlobalIds for them would produce a file
 * that looks like a model and round-trips as a fabrication. A GLB says what
 * this is, which is a geometric extract of one section.
 */
export async function exportZoneGeometry(
  zoneSet: ZoneSet,
  zoneIndex: number,
  deps: ZoneGeometryDeps = {},
): Promise<ZoneGeometryExportResult> {
  // `'split' in deps` rather than `??`: passing the key explicitly as
  // `undefined` is how a caller says "there is no binding", which is the state
  // of an older wasm bundle and the one branch a `??` fallback would make
  // untestable by silently reaching for the real one.
  const split = 'split' in deps ? deps.split : splitFn;
  const meshPieces = deps.meshPieces ?? meshPiecesFor;
  const emit = deps.emit ?? ((bytes: Uint8Array, filename: string) =>
    downloadFile(bytes, filename, 'model/gltf-binary'));
  if (!split) return { ok: false, reason: 'no-binding' };
  const zone = zoneSet.zones[zoneIndex];
  if (!zone) return { ok: false, reason: 'empty-zone' };
  const batch = deps.batch ?? defaultBatch(split);

  const t0 = performance.now();
  const state = useViewerStore.getState();
  const proved = gatherProvedVolumes();
  const meshes: MeshData[] = [];
  let whole = 0;
  let refused = 0;
  let noGeometry = 0;
  let volumeM3: number | null = 0;

  // Phase 1, on this thread: decide what happens to each element. Every input
  // is main-thread state (the renderer's scene, the store, the proved volumes),
  // so moving the decisions across would mean moving the state behind them.
  const jobs: ZoneSplitJob[] = [];
  const pending = new Map<number, { provedVolume: number; color: MeshData['color'] }>();

  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment || !assignment.touchedZoneIds.includes(zone.id)) continue;
    const pieces = meshPieces(globalId);
    if (!pieces) {
      noGeometry++;
      continue;
    }

    // "Does not straddle" is not "wholly inside". v1's straddle flag asks
    // whether the element penetrates ANOTHER zone by more than a millimetre, so
    // an element that pokes out of the zone set entirely -- past the end of the
    // last takt area, over the edge of the top one -- carries no flag at all.
    // Writing it whole would put geometry from OUTSIDE the section into the
    // section's file, and the volume total would say so too. Containment is
    // therefore tested rather than inferred, on the element's own bounds.
    const inside = assignment.straddles ? false : aabbInsideZone(pieces, zone);
    if (inside) {
      // Wholly inside: nothing to cut, and nothing to prove either. Its
      // geometry is already the answer.
      meshes.push(...pieces);
      whole++;
      const provedVolume = proved.byGlobalId.get(globalId);
      if (provedVolume === undefined || proved.rescaled.has(globalId)) volumeM3 = null;
      else if (volumeM3 !== null) volumeM3 += Math.abs(provedVolume);
      continue;
    }

    // Anything else is cut, and only if the mesher proved a single closed solid
    // for it: clipping an open shell yields pieces whose volume is arbitrary
    // rather than approximate. Checked BEFORE the cut, so a refused element
    // costs no clipping at all (30 to 40% of meshed elements in real models do
    // not qualify) and never leaves this thread.
    const provedVolume = proved.byGlobalId.get(globalId);
    if (provedVolume === undefined || proved.rescaled.has(globalId)) {
      refused++;
      continue;
    }
    jobs.push({
      globalId,
      pieces: pieces.map((piece) => ({
        positions: piece.positions,
        indices: piece.indices,
        origin: piece.origin ?? null,
      })),
    });
    pending.set(globalId, { provedVolume, color: pieces[0].color });
  }

  // Phase 2, off this thread: the exact arrangements, which are the whole cost.
  const outcomes = jobs.length > 0
    ? await batch({ zones: zoneSet.zones, zoneIndex, jobs }, deps.onProgress)
    : [];

  // Phase 3, back here: the gate, which needs the proved volumes again.
  let cut = 0;
  for (const outcome of outcomes) {
    const context = pending.get(outcome.globalId);
    if (!context) continue;
    // `ok: false` is the splitter's own refusal: the pieces did not sum to the
    // whole, whose expected cause is zones that overlap each other.
    if (!outcome.ok) {
      refused++;
      continue;
    }
    // The same two-producer cross-check the apportionment runs: the kernel's
    // volume at mesh time against the split's own whole. They disagree when the
    // geometry the Scene holds is not the geometry the kernel measured, e.g. a
    // colour-merged batch re-extracted per entity, which is a silently SHORT
    // mesh rather than a wrong one.
    const verdict = volumeGateVerdict(
      context.provedVolume,
      { wholeVolumeM3: outcome.wholeVolumeM3, unreliable: false },
      PROVED_VOLUME_AGREEMENT_REL,
      false,
    );
    if (verdict !== 'ok') {
      refused++;
      continue;
    }
    // A missing piece for THIS zone is not a refusal: the verdict above
    // already rejected the untrustworthy cases, so it means the element
    // reaches the zone's box without any solid inside it, which is exactly
    // what v1's negative straddle epsilon describes.
    const piece = outcome.piece;
    if (!piece) continue;
    meshes.push({
      expressId: outcome.globalId,
      positions: piece.positions,
      normals: piece.normals,
      indices: piece.indices,
      origin: piece.origin,
      color: context.color,
    } as MeshData);
    cut++;
    if (volumeM3 !== null) volumeM3 += piece.volumeM3;
  }

  if (meshes.length === 0) return { ok: false, reason: 'no-geometry' };

  const glb = buildMergedGLB(meshes);
  emit(glb, `${sanitizeFilename(`${zoneSet.name}-${zone.name}`)}.glb`);
  return {
    ok: true,
    summary: { whole, cut, refused, noGeometry, volumeM3, bytes: glb.byteLength, elapsedMs: performance.now() - t0 },
  };
}

/**
 * The batch splitter to use when the caller names none: the worker, falling
 * back in-process.
 *
 * The fallback is not silent. A browser without workers, or one where spawning
 * fails, gets the old frozen main thread - which is worth having, since the
 * export still produces its file, and worth saying, because "the UI locked up"
 * and "the UI locked up and we know why" are different bug reports.
 */
function defaultBatch(split: SplitMeshByZonesFn): ZoneSplitBatchFn {
  const inProcess: ZoneSplitBatchFn = async (request, onProgress) =>
    runZoneSplitBatch(split, { ...request, zones: request.zones as Zone[] }, onProgress);
  if (!zoneSplitWorkerSupported()) return inProcess;
  return async (request, onProgress) => {
    try {
      return await splitZonesInWorker(request, onProgress);
    } catch (error) {
      console.warn('[zones] the split worker failed; cutting on the main thread instead', error);
      return inProcess(request, onProgress);
    }
  };
}

export function useZoneGeometrySplit() {
  const exportZone = useCallback(
    (zoneSet: ZoneSet, zoneIndex: number, onProgress?: ZoneSplitProgress) =>
      exportZoneGeometry(zoneSet, zoneIndex, onProgress ? { onProgress } : {}),
    [],
  );
  return { exportZone, available: splitFn !== undefined };
}
