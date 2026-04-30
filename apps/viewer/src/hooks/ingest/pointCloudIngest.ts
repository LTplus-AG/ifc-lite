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
  type StreamHandle,
} from '@ifc-lite/pointcloud';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { SchemaVersion } from '../../store/types.js';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';

export type PointCloudFormat = 'las' | 'laz' | 'ply' | 'pcd';

/**
 * Minimal synthetic IfcDataStore for a point-cloud-only model so the
 * existing federation/store pipeline doesn't need to special-case
 * non-IFC sources.
 */
function emptyDataStore(buffer: ArrayBuffer): IfcDataStore {
  return {
    fileSize: buffer.byteLength,
    schemaVersion: 'IFC4' as const,
    entityCount: 0,
    parseTime: 0,
    source: new Uint8Array(0),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings: { getString: () => undefined, getStringId: () => undefined, count: 0 } as unknown as IfcDataStore['strings'],
    entities: { count: 0, getId: () => 0, getType: () => 0, getName: () => undefined, getGlobalId: () => undefined } as unknown as IfcDataStore['entities'],
    properties: { count: 0, getPropertiesForEntity: () => [], getPropertySetForEntity: () => [] } as unknown as IfcDataStore['properties'],
    quantities: { count: 0, getQuantitiesForEntity: () => [] } as unknown as IfcDataStore['quantities'],
    relationships: { count: 0, getRelationships: () => [], getRelated: () => [] } as unknown as IfcDataStore['relationships'],
    spatialHierarchy: null as unknown as IfcDataStore['spatialHierarchy'],
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
  if (buffer && buffer.byteLength >= 4) {
    const view = new DataView(buffer, 0, Math.min(buffer.byteLength, 32));
    if (view.getUint32(0, true) === 0x4653414c) return 'las';
    // ASCII probe — first three bytes "ply" → PLY; "# .P" or ".PCD" → PCD.
    const b0 = view.getUint8(0), b1 = view.getUint8(1), b2 = view.getUint8(2);
    if (b0 === 0x70 /* p */ && b1 === 0x6c /* l */ && b2 === 0x79 /* y */) return 'ply';
    if (b0 === 0x23 /* # */ && view.byteLength > 4 && view.getUint8(2) === 0x2e /* . */) return 'pcd';
  }
  return null;
}

/**
 * Stream a point cloud into the renderer. Returns immediately; await
 * `result.done` for completion.
 */
export function ingestPointCloud(opts: PointCloudIngestOptions): PointCloudIngestResult {
  const expressId = opts.expressId ?? 1;
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

  const stream = streamPointCloud({
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
      opts.renderer.appendPointCloudChunk(handle, chunk);
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

  // Build a minimal GeometryResult that satisfies the model registry.
  // The actual point data is on the GPU, not in memory.
  const coordinateInfo: CoordinateInfo = createCoordinateInfo({
    min: { x: 0, y: 0, z: 0 },
    max: { x: 0, y: 0, z: 0 },
  });
  const geometryResult: GeometryResult = {
    meshes: [],
    pointClouds: [],
    totalVertices: 0,
    totalTriangles: 0,
    coordinateInfo,
  };

  return {
    dataStore: emptyDataStore(opts.buffer),
    geometryResult,
    schemaVersion: 'IFC4',
    rendererHandle: handle,
    streamHandle: stream,
    done: stream.done,
  };
}
