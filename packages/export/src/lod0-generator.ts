/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  EntityExtractor,
  extractLengthUnitScale,
  getAllAttributesForEntity,
  scanIfcEntities,
} from '@ifc-lite/parser';

import type { EntityRef } from '@ifc-lite/parser';
import type { Lod0Json, Lod0Element, LodInput, Vec3 } from './lod-geometry-types.js';
import {
  aabbFromPoints,
  mat4FromBasisTranslation,
  mat4Identity,
  mat4Mul,
  mat4TransformPoint,
  normalizeIfcTypeName,
  vec3,
  vec3Cross,
  vec3Normalize,
  toIfcArrayBuffer,
} from './lod-geometry-utils.js';

type Index = { byId: Map<number, EntityRef>; byType: Map<string, number[]> };

function buildEntityIndex(entityRefs: EntityRef[]): Index {
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  for (const ref of entityRefs) {
    const t = String(ref.type || '').toUpperCase();
    const er: EntityRef = {
      expressId: ref.expressId,
      type: t,
      byteOffset: ref.byteOffset,
      byteLength: ref.byteLength,
      lineNumber: ref.lineNumber,
    };
    byId.set(er.expressId, er);
    const arr = byType.get(t);
    if (arr) arr.push(er.expressId);
    else byType.set(t, [er.expressId]);
  }
  return { byId, byType };
}

function findAttrIndex(typeName: string, attrName: string): number | null {
  const attrs = getAllAttributesForEntity(typeName);
  if (!attrs || attrs.length === 0) return null;
  const idx = attrs.findIndex((a) => a?.name === attrName);
  return idx >= 0 ? idx : null;
}

function isCandidateElementType(typeUpper: string): boolean {
  // Fast prefilter: skip common non-placeable types.
  if (!typeUpper || !typeUpper.startsWith('IFC')) return false;
  if (typeUpper.startsWith('IFCREL')) return false;
  if (typeUpper.startsWith('IFCPROPERTY')) return false;
  if (typeUpper.startsWith('IFCQUANTITY')) return false;
  if (typeUpper.startsWith('IFCMATERIAL')) return false;
  if (typeUpper.startsWith('IFCPRESENTATION')) return false;
  if (typeUpper.startsWith('IFCREPRESENTATION')) return false;
  if (typeUpper.startsWith('IFCSTYLE')) return false;
  if (typeUpper === 'IFCCARTESIANPOINT') return false;
  if (typeUpper === 'IFCDIRECTION') return false;
  if (typeUpper.startsWith('IFCAXIS2PLACEMENT')) return false;
  if (typeUpper === 'IFCLOCALPLACEMENT') return false;
  return true;
}

export async function generateLod0(input: LodInput): Promise<Lod0Json> {
  const buffer = toIfcArrayBuffer(input);
  const source = new Uint8Array(buffer);
  const { entityRefs } = await scanIfcEntities(buffer);
  const entityIndex = buildEntityIndex(entityRefs);
  const unitScale = extractLengthUnitScale(source, entityIndex);
  const extractor = new EntityExtractor(source);

  const entityCache = new Map<number, any | null>();
  const placementCache = new Map<number, Float64Array>();
  const axisCache = new Map<number, Float64Array>();
  const pointCache = new Map<number, Vec3 | null>();
  const dirCache = new Map<number, Vec3>();

  const getEntity = (id: number): any | null => {
    if (entityCache.has(id)) return entityCache.get(id) ?? null;
    const ref = entityIndex.byId.get(id);
    const ent = ref ? extractor.extractEntity(ref) : null;
    entityCache.set(id, ent);
    return ent;
  };

  const getPoint = (id: number): Vec3 | null => {
    if (pointCache.has(id)) return pointCache.get(id) ?? null;
    const ent = getEntity(id);
    if (!ent || String(ent.type || '').toUpperCase() !== 'IFCCARTESIANPOINT') {
      pointCache.set(id, null);
      return null;
    }
    const coords = ent.attributes?.[0];
    let x = 0, y = 0, z = 0;
    if (Array.isArray(coords)) {
      x = Number(coords[0] ?? 0);
      y = Number(coords[1] ?? 0);
      z = Number(coords[2] ?? 0);
    }
    const v: Vec3 = [x * unitScale, y * unitScale, z * unitScale];
    pointCache.set(id, v);
    return v;
  };

  const getDirection = (id: number): Vec3 | null => {
    if (dirCache.has(id)) return dirCache.get(id)!;
    const ent = getEntity(id);
    if (!ent || String(ent.type || '').toUpperCase() !== 'IFCDIRECTION') return null;
    const ratios = ent.attributes?.[0];
    let x = 1, y = 0, z = 0;
    if (Array.isArray(ratios)) {
      x = Number(ratios[0] ?? 1);
      y = Number(ratios[1] ?? 0);
      z = Number(ratios[2] ?? 0);
    }
    const v: Vec3 = [x, y, z];
    dirCache.set(id, v);
    return v;
  };

  const getAxisPlacementMatrix = (id: number): Float64Array => {
    const cached = axisCache.get(id);
    if (cached) return cached;
    const ent = getEntity(id);
    if (!ent) return mat4Identity();
    const t = String(ent.type || '').toUpperCase();
    let m = mat4Identity();

    if (t === 'IFCAXIS2PLACEMENT3D') {
      const locRef = ent.attributes?.[0];
      const axisRef = ent.attributes?.[1];
      const refDirRef = ent.attributes?.[2];
      const tVec = typeof locRef === 'number' ? (getPoint(locRef) ?? [0, 0, 0]) : [0, 0, 0];

      const zAxis = typeof axisRef === 'number' ? (getDirection(axisRef) ?? [0, 0, 1]) : [0, 0, 1];
      const xAxis0 = typeof refDirRef === 'number' ? (getDirection(refDirRef) ?? [1, 0, 0]) : [1, 0, 0];
      const zN = vec3Normalize(zAxis as Vec3, [0, 0, 1]);
      const xN0 = vec3Normalize(xAxis0 as Vec3, [1, 0, 0]);
      const yN = vec3Normalize(vec3Cross(zN, xN0), [0, 1, 0]);
      const xN = vec3Normalize(vec3Cross(yN, zN), [1, 0, 0]);
      m = mat4FromBasisTranslation(xN, yN, zN, tVec as Vec3);
    } else if (t === 'IFCAXIS2PLACEMENT2D') {
      const locRef = ent.attributes?.[0];
      const refDirRef = ent.attributes?.[1];
      const t2 = typeof locRef === 'number' ? (getPoint(locRef) ?? [0, 0, 0]) : [0, 0, 0];
      const xAxis0 = typeof refDirRef === 'number' ? (getDirection(refDirRef) ?? [1, 0, 0]) : [1, 0, 0];
      const xN = vec3Normalize(xAxis0 as Vec3, [1, 0, 0]);
      const zN: Vec3 = [0, 0, 1];
      const yN = vec3Normalize(vec3Cross(zN, xN), [0, 1, 0]);
      m = mat4FromBasisTranslation(xN, yN, zN, t2 as Vec3);
    }

    axisCache.set(id, m);
    return m;
  };

  const getPlacementMatrix = (id: number): Float64Array => {
    const cached = placementCache.get(id);
    if (cached) return cached;
    const ent = getEntity(id);
    if (!ent || String(ent.type || '').toUpperCase() !== 'IFCLOCALPLACEMENT') {
      const ident = mat4Identity();
      placementCache.set(id, ident);
      return ident;
    }

    // IfcLocalPlacement: (PlacementRelTo, RelativePlacement)
    const relTo = ent.attributes?.[0];
    const relPlacement = ent.attributes?.[1];

    const local = typeof relPlacement === 'number' ? getAxisPlacementMatrix(relPlacement) : mat4Identity();
    const parent = typeof relTo === 'number' ? getPlacementMatrix(relTo) : mat4Identity();
    const world = mat4Mul(parent, local);
    placementCache.set(id, world);
    return world;
  };

  const computeWorldAabbFromLocalAabb = (m: Float64Array, minL: Vec3, maxL: Vec3): { min: Vec3; max: Vec3 } => {
    const corners: Vec3[] = [
      [minL[0], minL[1], minL[2]],
      [maxL[0], minL[1], minL[2]],
      [minL[0], maxL[1], minL[2]],
      [minL[0], minL[1], maxL[2]],
      [maxL[0], maxL[1], minL[2]],
      [maxL[0], minL[1], maxL[2]],
      [minL[0], maxL[1], maxL[2]],
      [maxL[0], maxL[1], maxL[2]],
    ];
    const pts = corners.map((c) => mat4TransformPoint(m, c));
    return aabbFromPoints(pts);
  };

  const findBoundingBoxForRepresentation = (repRef: unknown): { min: Vec3; max: Vec3 } | null => {
    if (typeof repRef !== 'number') return null;
    const repEnt = getEntity(repRef);
    if (!repEnt) return null;
    const repType = String(repEnt.type || '').toUpperCase();

    // IfcProductDefinitionShape: Representations (list)
    if (repType === 'IFCPRODUCTDEFINITIONSHAPE') {
      const reps = repEnt.attributes?.[2];
      if (Array.isArray(reps)) {
        for (const r of reps) {
          const bb = findBoundingBoxForRepresentation(r);
          if (bb) return bb;
        }
      }
      return null;
    }

    // IfcShapeRepresentation: Items (list)
    if (repType === 'IFCSHAPEREPRESENTATION') {
      const items = repEnt.attributes?.[3];
      if (Array.isArray(items)) {
        for (const it of items) {
          const bb = findBoundingBoxForRepresentation(it);
          if (bb) return bb;
        }
      }
      return null;
    }

    if (repType === 'IFCBOUNDINGBOX') {
      const cornerRef = repEnt.attributes?.[0];
      const xDim = Number(repEnt.attributes?.[1] ?? 0) * unitScale;
      const yDim = Number(repEnt.attributes?.[2] ?? 0) * unitScale;
      const zDim = Number(repEnt.attributes?.[3] ?? 0) * unitScale;
      const corner = typeof cornerRef === 'number' ? (getPoint(cornerRef) ?? [0, 0, 0]) : [0, 0, 0];
      const minL: Vec3 = [corner[0], corner[1], corner[2]];
      const maxL: Vec3 = [corner[0] + xDim, corner[1] + yDim, corner[2] + zDim];
      return { min: minL, max: maxL };
    }

    return null;
  };

  const elements: Lod0Element[] = [];

  for (const [id, ref] of entityIndex.byId) {
    const typeUpper = ref.type;
    if (!isCandidateElementType(typeUpper)) continue;

    // Only include entities that declare ObjectPlacement in schema metadata
    const objPlacementIdx = findAttrIndex(typeUpper, 'ObjectPlacement');
    if (objPlacementIdx === null) continue;

    const ent = getEntity(id);
    if (!ent) continue;

    const attrs = ent.attributes || [];

    const globalIdIdx = findAttrIndex(typeUpper, 'GlobalId');
    const nameIdx = findAttrIndex(typeUpper, 'Name');
    const reprIdx = findAttrIndex(typeUpper, 'Representation');

    const globalId = globalIdIdx !== null && typeof attrs[globalIdIdx] === 'string' ? (attrs[globalIdIdx] as string) : null;
    const name = nameIdx !== null && typeof attrs[nameIdx] === 'string' ? (attrs[nameIdx] as string) : null;

    const placementRef = attrs[objPlacementIdx];
    const worldM = typeof placementRef === 'number' ? getPlacementMatrix(placementRef) : mat4Identity();

    let bboxSource: 'shape' | 'fallback' = 'fallback';
    let localAabb: { min: Vec3; max: Vec3 } | null = null;

    if (reprIdx !== null) {
      localAabb = findBoundingBoxForRepresentation(attrs[reprIdx]);
      if (localAabb) bboxSource = 'shape';
    }

    if (!localAabb) {
      // Default 0.2m cube centered at origin (local space)
      localAabb = { min: vec3(-0.1, -0.1, -0.1), max: vec3(0.1, 0.1, 0.1) };
      bboxSource = 'fallback';
    }

    const worldAabb = computeWorldAabbFromLocalAabb(worldM, localAabb.min, localAabb.max);
    const centroid: Vec3 = [
      (worldAabb.min[0] + worldAabb.max[0]) / 2,
      (worldAabb.min[1] + worldAabb.max[1]) / 2,
      (worldAabb.min[2] + worldAabb.max[2]) / 2,
    ];

    const ifcClass = normalizeIfcTypeName(typeUpper);

    const transform = Array.from(worldM) as unknown as Lod0Element['transform'];

    elements.push({
      expressID: id,
      globalId,
      ifcClass,
      name,
      transform,
      bbox: worldAabb,
      centroid,
      bbox_source: bboxSource,
    });
  }

  return {
    schema: 'ifc-lite-geometry',
    lod: 0,
    units: 'm',
    elements,
  };
}
