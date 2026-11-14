/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { highestExistingExpressId } from '@ifc-lite/mutations';
import type { parseIfcx as ParseIfcx } from '@ifc-lite/ifcx';
import { IFCX_LENGTH_UNIT_SCALE, createSyntheticDataStore, type IfcDataStore, type PointCloudExtraction } from '@ifc-lite/parser';
import { type GeometryResult, type MeshData, type PointCloudAsset } from '@ifc-lite/geometry';
import { parseGLB, parseGLBToMeshData, parseGLBImageResources } from '@ifc-lite/cache';
import type { SchemaVersion } from '../../store/types.js';
import { calculateMeshBounds, createCoordinateInfo, normalizeColor } from '../../utils/localParsingUtils.js';
import { buildTabularDataStore } from './tabularDataStore.js';

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
  uvs?: Float32Array;
  texture?: MeshData['texture'];
}

export interface ViewerModelPayload {
  dataStore: IfcDataStore;
  geometryResult: GeometryResult;
  schemaVersion: SchemaVersion;
  /** Encoded GLB base-colour images, retained through the canonical load owner. */
  originalResources?: Map<string, Uint8Array>;
  /** IFCX path ↔ expressId maps (only present for IFCX-parsed models). */
  pathToId?: Map<string, number>;
  idToPath?: Map<number, string>;
}

export interface ParseIfcxOptions {
  /**
   * Allow reconstructing a model from IFCX that carries entities but no inline
   * geometry (used by collab recipients, whose geometry arrives via blobs).
   * Without this, geometry-less IFCX throws `overlay-only-ifcx`.
   */
  allowEmptyGeometry?: boolean;
}

export function getViewerSchemaVersion(dataStore: IfcDataStore | null): SchemaVersion {
  if (!dataStore) return 'IFC4';
  if (dataStore.schemaVersion === 'IFC4X3') return 'IFC4X3';
  if (dataStore.schemaVersion === 'IFC4') return 'IFC4';
  if (dataStore.schemaVersion === 'IFC5') return 'IFC5';
  return 'IFC2X3';
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
      uvs: mesh.uvs,
      texture: mesh.texture,
      color: normalizeColor(mesh.color),
      ifcType: mesh.ifcType ?? mesh.ifc_type ?? 'IfcProduct',
    };
  }).filter((mesh) => mesh.positions.length > 0 && mesh.indices.length > 0);
}

export function createMinimalGlbDataStore(buffer: ArrayBuffer, meshCount: number): IfcDataStore {
  // A GLB carries renderable meshes but no IFC entities. Build a typed,
  // entity-less store via the shared factory so the full `IfcDataStore`
  // contract (including the lazy `getEntity` / `getProperties` accessors the
  // query path calls) is compiler-enforced instead of cast away (#1004).
  return createSyntheticDataStore({
    schemaVersion: 'IFC4',
    fileSize: buffer.byteLength,
    entityCount: meshCount,
  });
}

export function getMaxExpressId(
  dataStore: IfcDataStore | null,
  meshes: MeshData[],
  pointClouds: readonly Pick<PointCloudAsset, 'expressId'>[] = [],
): number {
  const maxExpressIdFromMeshes = meshes.reduce((max, mesh) => Math.max(max, mesh.expressId), 0);
  const index = dataStore?.entityIndex.byId;
  // Compact indexes already maintain the source maximum; only deferred atoms lie outside it.
  const compactMax = index && 'maxExpressId' in index ? index.maxExpressId : undefined;
  let maxExpressIdFromEntities = typeof compactMax === 'number' ? compactMax
    : dataStore ? highestExistingExpressId(dataStore) : 0;
  if (typeof compactMax === 'number' && dataStore?.deferredEntityIndex) {
    for (const id of dataStore.deferredEntityIndex.keys()) maxExpressIdFromEntities = Math.max(maxExpressIdFromEntities, id);
  }
  const maxExpressIdFromPoints = pointClouds.reduce((max, asset) => Math.max(max, asset.expressId), 0);
  return Math.max(maxExpressIdFromMeshes, maxExpressIdFromEntities, maxExpressIdFromPoints);
}

/**
 * The slice of an IFCX parse result the data store is built from. `spatialHierarchy`
 * is only carried into the store (never read here), so it is optional — which keeps
 * the regression test from having to fabricate a full hierarchy.
 */
type IfcxParse = Awaited<ReturnType<typeof ParseIfcx>>;
type IfcxStoreInput = Pick<
  IfcxParse,
  'fileSize' | 'parseTime' | 'strings' | 'entities' | 'properties' | 'quantities' | 'relationships' | 'georeferencing'
> & { spatialHierarchy?: IfcxParse['spatialHierarchy']; derivedEntities?: IfcxParse['derivedEntities'] };

/**
 * Build the `IfcDataStore` for an IFCX import. Exported for regression coverage of
 * the selection-time accessor path (see viewerModelIngest.test.ts).
 *
 * The store itself is `buildTabularDataStore`'s; this names what IFCX states
 * about its file.
 */
export function buildIfcxDataStore(ifcxResult: IfcxStoreInput, buffer: ArrayBuffer): IfcDataStore {
  const georef = ifcxResult.georeferencing;
  return buildTabularDataStore(ifcxResult, {
    schemaVersion: 'IFC5',
    source: buffer,
    fileSize: ifcxResult.fileSize,
    parseTime: ifcxResult.parseTime,
    // IFCX has no IfcUnitAssignment to read: the format's unit, assumed (nothing in the file declares it).
    lengthUnitScale: IFCX_LENGTH_UNIT_SCALE,
    lengthUnitSource: 'default',
    georeferencing: georef ? {
      hasGeoreference: true, source: 'mapConversion',
      projectedCRS: { id: 0, name: georef.IfcProjectedCRS.Name, mapUnit: 'METRE', mapUnitScale: 1 },
      mapConversion: { id: 0, sourceCRS: 0, targetCRS: 0,
        eastings: georef.IfcMapConversion.Eastings,
        northings: georef.IfcMapConversion.Northings,
        orthogonalHeight: georef.IfcMapConversion.OrthogonalHeight,
        xAxisAbscissa: georef.IfcMapConversion.XAxisAbscissa,
        xAxisOrdinate: georef.IfcMapConversion.XAxisOrdinate,
        scale: georef.IfcMapConversion.Scale,
      },
    } : undefined,
  });
}

export async function parseIfcxViewerModel(
  buffer: ArrayBuffer,
  onProgress?: (progress: { phase: string; percent: number }) => void,
  opts?: ParseIfcxOptions,
): Promise<ViewerModelPayload> {
  // Dynamic: the IFCX parser carries the generated imported-geometry kernel
  // (~600 KB). Importing it on demand keeps it out of the eager startup chunks.
  const { parseIfcx } = await import('@ifc-lite/ifcx');
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
  if (
    !opts?.allowEmptyGeometry &&
    meshes.length === 0 &&
    pointClouds.length === 0 &&
    ifcxResult.entityCount > 0
  ) {
    throw new Error('overlay-only-ifcx');
  }

  const { bounds, stats } = calculateMeshBounds(meshes);
  // Empty geometry (e.g. a collab recipient reconstructing before blob hydration
  // with `allowEmptyGeometry`): calculateMeshBounds returns ±Infinity sentinels,
  // which make coordinateInfo invalid. Collapse to a zero box; real bounds arrive
  // once meshes hydrate.
  if (meshes.length === 0 && pointClouds.length === 0) {
    bounds.min = { x: 0, y: 0, z: 0 };
    bounds.max = { x: 0, y: 0, z: 0 };
  }
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
    dataStore: buildIfcxDataStore(ifcxResult, buffer),
    geometryResult: {
      meshes,
      pointClouds,
      totalVertices: stats.totalVertices,
      totalTriangles: stats.totalTriangles,
      coordinateInfo: createCoordinateInfo(bounds),
    },
    schemaVersion: 'IFC5',
    pathToId: ifcxResult.pathToId,
    idToPath: ifcxResult.idToPath,
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
  const { json, bin } = parseGLB(new Uint8Array(buffer));
  if (!bin) throw new Error('GLB has no binary buffer');
  const meshes = parseGLBToMeshData(json, bin);
  const originalResources = parseGLBImageResources(json, bin);
  if (meshes.length === 0) {
    throw new Error('glb-empty');
  }

  const { bounds, stats } = calculateMeshBounds(meshes);
  return {
    originalResources,
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
