/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser, parseIfcx, type IfcDataStore, type PointCloudExtraction } from '@ifc-lite/parser';
import { WorkerParser } from '@ifc-lite/parser/browser';
import { GeometryProcessor, GeometryQuality, getGeometryStreamWatchdogMs, type CoordinateInfo, type DynamicBatchConfig, type GeometryResult, type MeshData, type PointCloudAsset } from '@ifc-lite/geometry';
import { loadGLBToMeshData } from '@ifc-lite/cache';
import type { SchemaVersion } from '../../store/types.js';
import { calculateMeshBounds, calculateStoreyHeights, createCoordinateInfo, normalizeColor } from '../../utils/localParsingUtils.js';
import { resolveDataStoreOrAbort } from './resolveDataStoreOrAbort.js';

type RgbaColor = [number, number, number, number];

interface RawIfcxMesh {
  expressId?: number;
  express_id?: number;
  id?: number;
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
  normals: Float32Array | number[];
  color?: [number, number, number, number] | [number, number, number];
  ifcType?: string;
  ifc_type?: string;
}

export interface ViewerModelPayload {
  dataStore: IfcDataStore;
  geometryResult: GeometryResult;
  schemaVersion: SchemaVersion;
}

export interface StepBatchEvent {
  batchIndex: number;
  estimatedTotal: number;
  totalSoFar: number;
  meshes: MeshData[];
  coordinateInfo?: CoordinateInfo | null;
}

export interface StepRtcOffsetEvent {
  rtcOffset: { x: number; y: number; z: number };
}

export interface StepBufferIngestOptions {
  fileName: string;
  buffer: ArrayBuffer;
  fileSizeMB: number;
  getDynamicBatchSize: (fileSizeMB: number) => number | DynamicBatchConfig;
  onProgress?: (progress: { phase: string; percent: number }) => void;
  onBatch?: (event: StepBatchEvent) => void;
  onColorUpdate?: (updates: Map<number, RgbaColor>) => void;
  onSpatialReady?: (dataStore: IfcDataStore) => void;
  onRtcOffset?: (event: StepRtcOffsetEvent) => void;
  shouldAbort?: () => boolean;
  /** Shared RTC offset from first federated model (IFC Z-up coords).
   *  When set, this model uses the same RTC as the first model instead of
   *  computing its own, ensuring all models share the same coordinate space. */
  sharedRtcOffset?: { x: number; y: number; z: number };
}

export interface StepBufferIngestResult extends ViewerModelPayload {
  allMeshes: MeshData[];
  cumulativeColorUpdates: Map<number, RgbaColor>;
}

export function convertIfcxMeshes(rawMeshes: RawIfcxMesh[]): MeshData[] {
  return rawMeshes.map((mesh) => {
    const positions = mesh.positions instanceof Float32Array ? mesh.positions : new Float32Array(mesh.positions || []);
    const indices = mesh.indices instanceof Uint32Array ? mesh.indices : new Uint32Array(mesh.indices || []);
    const normals = mesh.normals instanceof Float32Array ? mesh.normals : new Float32Array(mesh.normals || []);

    return {
      expressId: mesh.expressId ?? mesh.express_id ?? mesh.id ?? 0,
      positions,
      indices,
      normals,
      color: normalizeColor(mesh.color),
      ifcType: mesh.ifcType ?? mesh.ifc_type ?? 'IfcProduct',
    };
  }).filter((mesh) => mesh.positions.length > 0 && mesh.indices.length > 0);
}

export function createMinimalGlbDataStore(buffer: ArrayBuffer, meshCount: number): IfcDataStore {
  return {
    fileSize: buffer.byteLength,
    schemaVersion: 'IFC4' as const,
    entityCount: meshCount,
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

export function normalizeDataStoreStoreys(dataStore: IfcDataStore): IfcDataStore {
  if (dataStore.spatialHierarchy && dataStore.spatialHierarchy.storeyHeights.size === 0 && dataStore.spatialHierarchy.storeyElevations.size > 1) {
    const calculatedHeights = calculateStoreyHeights(dataStore.spatialHierarchy.storeyElevations);
    for (const [storeyId, height] of calculatedHeights) {
      dataStore.spatialHierarchy.storeyHeights.set(storeyId, height);
    }
  }
  return dataStore;
}

/** Only recenter models whose bounds center is at least this far (metres) from
 *  the origin — i.e. the WASM RTC failed to bring them near origin. */
const RECENTER_FAR_THRESHOLD_M = 1000;
/** Remove the offset rounded to this grid (metres), so the model's LOCAL layout
 *  is preserved and models that differ only by a large round survey offset
 *  (the common georef case) snap to the same frame instead of overlapping
 *  half-way. */
const RECENTER_ROUND_M = 1000;

/**
 * Fallback world-origin recenter for geometry the WASM RTC pass left far from
 * the origin. ARC-style models that place all geometry via `IfcMappedItem`
 * carry their site/survey offset in the mapping transform, which the RTC
 * sampler (`detect_rtc_offset_from_jobs`) never inspects — so the model renders
 * ~20 km off and, in a federation, sits nowhere near the other models.
 *
 * Operates on the FINAL meshes (ground truth, post every transform): if the
 * bounds center is beyond the threshold on any axis, subtract the large rounded
 * offset from every vertex IN PLACE and fold it into `coordinateInfo`
 * (shiftedBounds + originShift) so the camera, picking, and georef stay
 * consistent. Returns the applied offset, or null when nothing was shifted.
 */
export function recenterFarGeometry(
  meshes: MeshData[],
  coordinateInfo: CoordinateInfo,
): { x: number; y: number; z: number } | null {
  if (meshes.length === 0) return null;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const m of meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z;
      if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
    }
  }
  if (!Number.isFinite(mnx) || !Number.isFinite(mxx)) return null;
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2, cz = (mnz + mxz) / 2;
  const round = (c: number) =>
    Math.abs(c) > RECENTER_FAR_THRESHOLD_M ? Math.round(c / RECENTER_ROUND_M) * RECENTER_ROUND_M : 0;
  const ox = round(cx), oy = round(cy), oz = round(cz);
  if (ox === 0 && oy === 0 && oz === 0) return null;

  for (const m of meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      p[i] -= ox; p[i + 1] -= oy; p[i + 2] -= oz;
    }
  }
  const shiftBounds = (b?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) =>
    b
      ? {
          min: { x: b.min.x - ox, y: b.min.y - oy, z: b.min.z - oz },
          max: { x: b.max.x - ox, y: b.max.y - oy, z: b.max.z - oz },
        }
      : b;
  if (coordinateInfo.shiftedBounds) coordinateInfo.shiftedBounds = shiftBounds(coordinateInfo.shiftedBounds)!;
  const os = coordinateInfo.originShift ?? { x: 0, y: 0, z: 0 };
  coordinateInfo.originShift = { x: os.x + ox, y: os.y + oy, z: os.z + oz };
  return { x: ox, y: oy, z: oz };
}

export function getMaxExpressId(dataStore: IfcDataStore, meshes: MeshData[]): number {
  const maxExpressIdFromMeshes = meshes.reduce((max, mesh) => Math.max(max, mesh.expressId), 0);
  let maxExpressIdFromEntities = 0;
  if (dataStore.entityIndex?.byId) {
    for (const key of dataStore.entityIndex.byId.keys()) {
      if (key > maxExpressIdFromEntities) {
        maxExpressIdFromEntities = key;
      }
    }
  }
  return Math.max(maxExpressIdFromMeshes, maxExpressIdFromEntities);
}

export async function parseIfcxViewerModel(
  buffer: ArrayBuffer,
  onProgress?: (progress: { phase: string; percent: number }) => void,
): Promise<ViewerModelPayload> {
  const ifcxResult = await parseIfcx(buffer, {
    onProgress: (progress) => {
      onProgress?.({
        phase: `IFCX ${progress.phase}`,
        percent: 10 + (progress.percent * 0.8),
      });
    },
  });

  const meshes = convertIfcxMeshes(ifcxResult.meshes);
  const pointClouds = convertIfcxPointClouds(ifcxResult.pointClouds ?? []);
  // Treat as overlay-only ONLY when neither meshes nor pointclouds were extracted.
  // Files that carry just point cloud assets (the buildingSMART Point_Cloud
  // samples) still represent a renderable model on their own.
  if (meshes.length === 0 && pointClouds.length === 0 && ifcxResult.entityCount > 0) {
    throw new Error('overlay-only-ifcx');
  }

  const { bounds, stats } = calculateMeshBounds(meshes);
  // Expand bounds to include point cloud asset extents so fit-to-view, the
  // section-plane slider, and camera near/far all see the points too.
  for (const pc of pointClouds) {
    const { min, max } = pc.chunk.bbox;
    bounds.min.x = Math.min(bounds.min.x, min[0]);
    bounds.min.y = Math.min(bounds.min.y, min[1]);
    bounds.min.z = Math.min(bounds.min.z, min[2]);
    bounds.max.x = Math.max(bounds.max.x, max[0]);
    bounds.max.y = Math.max(bounds.max.y, max[1]);
    bounds.max.z = Math.max(bounds.max.z, max[2]);
  }
  return {
    dataStore: {
      fileSize: ifcxResult.fileSize,
      schemaVersion: 'IFC5' as const,
      entityCount: ifcxResult.entityCount,
      parseTime: ifcxResult.parseTime,
      source: new Uint8Array(buffer),
      entityIndex: { byId: new Map(), byType: new Map() },
      strings: ifcxResult.strings,
      entities: ifcxResult.entities,
      properties: ifcxResult.properties,
      quantities: ifcxResult.quantities,
      relationships: ifcxResult.relationships,
      spatialHierarchy: ifcxResult.spatialHierarchy,
    } as unknown as IfcDataStore,
    geometryResult: {
      meshes,
      pointClouds,
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC5',
  };
}

export function convertIfcxPointClouds(extractions: PointCloudExtraction[]): PointCloudAsset[] {
  return extractions.map((pc) => ({
    expressId: pc.expressId,
    ifcType: pc.ifcType,
    chunk: {
      positions: pc.positions,
      colors: pc.colors,
      pointCount: pc.pointCount,
      bbox: pc.bbox,
    },
  }));
}

export async function parseGlbViewerModel(buffer: ArrayBuffer): Promise<ViewerModelPayload> {
  const meshes = loadGLBToMeshData(new Uint8Array(buffer));
  if (meshes.length === 0) {
    throw new Error('glb-empty');
  }

  const { bounds, stats } = calculateMeshBounds(meshes);
  return {
    dataStore: createMinimalGlbDataStore(buffer, meshes.length),
    geometryResult: {
      meshes,
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC4',
  };
}

export async function parseStepBufferViewerModel(options: StepBufferIngestOptions): Promise<StepBufferIngestResult> {
  const geometryProcessor = new GeometryProcessor({ quality: GeometryQuality.Balanced });
  await geometryProcessor.init();

  const parser = new IfcParser();
  const wasmApi = geometryProcessor.getApi();
  const canShareSource = WorkerParser.isSupported();
  const sharedSource = canShareSource ? new SharedArrayBuffer(options.buffer.byteLength) : null;
  if (sharedSource) {
    new Uint8Array(sharedSource).set(new Uint8Array(options.buffer));
  }
  const geometryWillEmitEntityIndex =
    sharedSource !== null
    && options.fileSizeMB >= 2
    && typeof Worker !== 'undefined'
    && typeof navigator !== 'undefined'
    && (navigator.hardwareConcurrency ?? 1) > 1;
  let workerParser: WorkerParser | null = null;
  const allMeshes: MeshData[] = [];
  const cumulativeColorUpdates = new Map<number, RgbaColor>();
  let finalCoordinateInfo: CoordinateInfo | null = null;
  let batchIndex = 0;
  let estimatedTotal = 0;
  let capturedRtcOffset: { x: number; y: number; z: number } | null = null;

  const handleSpatialReady = (partialStore: IfcDataStore) => {
    if (options.shouldAbort?.()) {
      return;
    }
    options.onSpatialReady?.(normalizeDataStoreStoreys(partialStore));
  };
  const dataStorePromise = sharedSource
    ? (() => {
        workerParser = new WorkerParser();
        return workerParser.parseColumnar(sharedSource, {
          waitForEntityIndex: geometryWillEmitEntityIndex,
          onSpatialReady: handleSpatialReady,
        }).catch((error) => {
          console.warn('[viewerModelIngest] Parser worker failed, falling back to main-thread parse:', error);
          return parser.parseColumnar(options.buffer, {
            wasmApi: wasmApi ?? undefined,
            onSpatialReady: handleSpatialReady,
          });
        });
      })()
    : parser.parseColumnar(options.buffer, {
        wasmApi: wasmApi ?? undefined,
        onSpatialReady: handleSpatialReady,
      });

  const geometryView = sharedSource ? new Uint8Array(sharedSource) : new Uint8Array(options.buffer);
  // Drive the geometry stream through a manual iterator guarded by a
  // size-aware watchdog. The parallel pipeline only ends once EVERY spawned
  // geometry worker reports `complete`; if the browser fails to instantiate a
  // worker (the "Attempting to create a Worker from an empty source" warning),
  // that worker never reports `ready`, never `complete`, and never fires
  // `onerror`, so the generator can wedge forever — leaving this loop stuck on
  // "Processing geometry (N meshes)". The single-model loader (useIfcLoader)
  // already wraps its stream in this same watchdog; the federated/added-model
  // path was missing it and would hang indefinitely instead of surfacing a
  // recoverable error. (See watchdog.ts for the size-aware deadline.)
  const geometryIterator = geometryProcessor.processAdaptive(geometryView, {
    sizeThreshold: 2 * 1024 * 1024,
    batchSize: options.getDynamicBatchSize(options.fileSizeMB),
    sharedRtcOffset: options.sharedRtcOffset,
    existingSab: sharedSource ?? undefined,
    onEntityIndex: (ids, starts, lengths) => {
      workerParser?.setEntityIndex(ids, starts, lengths);
    },
  })[Symbol.asyncIterator]();
  let lastTotalMeshes = 0;
  try {
    while (true) {
      const watchdogMs = getGeometryStreamWatchdogMs({
        desktopStableWasm: false,
        batchCount: batchIndex,
        fileSizeMB: options.fileSizeMB,
      });
      let watchdogId: ReturnType<typeof setTimeout> | null = null;
      const nextResult = await Promise.race([
        geometryIterator.next(),
        new Promise<never>((_, reject) => {
          watchdogId = setTimeout(() => {
            reject(new Error(
              `Geometry stream stalled after ${watchdogMs}ms while loading ${options.fileName}. `
              + `Last rendered meshes: ${lastTotalMeshes}. A geometry worker likely failed to start.`,
            ));
          }, watchdogMs);
        }),
      ]);
      if (watchdogId !== null) {
        clearTimeout(watchdogId);
      }
      if (nextResult.done) {
        break;
      }
      if (options.shouldAbort?.()) {
        break;
      }
      const event = nextResult.value;
      switch (event.type) {
        case 'start':
          estimatedTotal = event.totalEstimate;
          break;
        case 'colorUpdate':
          for (const [expressId, color] of event.updates) {
            cumulativeColorUpdates.set(expressId, color);
          }
          options.onColorUpdate?.(event.updates);
          break;
        case 'rtcOffset':
          if (event.hasRtc) {
            capturedRtcOffset = event.rtcOffset;
            options.onRtcOffset?.({ rtcOffset: event.rtcOffset });
          }
          break;
        case 'batch':
          batchIndex += 1;
          for (let i = 0; i < event.meshes.length; i++) {
            allMeshes.push(event.meshes[i]);
          }
          finalCoordinateInfo = event.coordinateInfo ?? null;
          lastTotalMeshes = event.totalSoFar;
          options.onBatch?.({
            batchIndex,
            estimatedTotal,
            totalSoFar: event.totalSoFar,
            meshes: event.meshes,
            coordinateInfo: event.coordinateInfo ?? null,
          });
          options.onProgress?.({
            phase: `Processing geometry (${event.totalSoFar} meshes)`,
            percent: 10 + Math.min(80, (allMeshes.length / 1000) * 0.8),
          });
          break;
        case 'complete':
          finalCoordinateInfo = event.coordinateInfo ?? null;
          break;
      }
    }
  } catch (err) {
    // Watchdog stall (or other stream error): the parser worker may be
    // blocked in `waitForEntityIndex`, which only the geometry pre-pass would
    // unblock. Terminate it here so it doesn't leak — the normal path below
    // still awaits it via resolveDataStoreOrAbort.
    workerParser?.terminate();
    throw err;
  } finally {
    // Abandon the generator on early break / watchdog throw so the geometry
    // workers and pre-pass worker are torn down rather than left running.
    if (typeof geometryIterator.return === 'function') {
      try {
        await geometryIterator.return(undefined);
      } catch {
        // Iterator shutdown failures during recovery are non-fatal.
      }
    }
  }

  // If the load was cancelled, don't await dataStorePromise: a worker parse
  // started with waitForEntityIndex blocks until the geometry pre-pass hands
  // over the entity index, which never happens once the geometry loop has been
  // aborted above. resolveDataStoreOrAbort terminates the worker and throws an
  // AbortError instead of hanging here.
  const dataStore = normalizeDataStoreStoreys(
    await resolveDataStoreOrAbort(dataStorePromise, {
      aborted: options.shouldAbort?.() ?? false,
      terminate: () => workerParser?.terminate(),
    }),
  );
  if (!finalCoordinateInfo) {
    finalCoordinateInfo = createCoordinateInfo(calculateMeshBounds(allMeshes).bounds);
  }
  if (capturedRtcOffset) {
    finalCoordinateInfo.wasmRtcOffset = capturedRtcOffset;
  }
  // Fallback: bring geometry the WASM RTC pass left far from origin (e.g.
  // IfcMappedItem-placed models like the BIMcollab ARC sample, ~20 km off)
  // back to a shared origin so it co-locates with the other federated models.
  const recenter = recenterFarGeometry(allMeshes, finalCoordinateInfo);
  if (recenter) {
    console.log(`[viewerModelIngest] recentered far geometry for ${options.fileName} by (${recenter.x},${recenter.y},${recenter.z})`);
  }

  return {
    dataStore,
    geometryResult: {
      meshes: allMeshes,
      totalVertices: allMeshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0),
      totalTriangles: allMeshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
      coordinateInfo: finalCoordinateInfo,
    },
    schemaVersion: dataStore.schemaVersion === 'IFC4X3'
      ? 'IFC4X3'
      : dataStore.schemaVersion === 'IFC4'
        ? 'IFC4'
        : 'IFC2X3',
    allMeshes,
    cumulativeColorUpdates,
  };
}
