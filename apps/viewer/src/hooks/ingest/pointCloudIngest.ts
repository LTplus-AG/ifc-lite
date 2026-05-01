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
  streamPointCloud,
  type DecodedPointChunk,
  type StreamHandle,
} from '@ifc-lite/pointcloud';
import type { CoordinateInfo, GeometryResult, PointCloudAsset } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { SchemaVersion } from '../../store/types.js';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';

export type PointCloudFormat = 'las' | 'laz' | 'ply' | 'pcd' | 'e57' | 'pts' | 'xyz';

/**
 * IfcTypeEnum.IfcGeographicElement — the closest IFC4 entity for a scan
 * is `IfcGeographicElement`. We hard-code the enum value (58) here so
 * we don't pull `@ifc-lite/data` into the viewer ingest path.
 */
const IFC_GEOGRAPHIC_ELEMENT_ENUM = 58;

/**
 * Synthetic IfcDataStore for a point-cloud-only model. Picking a point
 * sets the synthetic expressId as the selected entity, which then runs
 * through the regular property/hover/properties-panel pipeline. That
 * pipeline calls `entities.getTypeName / getName / getGlobalId` and
 * `properties.getForEntity` — without those methods, picking crashes
 * with "getTypeName is not a function". We give it just enough shape
 * to round-trip the single synthetic entity.
 */
function emptyDataStore(
  buffer: ArrayBuffer,
  expressId: number,
  fileName: string,
): IfcDataStore {
  const expressIds = new Uint32Array([expressId]);
  const empty32 = new Uint32Array(0);
  const empty8 = new Uint8Array(0);
  const emptyI32 = new Int32Array(0);
  const indexOf = (id: number) => (id === expressId ? 0 : -1);
  const entities = {
    count: 1,
    expressId: expressIds,
    typeEnum: new Uint16Array([IFC_GEOGRAPHIC_ELEMENT_ENUM]),
    globalId: empty32,
    name: empty32,
    description: empty32,
    objectType: empty32,
    flags: new Uint8Array([0]),
    containedInStorey: new Int32Array([-1]),
    definedByType: new Int32Array([-1]),
    geometryIndex: new Int32Array([-1]),
    typeRanges: new Map(),
    getGlobalId: (id: number) => (indexOf(id) >= 0 ? `pointcloud-${expressId}` : ''),
    getName: (id: number) => (indexOf(id) >= 0 ? fileName : ''),
    getDescription: () => '',
    getObjectType: () => '',
    getTypeName: (id: number) => (indexOf(id) >= 0 ? 'IfcGeographicElement' : 'Unknown'),
    hasGeometry: (id: number) => indexOf(id) >= 0,
    getByType: () => [expressId],
    getTypeEnum: (id: number) =>
      indexOf(id) >= 0 ? IFC_GEOGRAPHIC_ELEMENT_ENUM : 9999, // 9999 = Unknown
    getExpressIdByGlobalId: (gid: string) =>
      gid === `pointcloud-${expressId}` ? expressId : -1,
    getGlobalIdMap: () => new Map([[`pointcloud-${expressId}`, expressId]]),
  };
  const properties = {
    count: 0,
    entityId: empty32, psetName: empty32, psetGlobalId: empty32,
    propName: empty32, propType: empty8,
    valueString: empty32, valueReal: new Float64Array(0),
    valueInt: emptyI32, valueBool: empty8, unitId: emptyI32,
    entityIndex: new Map<number, number[]>(),
    psetIndex: new Map<number, number[]>(),
    propIndex: new Map<number, number[]>(),
    getForEntity: () => [],
    getPropertyValue: () => null,
    findByProperty: () => [],
  };
  const quantities = {
    count: 0,
    entityId: empty32, qsetName: empty32, qsetGlobalId: empty32,
    quantityName: empty32, quantityType: empty8,
    valueReal: new Float64Array(0), unitId: emptyI32,
    entityIndex: new Map<number, number[]>(),
    qsetIndex: new Map<number, number[]>(),
    getForEntity: () => [],
  };
  const relationships = {
    count: 0,
    relType: empty8, relatingId: empty32, relatedId: empty32,
    byRelating: new Map<number, number[]>(),
    byRelated: new Map<number, number[]>(),
    getOutgoing: () => [],
    getIncoming: () => [],
    getRelated: () => [],
    getRelating: () => [],
  };
  const byId = new Map<number, unknown>([[expressId, { expressId }]]);
  return {
    fileSize: buffer.byteLength,
    schemaVersion: 'IFC4' as const,
    entityCount: 1,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: {
      byId: byId as unknown as IfcDataStore['entityIndex']['byId'],
      byType: new Map([['IFCGEOGRAPHICELEMENT', [expressId]]]),
    },
    strings: {
      get: () => '',
      getId: () => 0,
      count: 0,
    } as unknown as IfcDataStore['strings'],
    entities: entities as unknown as IfcDataStore['entities'],
    properties: properties as unknown as IfcDataStore['properties'],
    quantities: quantities as unknown as IfcDataStore['quantities'],
    relationships: relationships as unknown as IfcDataStore['relationships'],
    spatialHierarchy: undefined,
  } as unknown as IfcDataStore;
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
  buffer: ArrayBuffer;
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
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.las')) return 'las';
  if (lower.endsWith('.laz')) return 'laz';
  if (lower.endsWith('.ply')) return 'ply';
  if (lower.endsWith('.pcd')) return 'pcd';
  if (lower.endsWith('.e57')) return 'e57';
  if (lower.endsWith('.pts')) return 'pts';
  if (lower.endsWith('.xyz')) return 'xyz';
  if (buffer && buffer.byteLength >= 8) {
    const view = new DataView(buffer, 0, Math.min(buffer.byteLength, 32));
    if (view.getUint32(0, true) === 0x4653414c) return 'las';
    // ASCII probe — first three bytes "ply" → PLY; "# .P" or ".PCD" → PCD.
    const b0 = view.getUint8(0), b1 = view.getUint8(1), b2 = view.getUint8(2);
    if (b0 === 0x70 /* p */ && b1 === 0x6c /* l */ && b2 === 0x79 /* y */) return 'ply';
    if (b0 === 0x23 /* # */ && view.byteLength > 4 && view.getUint8(2) === 0x2e /* . */) return 'pcd';
    // E57 magic = "ASTM-E57" (8 bytes)
    if (
      view.getUint8(0) === 0x41 && view.getUint8(1) === 0x53
      && view.getUint8(2) === 0x54 && view.getUint8(3) === 0x4d
      && view.getUint8(4) === 0x2d && view.getUint8(5) === 0x45
      && view.getUint8(6) === 0x35 && view.getUint8(7) === 0x37
    ) return 'e57';
  }
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
        // LAS / LAZ / E57 / typical scan-style PLY + PCD all store data
        // Z-up by convention (LIDAR / surveying tradition). The renderer
        // is Y-up internally — the IFCx ingest path applies the same
        // swap inside `pointcloud-extractor.ts`. Without this, the scan
        // shows up rotated 90° onto its side.
        const yUp = swapZupChunkToYup(chunk);
        opts.renderer.appendPointCloudChunk(handle, yUp);
        opts.renderer.requestRender();
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
        opts.onProgress?.({ phase: 'Streaming complete', percent: 100 });
      },
      onError: () => {
        opts.renderer.removePointCloudAsset(handle);
        onCountChange(-1);
      },
    });
  } catch (err) {
    opts.renderer.removePointCloudAsset(handle);
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
    dataStore: emptyDataStore(opts.buffer, expressId, opts.fileName),
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
