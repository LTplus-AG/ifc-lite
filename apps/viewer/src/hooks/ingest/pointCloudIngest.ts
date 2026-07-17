/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LAS / LAZ ingest path for the viewer.
 *
 * Streams a Blob through `@ifc-lite/pointcloud`'s decode worker and
 * pushes chunks directly into the renderer via the streaming API. The
 * federated model entry carries no per-chunk data — it only holds the
 * renderer handle, summary metadata, and bbox so removeModel can free
 * the GPU resources cleanly.
 */

import type { Renderer } from '@ifc-lite/renderer';
import {
  accumulateClassificationCounts,
  classificationCountEntries,
  createClassificationCounts,
  streamPointCloud,
  type DecodedPointChunk,
  type StreamHandle,
} from '@ifc-lite/pointcloud';
import type { CoordinateInfo, GeometryResult, PointCloudAsset } from '@ifc-lite/geometry';
import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import type { SchemaVersion } from '../../store/types.js';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';

export type PointCloudFormat = 'las' | 'laz' | 'ply' | 'pcd' | 'e57' | 'pts' | 'xyz';

/**
 * Synthetic IfcDataStore for a point-cloud-only model. Picking a point sets
 * the synthetic expressId as the selected entity, which then runs through the
 * regular property/hover/properties-panel pipeline. That pipeline calls
 * `entities.getTypeName / getName / getGlobalId` and `properties.getForEntity`
 * — `createSyntheticDataStore` builds a real single-row entity table (plus the
 * lazy `getEntity` / `getProperties` accessors) so every member of the
 * `IfcDataStore` contract is present and compiler-enforced — no `as unknown as`
 * shims that silently drop an accessor and crash picking at runtime (#1004).
 *
 * `IfcGeographicElement` is the closest IFC4 entity for a real-world scan; the
 * entity table derives its enum (58) from the type name itself.
 */
function emptyDataStore(
  fileSize: number,
  expressId: number,
  fileName: string,
): IfcDataStore {
  return createSyntheticDataStore({
    schemaVersion: 'IFC4',
    fileSize,
    entityCount: 1,
    entities: [{
      expressId,
      type: 'IfcGeographicElement',
      globalId: `pointcloud-${expressId}`,
      name: fileName,
      hasGeometry: true,
    }],
  });
}

export interface PointCloudIngestResult {
  dataStore: IfcDataStore;
  geometryResult: GeometryResult;
  schemaVersion: SchemaVersion;
  /** Renderer handle so the model removal path can free GPU resources. */
  rendererHandle: { id: number };
  /** Stream handle so the caller can `cancel()` mid-flight. */
  streamHandle: StreamHandle;
  /** Resolves once decoding finishes (or rejects on error / cancel). */
  done: Promise<void>;
}

export interface PointCloudIngestOptions {
  format: PointCloudFormat;
  blob: Blob;
  fileName: string;
  /** Source file size in bytes — used only for the synthetic data store.
   *  Point clouds stream from `blob`; the whole file is never read into
   *  memory here, so we take the size rather than an ArrayBuffer. */
  fileSize: number;
  /** Renderer to push chunks into. Streaming starts immediately. */
  renderer: Renderer;
  /** Express ID assigned to this asset (for picking + federation). */
  expressId?: number;
  /** Federation index (set when the model registry is multi-model). */
  modelIndex?: number;
  /** Soft cap on points held on the GPU. Default: 25M. */
  maxPointsInMemory?: number;
  /** Hard cap on file size in bytes. Default: 4 GB. */
  maxFileSize?: number;
  /** Progress callback shared with the existing UI. */
  onProgress?: (progress: { phase: string; percent: number }) => void;
  /** Notified with +1 when streaming starts and -1 if it errors. */
  onAssetCountDelta?: (delta: number) => void;
  /**
   * Classification histogram for the streamed scan (#1783). Called
   * with the renderer handle id and the running classId → point-count
   * record — periodically during streaming so the classes checklist
   * fills in progressively, and once more on completion. Called with
   * `null` when the stream errors (asset removed) or when no chunk
   * carried classifications.
   */
  onClassCounts?: (handleId: number, counts: Record<number, number> | null) => void;
  /** Abort signal to cancel ingest. */
  signal?: AbortSignal;
}

/**
 * Detect a supported point-cloud format from filename or magic bytes.
 * Returns null when the buffer isn't a recognised format.
 *
 * Magic-byte sniffing covers files renamed by users:
 *   - LAS:  "LASF" (0x4653414c)
 *   - PLY:  "ply\n" or "ply\r\n" at offset 0
 *   - PCD:  "# .PCD" or any `.PCD` token in first 32 bytes
 *   - LAZ:  shares LAS magic; we trust the extension here
 */
export function detectPointCloudFormat(
  fileName: string,
  buffer: ArrayBuffer | null,
): PointCloudFormat | null {
  // Magic bytes win over extension when both are available — a LAS
  // file dropped as `*.ply` should still load as LAS, not be forced
  // through the wrong decoder. PTS / XYZ are ASCII so they have no
  // distinctive magic and stay extension-only at the bottom.
  if (buffer && buffer.byteLength >= 8) {
    const view = new DataView(buffer, 0, Math.min(buffer.byteLength, 32));
    // E57 magic = "ASTM-E57" (8 bytes) — check before LAS so files
    // can't accidentally match on the LAS magic in their first 4 bytes.
    if (
      view.getUint8(0) === 0x41 && view.getUint8(1) === 0x53
      && view.getUint8(2) === 0x54 && view.getUint8(3) === 0x4d
      && view.getUint8(4) === 0x2d && view.getUint8(5) === 0x45
      && view.getUint8(6) === 0x35 && view.getUint8(7) === 0x37
    ) return 'e57';
    if (view.getUint32(0, true) === 0x4653414c /* "LASF" little-endian */) {
      // LAS and LAZ share the LASF magic; differentiate by extension
      // when available, otherwise default to LAS (laz-perf will throw
      // a clear error on a non-LAZ payload).
      const lower = fileName.toLowerCase();
      if (lower.endsWith('.laz')) return 'laz';
      return 'las';
    }
    // ASCII probes: "ply" header / PCD header line.
    const b0 = view.getUint8(0), b1 = view.getUint8(1), b2 = view.getUint8(2);
    if (b0 === 0x70 /* p */ && b1 === 0x6c /* l */ && b2 === 0x79 /* y */) return 'ply';
    // PCDs in the wild use three header shapes:
    //   1. `# .PCD v0.7\n…`              — original commented header
    //   2. `VERSION 0.7\n…`              — version-first (PCL pcl_io)
    //   3. `FIELDS x y z\n…`             — fields-first (some converters)
    // Match all three so a renamed PCD doesn't fall through to the
    // extension-based detector.
    if (b0 === 0x23 /* # */ && view.byteLength > 4 && view.getUint8(2) === 0x2e /* . */) return 'pcd';
    if (
      b0 === 0x56 /* V */ && b1 === 0x45 /* E */ && b2 === 0x52 /* R */
      && view.byteLength > 7 && view.getUint8(3) === 0x53 /* S */
      && view.getUint8(4) === 0x49 /* I */ && view.getUint8(5) === 0x4f /* O */
      && view.getUint8(6) === 0x4e /* N */
    ) return 'pcd';
    if (
      b0 === 0x46 /* F */ && b1 === 0x49 /* I */ && b2 === 0x45 /* E */
      && view.byteLength > 6 && view.getUint8(3) === 0x4c /* L */
      && view.getUint8(4) === 0x44 /* D */ && view.getUint8(5) === 0x53 /* S */
    ) return 'pcd';
  }
  // Fall back to extension when the buffer is missing / too short
  // OR for ASCII formats (PTS / XYZ) that don't carry a magic header.
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.las')) return 'las';
  if (lower.endsWith('.laz')) return 'laz';
  if (lower.endsWith('.ply')) return 'ply';
  if (lower.endsWith('.pcd')) return 'pcd';
  if (lower.endsWith('.e57')) return 'e57';
  if (lower.endsWith('.pts')) return 'pts';
  if (lower.endsWith('.xyz')) return 'xyz';
  return null;
}

/**
 * Map common unsupported formats to a user-facing explanation. Drop
 * handlers call this when nothing else recognises a dropped file so the
 * user sees "this is a Recap project, export to E57" instead of nothing
 * happening.
 */
export function describeUnsupportedFormat(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) {
    return 'ZIP archive — please extract first. .ply / .las / .laz / .e57 files inside will load.';
  }
  if (
    lower.endsWith('.rwp') || lower.endsWith('.rwi')
    || lower.endsWith('.rwcx') || lower.endsWith('.dmt')
    || lower.endsWith('.lay') || lower.endsWith('.db1')
  ) {
    return 'Autodesk ReCap (.rwp/.rwi/.rwcx) is a proprietary format we cannot decode. Export to E57 or LAS from ReCap.';
  }
  if (lower.endsWith('.skp')) return 'SketchUp model — not a point cloud.';
  if (lower.endsWith('.fls') || lower.endsWith('.lsproj')) {
    return 'Faro Scene project — export to E57 from Scene to load it here.';
  }
  return null;
}

/**
 * Counter for synthetic expressIds when callers don't supply one.
 * Multiple inline-LAS/LAZ/E57 ingests in the same session would
 * otherwise collide on `1`, breaking federation lookup, picking, and
 * BCF hooks. Bumping a process-local counter is enough — the
 * FederationRegistry then layers in the per-model offset on top.
 */
let nextSyntheticExpressId = 1;

/**
 * Counter shared across all in-flight ingests. We log up to
 * `DEBUG_CLASS_LOG_LIMIT` chunks total per page session — enough to
 * see whether the first scan's classifications are reaching the
 * renderer without spamming the console for users with many files.
 *
 * Reset to zero on a hot module reload (HMR re-evaluates the module),
 * so the dev workflow is "load file → see ≤ 3 chunk diagnostics".
 */
const DEBUG_CLASS_LOG_LIMIT = 3;
let debugClassChunkLogs = 0;

/**
 * Log presence + 16-bin histogram of the chunk's classification IDs.
 * Used to debug "classification colour mode shows everything as
 * unclassified". Common causes the histogram surfaces immediately:
 *   - chunk.classifications is undefined → format / decoder didn't
 *     emit it (look at the format's streaming source).
 *   - All values 0 or 1 → file is genuinely unclassified (LAS spec
 *     classes 0 = "Created, never classified", 1 = "Unclassified");
 *     not a viewer bug.
 *   - Non-trivial spread but rendering is grey → packing or shader
 *     read is wrong.
 */
function logChunkClassHistogram(
  fileName: string,
  format: PointCloudFormat,
  chunk: DecodedPointChunk,
): void {
  const classes = chunk.classifications;
  if (!classes) {
    // E57 has no standard classification field per ASTM E2807, so
    // most scans (Faro Focus, Leica BLK, Trimble) won't carry one.
    // A non-standard `classification` prototype field IS now read
    // when present; absence here means the file genuinely doesn't
    // include per-point class IDs.
    const hint = format === 'e57'
      ? ' (E57 spec doesn\'t define classification — file must be from CloudCompare or a custom LIDAR pipeline to have it)'
      : ' (decoder didn\'t emit any per-point class IDs)';
    console.log(
      `[pointcloud-debug] ${format} ${fileName} chunk #${debugClassChunkLogs}: `
      + `pointCount=${chunk.pointCount} classifications=undefined${hint}`,
    );
    return;
  }
  // 32-wide histogram (covers the ASPRS LAS 1.4 standard range).
  // Anything past 31 lands in `overflow` so misclassified high
  // values still surface.
  const hist = new Uint32Array(32);
  let overflow = 0;
  let sample: number[] = [];
  const n = Math.min(classes.length, chunk.pointCount);
  for (let i = 0; i < n; i++) {
    const c = classes[i];
    if (c < 32) hist[c]++;
    else overflow++;
    if (sample.length < 8) sample.push(c);
  }
  const nonZero: string[] = [];
  for (let c = 0; c < 32; c++) {
    if (hist[c] > 0) nonZero.push(`${c}=${hist[c]}`);
  }
  if (overflow > 0) nonZero.push(`>31:${overflow}`);
  console.log(
    `[pointcloud-debug] ${format} ${fileName} chunk #${debugClassChunkLogs}: `
    + `pointCount=${chunk.pointCount} classes.length=${classes.length} `
    + `first8=[${sample.join(',')}] hist={${nonZero.join(', ')}}`,
  );
}

/**
 * Stream a point cloud into the renderer. Returns immediately; await
 * `result.done` for completion.
 */
export function ingestPointCloud(opts: PointCloudIngestOptions): PointCloudIngestResult {
  const expressId = opts.expressId ?? nextSyntheticExpressId++;
  // Use 'IfcGeographicElement' for PLY/PCD/LAS/LAZ — IFC4 doesn't define
  // an IfcPointCloud entity, and IfcGeographicElement is the closest
  // semantic fit (a real-world geographic feature backed by a scan).
  const handle = opts.renderer.beginPointCloudStream({
    expressId,
    ifcType: 'IfcGeographicElement',
    modelIndex: opts.modelIndex,
  });
  const onCountChange = opts.onAssetCountDelta ?? (() => {});
  onCountChange(+1);

  // Running per-class histogram, pushed to the caller periodically so
  // the classes checklist populates while a large scan is still
  // streaming (#1783). Every 8 chunks ≈ every 1.6M points at the
  // default 200k chunk size — frequent enough to feel live, rare
  // enough not to spam store updates.
  const classCounts = createClassificationCounts();
  let sawClassifications = false;
  let chunksSinceCountsPush = 0;
  const CHUNKS_PER_COUNTS_PUSH = 8;
  const pushClassCounts = () => {
    if (!opts.onClassCounts) return;
    // A classification-free stream reports null, as documented on the
    // option — the store treats that as "drop this asset's histogram",
    // which is a no-op when nothing was ever recorded.
    if (!sawClassifications) {
      opts.onClassCounts(handle.id, null);
      return;
    }
    const counts: Record<number, number> = {};
    for (const { classId, count } of classificationCountEntries(classCounts)) {
      counts[classId] = count;
    }
    opts.onClassCounts(handle.id, counts);
  };

  // `streamPointCloud()` can throw synchronously during validation /
  // worker setup (e.g. invalid `chunkSize`, oversized blob). The
  // renderer asset + counter increment have already happened above, so
  // a sync throw must clean those up before propagating — otherwise
  // we leak an empty GPU asset and the `pointCloudAssetCount` stays
  // permanently inflated.
  let stream: StreamHandle;
  try {
    stream = streamPointCloud({
      format: opts.format,
      blob: opts.blob,
      label: opts.fileName,
      maxPointsInMemory: opts.maxPointsInMemory,
      maxFileSize: opts.maxFileSize,
      signal: opts.signal,
      onOpen: (info) => {
        opts.onProgress?.({
          phase: info.stride > 1
            ? `Streaming (${info.stride}× downsampled, ${info.totalPointCount.toLocaleString()} pts)`
            : `Streaming (${info.totalPointCount.toLocaleString()} pts)`,
          percent: 10,
        });
      },
      onChunk: (chunk) => {
        // Per-chunk classification diagnostic. Logs whether the
        // chunk carries a classifications buffer and a 16-bin class
        // histogram for the first few chunks of each stream so it's
        // easy to see whether the source actually carries class IDs
        // (LAS files often have everything as 0/1 for "unclassified").
        // Capped at 3 logs per stream to keep the console readable;
        // further debug-on-demand can be done from devtools.
        if (debugClassChunkLogs < DEBUG_CLASS_LOG_LIMIT) {
          debugClassChunkLogs++;
          logChunkClassHistogram(opts.fileName, opts.format, chunk);
        }
        // LAS / LAZ / E57 / typical scan-style PLY + PCD all store data
        // Z-up by convention (LIDAR / surveying tradition). The renderer
        // is Y-up internally — the IFCx ingest path applies the same
        // swap inside `pointcloud-extractor.ts`. Without this, the scan
        // shows up rotated 90° onto its side.
        const yUp = swapZupChunkToYup(chunk);
        opts.renderer.appendPointCloudChunk(handle, yUp);
        opts.renderer.requestRender();
        // Classification histogram — the axis swap doesn't touch the
        // classifications buffer, so accumulate from the source chunk.
        sawClassifications = accumulateClassificationCounts(classCounts, chunk) || sawClassifications;
        if (++chunksSinceCountsPush >= CHUNKS_PER_COUNTS_PUSH) {
          chunksSinceCountsPush = 0;
          pushClassCounts();
        }
      },
      onProgress: (loaded, total) => {
        const pct = total > 0 ? Math.min(99, 10 + Math.floor((loaded / total) * 89)) : 50;
        opts.onProgress?.({
          phase: `Streaming (${loaded.toLocaleString()} / ${total.toLocaleString()})`,
          percent: pct,
        });
      },
      onComplete: () => {
        opts.renderer.endPointCloudStream(handle);
        pushClassCounts();
        opts.onProgress?.({ phase: 'Streaming complete', percent: 100 });
      },
      onError: () => {
        opts.renderer.removePointCloudAsset(handle);
        opts.onClassCounts?.(handle.id, null);
        onCountChange(-1);
      },
    });
  } catch (err) {
    opts.renderer.removePointCloudAsset(handle);
    opts.onClassCounts?.(handle.id, null);
    onCountChange(-1);
    throw err;
  }

  // Build a minimal GeometryResult that satisfies the model registry.
  // The actual point data is on the GPU, not in memory.
  const coordinateInfo: CoordinateInfo = createCoordinateInfo({
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  });
  // Synthetic pointcloud descriptor. Federation (`useIfcFederation`)
  // folds `idOffset` into every entry's `expressId` and then calls
  // `relabelPointCloudAsset` on the renderer; without an entry here
  // streamed assets keep their local synthetic id and pick collisions
  // appear once a second model is added.
  const pointClouds: PointCloudAsset[] = [{
    expressId,
    ifcType: 'IfcGeographicElement',
    modelIndex: opts.modelIndex,
    chunk: {
      // Empty placeholder — actual point data is GPU-resident, never
      // re-uploaded from JS.
      positions: new Float32Array(0),
      pointCount: 0,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
    },
  }];
  const geometryResult: GeometryResult = {
    meshes: [],
    pointClouds,
    totalVertices: 0,
    totalTriangles: 0,
    coordinateInfo,
  };

  return {
    dataStore: emptyDataStore(opts.fileSize, expressId, opts.fileName),
    geometryResult,
    schemaVersion: 'IFC4',
    rendererHandle: handle,
    streamHandle: stream,
    done: stream.done,
  };
}

/**
 * Re-orient a Z-up chunk into the renderer's Y-up convention.
 *   Z-up: X=right, Y=forward, Z=up
 *   Y-up: X=right, Y=up,      Z=back   (negate Y to keep right-hand rule)
 *
 * Mirrors the geometry / pointcloud extractors' Z↔Y handling for IFCx.
 * Allocates a fresh positions buffer so the source chunk's typed array
 * (often a transferable from the worker) stays untouched.
 */
function swapZupChunkToYup(chunk: DecodedPointChunk): DecodedPointChunk {
  const src = chunk.positions;
  const positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i];
    const y = src[i + 1];
    const z = src[i + 2];
    positions[i] = x;
    positions[i + 1] = z;        // new Y = old Z
    positions[i + 2] = -y;       // new Z = -old Y
  }
  // BBox transforms the same way. New min/max derive from the swapped
  // axes; note the negation flips min and max on the Z-back axis.
  const oldMin = chunk.bbox.min;
  const oldMax = chunk.bbox.max;
  return {
    ...chunk,
    positions,
    bbox: {
      min: [oldMin[0], oldMin[2], -oldMax[1]],
      max: [oldMax[0], oldMax[2], -oldMin[1]],
    },
  };
}
