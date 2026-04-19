/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcParser, parseIfcx, type IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, GeometryQuality, type CoordinateInfo, type DynamicBatchConfig, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { loadGLBToMeshData } from '@ifc-lite/cache';
import type { SchemaVersion } from '../../store/types.js';
import { calculateMeshBounds, calculateStoreyHeights, createCoordinateInfo, normalizeColor } from '../../utils/localParsingUtils.js';

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
  if (meshes.length === 0 && ifcxResult.entityCount > 0) {
    throw new Error('overlay-only-ifcx');
  }

  const { bounds, stats } = calculateMeshBounds(meshes);
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
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC5',
  };
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
  const allMeshes: MeshData[] = [];
  const cumulativeColorUpdates = new Map<number, RgbaColor>();
  let finalCoordinateInfo: CoordinateInfo | null = null;
  let batchIndex = 0;
  let estimatedTotal = 0;
  let capturedRtcOffset: { x: number; y: number; z: number } | null = null;

  const dataStorePromise = parser.parseColumnar(options.buffer, {
    wasmApi,
    onSpatialReady: (partialStore) => {
      if (options.shouldAbort?.()) {
        return;
      }
      options.onSpatialReady?.(normalizeDataStoreStoreys(partialStore));
    },
  });

  for await (const event of geometryProcessor.processAdaptive(new Uint8Array(options.buffer), {
    sizeThreshold: 2 * 1024 * 1024,
    batchSize: options.getDynamicBatchSize(options.fileSizeMB),
    sharedRtcOffset: options.sharedRtcOffset,
  })) {
    if (options.shouldAbort?.()) {
      break;
    }
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

  const dataStore = normalizeDataStoreStoreys(await dataStorePromise);
  if (!finalCoordinateInfo) {
    finalCoordinateInfo = createCoordinateInfo(calculateMeshBounds(allMeshes).bounds);
  }
  if (capturedRtcOffset) {
    finalCoordinateInfo.wasmRtcOffset = capturedRtcOffset;
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
