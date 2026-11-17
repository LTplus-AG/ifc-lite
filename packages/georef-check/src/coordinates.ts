/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a model's coordinates are, read from the STEP entities without
 * meshing: the composed site placement, a strided sample of coordinates, and
 * the 3D context's origin and TrueNorth. See {@link CoordinateMagnitudes} for
 * the definition of each number.
 */

import type { CoordinateMagnitudes, PointFamilyStats, RootSpatialPlacementFact, Vec2, Vec3 } from './types.js';

/** The minimum a fact collector needs from a parsed file. */
export interface EntityReader {
  /** Decoded entity; `type` is the upper-case STEP name. */
  get(id: number): { type: string; attributes: unknown[] } | undefined;
  /** Ids of one upper-case STEP type, in file order. */
  idsOfType(type: string): readonly number[];
  /**
   * The first `maxBytes` of an entity's STEP record as text, when the reader
   * can slice the source. Point lists are read through this, so a mesh of any
   * size costs at most `maxBytes`; without it they are decoded whole.
   */
  recordPrefix?(id: number, maxBytes: number): string | undefined;
  /**
   * The first entity reference of a record's attribute list (`#11` in
   * `#12=IFCAXIS2PLACEMENT3D(#11,...)`), read from the raw bytes. Lets the
   * probe find every axis placement's Location without decoding 100k records.
   */
  firstReference?(id: number): number | undefined;
}

/** PlacementRelTo chains longer than this are treated as cycles or abuse and not composed. */
export const MAX_PLACEMENT_DEPTH = 32;
/** Coordinate tuples sampled at most, per family. */
export const DEFAULT_MAX_SAMPLED_POINTS = 2048;
/**
 * Point lists read at most (evenly strided over all of them). Each costs one
 * bounded read, so 64 caps the probe at about 64 x {@link POINT_LIST_PREFIX_BYTES}
 * of text while still reaching meshes spread across the whole file.
 */
export const MAX_SAMPLED_POINT_LISTS = 64;
/**
 * Bytes read from the start of each point list. 8 KiB holds about 200
 * coordinate tuples at survey precision, plenty to tell map magnitude from
 * local, and is the same for a 1 kB list and a 200 MB one.
 */
export const POINT_LIST_PREFIX_BYTES = 8 * 1024;
/** Root spatial placements reported at most. */
export const MAX_ROOT_SPATIAL_PLACEMENTS = 16;

export interface Frame {
  x: Vec3;
  y: Vec3;
  z: Vec3;
  t: Vec3;
}

const IDENTITY: Frame = { x: { x: 1, y: 0, z: 0 }, y: { x: 0, y: 1, z: 0 }, z: { x: 0, y: 0, z: 1 }, t: { x: 0, y: 0, z: 0 } };

function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') return num(value[1]);
  return undefined;
}

function ref(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function numbers(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const v of value) {
    const n = num(v);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

function vec(list: number[] | undefined): Vec3 | undefined {
  if (!list || list.length < 2) return undefined;
  return { x: list[0], y: list[1], z: list[2] ?? 0 };
}

function normalize(v: Vec3): Vec3 | undefined {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 0 && Number.isFinite(len) ? { x: v.x / len, y: v.y / len, z: v.z / len } : undefined;
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function readPoint(reader: EntityReader, id: number | undefined): Vec3 | undefined {
  const entity = id === undefined ? undefined : reader.get(id);
  if (entity?.type !== 'IFCCARTESIANPOINT') return undefined;
  return vec(numbers(entity.attributes[0]));
}

export function readDirection(reader: EntityReader, id: number | undefined): Vec3 | undefined {
  const entity = id === undefined ? undefined : reader.get(id);
  if (entity?.type !== 'IFCDIRECTION') return undefined;
  return vec(numbers(entity.attributes[0]));
}

/** IfcAxis2Placement3D / 2D as an orthonormal frame. */
export function readAxisPlacement(reader: EntityReader, id: number | undefined): Frame | undefined {
  const entity = id === undefined ? undefined : reader.get(id);
  if (!entity) return undefined;
  const t = readPoint(reader, ref(entity.attributes[0])) ?? { x: 0, y: 0, z: 0 };
  if (entity.type === 'IFCAXIS2PLACEMENT2D') {
    const x = normalize(readDirection(reader, ref(entity.attributes[1])) ?? IDENTITY.x) ?? IDENTITY.x;
    const flat = normalize({ x: x.x, y: x.y, z: 0 }) ?? IDENTITY.x;
    return { x: flat, y: { x: -flat.y, y: flat.x, z: 0 }, z: IDENTITY.z, t };
  }
  if (entity.type !== 'IFCAXIS2PLACEMENT3D') return undefined;
  const z = normalize(readDirection(reader, ref(entity.attributes[1])) ?? IDENTITY.z) ?? IDENTITY.z;
  const refDir = readDirection(reader, ref(entity.attributes[2])) ?? IDENTITY.x;
  const projected = { x: refDir.x - dot(refDir, z) * z.x, y: refDir.y - dot(refDir, z) * z.y, z: refDir.z - dot(refDir, z) * z.z };
  const x = normalize(projected) ?? normalize(cross({ x: 0, y: 1, z: 0 }, z)) ?? IDENTITY.x;
  return { x, y: cross(z, x), z, t };
}

function compose(parent: Frame, child: Frame): Frame {
  const apply = (v: Vec3): Vec3 => ({
    x: parent.x.x * v.x + parent.y.x * v.y + parent.z.x * v.z,
    y: parent.x.y * v.x + parent.y.y * v.y + parent.z.y * v.z,
    z: parent.x.z * v.x + parent.y.z * v.y + parent.z.z * v.z,
  });
  const t = apply(child.t);
  return { x: apply(child.x), y: apply(child.y), z: apply(child.z), t: { x: t.x + parent.t.x, y: t.y + parent.t.y, z: t.z + parent.t.z } };
}

/**
 * Frame of an IfcLocalPlacement in the world, composed through
 * PlacementRelTo. Undefined for other placement kinds (IfcLinearPlacement,
 * IfcGridPlacement), unreadable entries, and chains beyond
 * {@link MAX_PLACEMENT_DEPTH}.
 */
export function placementFrame(reader: EntityReader, placementId: number | undefined): Frame | undefined {
  let frame: Frame | undefined;
  let id = placementId;
  for (let depth = 0; id !== undefined; depth++) {
    if (depth >= MAX_PLACEMENT_DEPTH) return undefined;
    const entity = reader.get(id);
    if (entity?.type !== 'IFCLOCALPLACEMENT') return undefined;
    const local = readAxisPlacement(reader, ref(entity.attributes[1]));
    if (!local) return undefined;
    frame = frame ? compose(local, frame) : local;
    id = ref(entity.attributes[0]);
  }
  return frame;
}

/** Origin of an IfcLocalPlacement in the world frame; see {@link placementFrame}. */
export function placementOrigin(reader: EntityReader, placementId: number | undefined): Vec3 | undefined {
  return placementFrame(reader, placementId)?.t;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stride<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

const AXIS_PLACEMENT_TYPES = ['IFCAXIS2PLACEMENT3D', 'IFCAXIS2PLACEMENT2D', 'IFCAXIS1PLACEMENT'] as const;

/**
 * How many axis placements use each IfcCartesianPoint as their Location. A
 * large model has as many axis placements as elements, so only the first
 * reference of each record is read when the reader offers it.
 */
export function placementLocationUses(reader: EntityReader): Map<number, number> {
  const uses = new Map<number, number>();
  for (const type of AXIS_PLACEMENT_TYPES) {
    for (const id of reader.idsOfType(type)) {
      const point = reader.firstReference ? reader.firstReference(id) : ref(reader.get(id)?.attributes[0]);
      if (point !== undefined) uses.set(point, (uses.get(point) ?? 0) + 1);
    }
  }
  return uses;
}

// One coordinate tuple in STEP text: "(x,y)" or "(x,y,z)".
const TUPLE = /\(\s*([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)\s*,\s*([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)\s*(?:,\s*([-+]?[0-9.]+(?:[eE][-+]?[0-9]+)?)\s*)?\)/g;

/** The complete coordinate tuples in the first bytes of a point list record. */
export function tuplesFromRecordPrefix(text: string): Vec3[] {
  // CoordList is the first attribute: everything after the record's "((".
  // STEP allows whitespace between tokens: "( (".
  const open = /\(\s*\(/.exec(text);
  if (!open) return [];
  const out: Vec3[] = [];
  for (const m of text.slice(open.index + 1).matchAll(TUPLE)) {
    const v = [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])];
    if (v.every(Number.isFinite)) out.push({ x: v[0], y: v[1], z: v[2] });
  }
  return out;
}

function pointListTuples(reader: EntityReader, id: number): Vec3[] {
  const prefix = reader.recordPrefix?.(id, POINT_LIST_PREFIX_BYTES);
  if (prefix !== undefined) return tuplesFromRecordPrefix(prefix);
  const tuples = reader.get(id)?.attributes[0];
  if (!Array.isArray(tuples)) return [];
  const out: Vec3[] = [];
  for (const tuple of tuples) {
    const p = vec(numbers(tuple));
    if (p) out.push(p);
  }
  return out;
}

function stats(points: Vec3[]): PointFamilyStats | undefined {
  if (points.length === 0) return undefined;
  const horizontal = points.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
  return {
    median: { x: median(points.map((p) => p.x)), y: median(points.map((p) => p.y)), z: median(points.map((p) => p.z)) },
    p90Horizontal: horizontal[Math.min(horizontal.length - 1, Math.floor(horizontal.length * 0.9))],
    sampled: points.length,
  };
}

/**
 * Strided samples of the two coordinate families, kept apart: IfcCartesianPoint
 * that is no axis placement's Location, and IfcCartesianPointList2D/3D.
 */
export function samplePointFamilies(
  reader: EntityReader,
  maxPoints = DEFAULT_MAX_SAMPLED_POINTS,
  placementPoints: ReadonlyMap<number, number> = placementLocationUses(reader),
): { cartesianPoints: Vec3[]; pointLists: Vec3[] } {
  // Drop placement Locations before striding: a stride over the unfiltered ids
  // can land only on Locations when they alternate with geometry points, and
  // leave an empty sample. The filter is one set lookup per id, far cheaper
  // than the record reads the stride then limits.
  const geometryPointIds = reader.idsOfType('IFCCARTESIANPOINT').filter((id) => !placementPoints.has(id));
  const cartesianPoints: Vec3[] = [];
  for (const id of stride(geometryPointIds, maxPoints)) {
    const p = readPoint(reader, id);
    if (p) cartesianPoints.push(p);
  }
  // The two list types are strided separately: one stride over their
  // concatenation could skip the few lists of the minority type entirely.
  const ids3d = reader.idsOfType('IFCCARTESIANPOINTLIST3D');
  const ids2d = reader.idsOfType('IFCCARTESIANPOINTLIST2D');
  const budget2d = Math.min(ids2d.length, Math.max(0, MAX_SAMPLED_POINT_LISTS - Math.min(ids3d.length, Math.floor(MAX_SAMPLED_POINT_LISTS / 2))));
  const budget3d = Math.min(ids3d.length, MAX_SAMPLED_POINT_LISTS - budget2d);
  const lists = [...stride(ids3d, budget3d), ...stride(ids2d, budget2d)];
  const perList = Math.max(1, Math.floor(maxPoints / Math.max(1, lists.length)));
  const pointLists: Vec3[] = [];
  for (const id of lists) pointLists.push(...stride(pointListTuples(reader, id), perList));
  return { cartesianPoints, pointLists };
}

function isDefaultAxes(frame: Frame): boolean {
  const eps = 1e-9;
  return Math.abs(frame.x.x - 1) < eps && Math.abs(frame.x.y) < eps && Math.abs(frame.x.z) < eps
    && Math.abs(frame.z.z - 1) < eps && Math.abs(frame.z.x) < eps && Math.abs(frame.z.y) < eps;
}

/** IFC4X3 spatial structure elements beside the IFC2X3/IFC4 four. */
const SPATIAL_STRUCTURE_TYPES = [
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
  'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCBRIDGEPART', 'IFCROAD', 'IFCROADPART',
  'IFCRAILWAY', 'IFCRAILWAYPART', 'IFCMARINEFACILITY', 'IFCMARINEPART',
] as const;

function pascal(type: string): string {
  const known: Record<string, string> = {
    IFCSITE: 'IfcSite', IFCBUILDING: 'IfcBuilding', IFCBUILDINGSTOREY: 'IfcBuildingStorey', IFCSPACE: 'IfcSpace',
    IFCFACILITY: 'IfcFacility', IFCFACILITYPART: 'IfcFacilityPart', IFCBRIDGE: 'IfcBridge', IFCBRIDGEPART: 'IfcBridgePart',
    IFCROAD: 'IfcRoad', IFCROADPART: 'IfcRoadPart', IFCRAILWAY: 'IfcRailway', IFCRAILWAYPART: 'IfcRailwayPart',
    IFCMARINEFACILITY: 'IfcMarineFacility', IFCMARINEPART: 'IfcMarinePart',
  };
  return known[type] ?? type;
}

/**
 * Spatial structure elements whose IfcLocalPlacement has no PlacementRelTo,
 * with that placement's own Location and whether it turns the axes: the
 * placement LoGeoRef 30 stores the location in.
 */
export function rootSpatialPlacements(reader: EntityReader): RootSpatialPlacementFact[] {
  const out: RootSpatialPlacementFact[] = [];
  for (const type of SPATIAL_STRUCTURE_TYPES) {
    for (const id of reader.idsOfType(type)) {
      if (out.length >= MAX_ROOT_SPATIAL_PLACEMENTS) return out;
      const placement = reader.get(ref(reader.get(id)?.attributes[5]) ?? -1);
      if (placement?.type !== 'IFCLOCALPLACEMENT' || ref(placement.attributes[0]) !== undefined) continue;
      const frame = readAxisPlacement(reader, ref(placement.attributes[1]));
      if (!frame) continue;
      out.push({ elementId: id, elementType: pascal(type), location: frame.t, rotated: !isDefaultAxes(frame) });
    }
  }
  return out;
}

export function coordinateMagnitudes(reader: EntityReader, siteId: number | undefined, maxPoints?: number): CoordinateMagnitudes {
  const site = siteId === undefined ? undefined : reader.get(siteId);
  const sitePlacementId = site ? ref(site.attributes[5]) : undefined;
  const siteOrigin = placementOrigin(reader, sitePlacementId);
  const placementPoints = placementLocationUses(reader);
  const families = samplePointFamilies(reader, maxPoints, placementPoints);
  const result: CoordinateMagnitudes = { sampledPoints: families.cartesianPoints.length + families.pointLists.length };
  if (siteOrigin) result.siteOrigin = siteOrigin;
  if (sitePlacementId !== undefined) {
    result.sitePlacementId = sitePlacementId;
    const placement = reader.get(sitePlacementId);
    const axis = placement?.type === 'IFCLOCALPLACEMENT' ? reader.get(ref(placement.attributes[1]) ?? -1) : undefined;
    const pointId = axis ? ref(axis.attributes[0]) : undefined;
    const coordinates = readPoint(reader, pointId);
    if (pointId !== undefined && coordinates) {
      result.siteLocationPoint = { id: pointId, coordinates, sharedBy: placementPoints.get(pointId) ?? 1 };
    }
    const parent = placement?.type === 'IFCLOCALPLACEMENT' ? placementFrame(reader, ref(placement.attributes[0])) : undefined;
    if (parent) result.siteParentAxes = { x: parent.x, y: parent.y, z: parent.z };
  }
  const cartesianPoints = stats(families.cartesianPoints);
  const pointLists = stats(families.pointLists);
  if (cartesianPoints || pointLists) {
    result.geometry = {};
    if (cartesianPoints) result.geometry.cartesianPoints = cartesianPoints;
    if (pointLists) result.geometry.pointLists = pointLists;
  }
  return result;
}
/** The 3D model context: WorldCoordinateSystem origin when off 0,0,0, and TrueNorth when authored. */
export function modelContextFacts(reader: EntityReader): { contextOrigin?: Vec3; trueNorth?: Vec2 } {
  const ids = reader.idsOfType('IFCGEOMETRICREPRESENTATIONCONTEXT');
  const contexts = ids.map((id) => reader.get(id)).filter((e): e is NonNullable<typeof e> => !!e);
  const model = contexts.find((e) => num(e.attributes[2]) === 3 && String(e.attributes[1] ?? '').toLowerCase() === 'model')
    ?? contexts.find((e) => num(e.attributes[2]) === 3)
    ?? contexts[0];
  if (!model) return {};
  const out: { contextOrigin?: Vec3; trueNorth?: Vec2 } = {};
  const wcs = readAxisPlacement(reader, ref(model.attributes[4]));
  if (wcs && (wcs.t.x !== 0 || wcs.t.y !== 0 || wcs.t.z !== 0)) out.contextOrigin = wcs.t;
  const north = readDirection(reader, ref(model.attributes[5]));
  if (north) out.trueNorth = { x: north.x, y: north.y };
  return out;
}

/** IfcSite.SiteAddress or IfcBuilding.BuildingAddress set on any site or building. */
export function hasPostalAddress(reader: EntityReader): boolean {
  const siteHas = reader.idsOfType('IFCSITE').some((id) => ref(reader.get(id)?.attributes[13]) !== undefined);
  return siteHas || reader.idsOfType('IFCBUILDING').some((id) => ref(reader.get(id)?.attributes[11]) !== undefined);
}
