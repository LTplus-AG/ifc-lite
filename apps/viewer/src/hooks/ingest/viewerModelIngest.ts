/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseIfcx, createSyntheticDataStore, attachDataStoreAccessors, type IfcDataStore, type IfcStoreData, type PointCloudExtraction } from '@ifc-lite/parser';
import { type GeometryResult, type MeshData, type PointCloudAsset } from '@ifc-lite/geometry';
import { loadGLBToMeshData } from '@ifc-lite/cache';
import type { SchemaVersion } from '../../store/types.js';
import { calculateMeshBounds, createCoordinateInfo, normalizeColor } from '../../utils/localParsingUtils.js';

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

/**
 * The slice of an IFCX parse result the data store is built from. `spatialHierarchy`
 * is only carried into the store (never read here), so it is optional — which keeps
 * the regression test from having to fabricate a full hierarchy.
 */
type IfcxParse = Awaited<ReturnType<typeof parseIfcx>>;
type IfcxStoreInput = Pick<
  IfcxParse,
  'fileSize' | 'entityCount' | 'parseTime' | 'strings' | 'entities' | 'properties' | 'quantities' | 'relationships'
> & { spatialHierarchy?: IfcxParse['spatialHierarchy'] };

/**
 * Build the `IfcDataStore` for an IFCX import. Exported for regression coverage of
 * the selection-time accessor path (see viewerModelIngest.test.ts).
 *
 * IFCX carries real data tables, so unlike the GLB path we can't route through
 * `createSyntheticDataStore` (it builds empty tables) — we attach the accessors to
 * the populated store instead. Without this, selecting an entity in an IFCX-imported
 * model threw "this.store.getQuantities is not a function".
 *
 * `attachDataStoreAccessors` then wires `getEntity`/`getEntitiesByType` through the
 * STEP `BufferEntitySource`, which cannot read an IFCX store (the source is IFCX JSON
 * and the byte index is empty) and would return null/[] for every entity. We override
 * both to serve the `IfcEntity` contract from the populated IFCX entity table. (Raw
 * STEP attribute lists don't exist for IFCX, so `attributes` is empty — identity rides
 * `type`, and name/GlobalId come from the entity table via the store's other accessors.)
 */
export function buildIfcxDataStore(ifcxResult: IfcxStoreInput, buffer: ArrayBuffer): IfcDataStore {
  const dataStore = attachDataStoreAccessors({
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
  } as unknown as IfcStoreData);

  const entityTable = ifcxResult.entities;
  const idsByType = new Map<string, number[]>();
  const knownIds = new Set<number>();
  for (const id of entityTable.expressId) {
    if (!id) continue;
    knownIds.add(id);
    const key = entityTable.getTypeName(id).toUpperCase();
    const bucket = idsByType.get(key);
    if (bucket) bucket.push(id);
    else idsByType.set(key, [id]);
  }
  dataStore.getEntity = (expressId) =>
    knownIds.has(expressId)
      ? { expressId, type: entityTable.getTypeName(expressId), attributes: [] }
      : null;
  dataStore.getEntitiesByType = (typeName) =>
    (idsByType.get(typeName.toUpperCase()) ?? []).map((expressId) => ({
      expressId,
      type: entityTable.getTypeName(expressId),
      attributes: [],
    }));

  return dataStore;
}

export async function parseIfcxViewerModel(
  buffer: ArrayBuffer,
  onProgress?: (progress: { phase: string; percent: number }) => void,
  opts?: ParseIfcxOptions,
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
