/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-mesh a few elements from a subgraph buffer (#6232 WP1): the body of
 * `remesh.worker.ts`, kept free of the wasm import so the real-wasm contract
 * test (`scripts/lib/wasm-remesh-contracts.mjs`) runs this exact code.
 *
 * It calls the same wasm entry points as the load path
 * (`buildPrePassOnce` → `processGeometryBatch` → `convertMeshCollectionToBatch`),
 * with two inputs pinned to the model's load: the RTC frame the model was
 * meshed in, and the style wire resolved from the whole file. The subgraph
 * cannot produce either (styles are not in it, and the RTC detector would
 * pick a different anchor from a handful of entities).
 */

import type { MeshCollection } from '@ifc-lite/wasm';
import { convertMeshCollectionToBatch } from '../geometry-coordinate.js';
import type { ByteStreamingPrePassResult } from '../byte-streaming-prepass-result.js';
import type { RtcFrame } from '../rtc-frame.js';
import type { MeshData, TessellationQuality } from '../types.js';

/**
 * The load-time toggles that change mesh output. Mirror the model's load, or
 * a re-meshed element disagrees with its neighbours.
 */
export interface RemeshConfig {
  mergeLayers: boolean;
  /** `null` keeps the engine default (`medium`), as on load. */
  tessellationQuality: TessellationQuality | null;
  skipSmallCuts: boolean;
  /** The engine default is on; the load path never turns it off. */
  rectParamFastPath: boolean;
}

export interface RemeshRequest {
  /** A standalone STEP buffer (`serializeEntitySubgraph` in `@ifc-lite/export`). */
  buffer: Uint8Array;
  /** Express ids to mesh; other products in the buffer are context only. */
  targets: Uint32Array;
  /** The frame the model was meshed in on load. */
  frame: RtcFrame;
  /** Load-time style wire (item or element id → RGBA, 4 bytes each). */
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  materialElementIds?: Uint32Array;
  materialColorCounts?: Uint32Array;
  materialColors?: Uint8Array;
}

/**
 * The style and material colour wire a whole-file pre-pass resolves: what a
 * re-mesh request must carry, since a subgraph holds no styles.
 */
export interface StyleWire {
  styleIds: Uint32Array;
  styleColors: Uint8Array;
  materialElementIds: Uint32Array;
  materialColorCounts: Uint32Array;
  materialColors: Uint8Array;
}

export interface RemeshResult {
  meshes: MeshData[];
  csgFailures: number;
  ms: { prepass: number; produce: number };
}

/** The slice of `IfcAPI` the re-mesh path calls. */
export interface RemeshApi {
  buildPrePassOnce(data: Uint8Array): unknown;
  processGeometryBatch(
    data: Uint8Array, jobs: Uint32Array, unitScale: number,
    rtcX: number, rtcY: number, rtcZ: number, needsShift: boolean,
    voidKeys: Uint32Array, voidCounts: Uint32Array, voidValues: Uint32Array,
    styleIds: Uint32Array, styleColors: Uint8Array,
    planeAngleToRadians?: number | null,
    materialElementIds?: Uint32Array | null,
    materialColorCounts?: Uint32Array | null,
    materialColors?: Uint8Array | null,
  ): MeshCollection;
  clearPrePassCache(): void;
  setMergeLayers(enabled: boolean): void;
  setTessellationQuality(level?: string | null): void;
  setSkipSmallCuts(on: boolean): void;
  setRectParamFastPath(enabled: boolean): void;
}

/** Apply every config field, so a changed field can never be left stale. */
export function applyRemeshConfig(api: RemeshApi, config: RemeshConfig): void {
  api.setMergeLayers(config.mergeLayers);
  api.setTessellationQuality(config.tessellationQuality);
  api.setSkipSmallCuts(config.skipSmallCuts);
  api.setRectParamFastPath(config.rectParamFastPath);
}

/** Keep the `(id, start, end)` job triplets whose id is a target. */
export function filterJobsToTargets(jobs: Uint32Array, targets: Uint32Array): Uint32Array {
  const wanted = new Set(targets);
  const kept: number[] = [];
  for (let i = 0; i + 2 < jobs.length; i += 3) {
    if (wanted.has(jobs[i])) kept.push(jobs[i], jobs[i + 1], jobs[i + 2]);
  }
  return Uint32Array.from(kept);
}

/**
 * Narrow the model's style wire to the ids a subgraph holds. The engine
 * builds a colour map from every entry it is sent, so sending a large model's
 * whole wire costs a map build per re-mesh. The wire is keyed by item and
 * element ids, and both are in the subgraph when they matter.
 */
export function filterStyleWire(
  styleIds: Uint32Array,
  styleColors: Uint8Array,
  keep: ReadonlySet<number>,
): { styleIds: Uint32Array; styleColors: Uint8Array } {
  const ids: number[] = [];
  const colors: number[] = [];
  for (let i = 0; i < styleIds.length; i++) {
    if (!keep.has(styleIds[i])) continue;
    ids.push(styleIds[i]);
    for (let c = 0; c < 4; c++) colors.push(styleColors[i * 4 + c]);
  }
  return { styleIds: Uint32Array.from(ids), styleColors: Uint8Array.from(colors) };
}

/**
 * Pre-pass the subgraph, mesh the targets in the load frame, and release the
 * pre-pass cache on every exit (the per-content caches are keyed to this
 * buffer and would otherwise leak into the next request).
 */
export function remeshOnApi(api: RemeshApi, req: RemeshRequest, now: () => number = () => performance.now()): RemeshResult {
  const start = now();
  const prePass = api.buildPrePassOnce(req.buffer) as ByteStreamingPrePassResult;
  try {
    const prepassDone = now();
    const jobs = filterJobsToTargets(prePass.jobs ?? new Uint32Array(), req.targets);
    if (jobs.length === 0) {
      return { meshes: [], csgFailures: 0, ms: { prepass: prepassDone - start, produce: 0 } };
    }
    const { frame } = req;
    const collection = api.processGeometryBatch(
      req.buffer, jobs, prePass.unitScale,
      frame.x, frame.y, frame.z, frame.needsShift,
      prePass.voidKeys, prePass.voidCounts, prePass.voidValues,
      req.styleIds, req.styleColors, prePass.planeAngleToRadians,
      req.materialElementIds, req.materialColorCounts, req.materialColors,
    );
    // Read before conversion: `convertMeshCollectionToBatch` frees the collection.
    let csgFailures: number;
    try {
      const diagnostics = collection.diagnostics as { totalCsgFailures?: number } | undefined;
      csgFailures = diagnostics?.totalCsgFailures ?? 0;
    } catch (error) {
      collection.free();
      throw error;
    }
    const meshes = convertMeshCollectionToBatch(collection);
    return { meshes, csgFailures, ms: { prepass: prepassDone - start, produce: now() - prepassDone } };
  } finally {
    api.clearPrePassCache();
  }
}

/**
 * Pre-pass a whole model once and keep only its style wire, releasing the
 * pre-pass cache. Copies each array so nothing aliases the wasm heap.
 */
export function styleWireOnApi(api: RemeshApi, source: Uint8Array): StyleWire {
  const prePass = api.buildPrePassOnce(source) as ByteStreamingPrePassResult;
  try {
    return {
      styleIds: prePass.styleIds.slice(),
      styleColors: prePass.styleColors.slice(),
      materialElementIds: prePass.materialElementIds?.slice() ?? new Uint32Array(),
      materialColorCounts: prePass.materialColorCounts?.slice() ?? new Uint32Array(),
      materialColors: prePass.materialColors?.slice() ?? new Uint8Array(),
    };
  } finally {
    api.clearPrePassCache();
  }
}
