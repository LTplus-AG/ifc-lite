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
 *  - **Run on load.** It is an explicit click, like the apportionment. Clipping
 *    is memory-bandwidth bound; the only lever is doing less of it.
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
import { splitElementByZones, type SplitMeshByZonesFn } from '@/lib/zones/split.js';
import { volumeGateVerdict, PROVED_VOLUME_AGREEMENT_REL, type ZoneSet } from '@/lib/zones';
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
  /** Total volume in the exported file, cubic metres. `null` when a whole
   *  element's volume was never proved, so the total would understate. */
  volumeM3: number | null;
  bytes: number;
  elapsedMs: number;
}

export type ZoneGeometryExportResult =
  | { ok: true; summary: ZoneGeometryExport }
  | { ok: false; reason: 'no-binding' | 'no-geometry' | 'empty-zone' };

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
}

/**
 * Build and download one zone's geometry as a GLB.
 *
 * GLB rather than IFC on purpose: the cut pieces are new solids with no IFC
 * identity of their own, and inventing GlobalIds for them would produce a file
 * that looks like a model and round-trips as a fabrication. A GLB says what
 * this is, which is a geometric extract of one section.
 */
export function exportZoneGeometry(
  zoneSet: ZoneSet,
  zoneIndex: number,
  deps: ZoneGeometryDeps = {},
): ZoneGeometryExportResult {
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

  const t0 = performance.now();
  const state = useViewerStore.getState();
  const proved = gatherProvedVolumes();
  const meshes: MeshData[] = [];
  let whole = 0;
  let cut = 0;
  let refused = 0;
  let volumeM3: number | null = 0;

  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[zoneSet.id];
    if (!assignment || !assignment.touchedZoneIds.includes(zone.id)) continue;
    const pieces = meshPieces(globalId);
    if (!pieces) {
      refused++;
      continue;
    }

    if (!assignment.straddles) {
      // Wholly inside: nothing to cut, and nothing to prove either. Its
      // geometry is already the answer.
      meshes.push(...pieces);
      whole++;
      const provedVolume = proved.byGlobalId.get(globalId);
      if (provedVolume === undefined || proved.rescaled.has(globalId)) volumeM3 = null;
      else if (volumeM3 !== null) volumeM3 += Math.abs(provedVolume);
      continue;
    }

    // A straddler is cut, and only if the mesher proved a single closed solid
    // for it: clipping an open shell yields pieces whose volume is arbitrary
    // rather than approximate. Checked BEFORE the cut, so a refused element
    // costs no clipping at all (30 to 40% of meshed elements in real models do
    // not qualify).
    const provedVolume = proved.byGlobalId.get(globalId);
    if (provedVolume === undefined || proved.rescaled.has(globalId)) {
      refused++;
      continue;
    }
    // `null` here is the splitter's own refusal: the pieces did not sum to the
    // whole, whose expected cause is zones that overlap each other.
    const elementSplit = splitElementByZones(split, pieces, zoneSet.zones);
    if (!elementSplit) {
      refused++;
      continue;
    }
    // The same two-producer cross-check the apportionment runs: the kernel's
    // volume at mesh time against the split's own whole. They disagree when the
    // geometry the Scene holds is not the geometry the kernel measured, e.g. a
    // colour-merged batch re-extracted per entity, which is a silently SHORT
    // mesh rather than a wrong one.
    const verdict = volumeGateVerdict(
      provedVolume,
      { wholeVolumeM3: elementSplit.wholeVolumeM3, unreliable: false },
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
    const piece = elementSplit.pieces.find((p) => p.zoneIndex === zoneIndex);
    if (!piece) continue;
    meshes.push({
      expressId: globalId,
      positions: piece.positions,
      normals: piece.normals,
      indices: piece.indices,
      origin: piece.origin,
      color: pieces[0].color,
    } as MeshData);
    cut++;
    if (volumeM3 !== null) volumeM3 += piece.volumeM3;
  }

  if (meshes.length === 0) return { ok: false, reason: 'no-geometry' };

  const glb = buildMergedGLB(meshes);
  emit(glb, `${sanitizeFilename(`${zoneSet.name}-${zone.name}`)}.glb`);
  return {
    ok: true,
    summary: { whole, cut, refused, volumeM3, bytes: glb.byteLength, elapsedMs: performance.now() - t0 },
  };
}

export function useZoneGeometrySplit() {
  const exportZone = useCallback(
    (zoneSet: ZoneSet, zoneIndex: number) => exportZoneGeometry(zoneSet, zoneIndex),
    [],
  );
  return { exportZone, available: splitFn !== undefined };
}
