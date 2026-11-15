/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a model's coordinates are, read from the STEP entities without
 * meshing: the composed site placement, a strided sample of coordinates, and
 * the 3D context's origin and TrueNorth. See {@link CoordinateMagnitudes} for
 * the definition of each number.
 */

import type { CoordinateMagnitudes, Vec2, Vec3 } from './types.js';

/** The minimum a fact collector needs from a parsed file. */
export interface EntityReader {
  /** Decoded entity; `type` is the upper-case STEP name. */
  get(id: number): { type: string; attributes: unknown[] } | undefined;
  /** Ids of one upper-case STEP type, in file order. */
  idsOfType(type: string): readonly number[];
  /** Byte length of an entity's record, when known (used to skip huge point lists). */
  sizeOf?(id: number): number | undefined;
}

/** PlacementRelTo chains longer than this are treated as cycles or abuse and not composed. */
export const MAX_PLACEMENT_DEPTH = 32;
/** Coordinate tuples sampled at most. */
export const DEFAULT_MAX_SAMPLED_POINTS = 2048;
/** Point lists larger than this are skipped by the sampler, so one huge mesh cannot make the scan expensive. */
export const MAX_POINT_LIST_BYTES = 2 * 1024 * 1024;

interface Frame {
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
 * Origin of an IfcLocalPlacement in the world frame, composed through
 * PlacementRelTo. Undefined for other placement kinds (IfcLinearPlacement,
 * IfcGridPlacement), unreadable entries, and chains beyond
 * {@link MAX_PLACEMENT_DEPTH}.
 */
export function placementOrigin(reader: EntityReader, placementId: number | undefined): Vec3 | undefined {
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
  return frame?.t;
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

/** Strided sample of coordinate tuples from IfcCartesianPoint and IfcCartesianPointList2D/3D. */
export function samplePoints(reader: EntityReader, maxPoints = DEFAULT_MAX_SAMPLED_POINTS): Vec3[] {
  const listIds = [...reader.idsOfType('IFCCARTESIANPOINTLIST3D'), ...reader.idsOfType('IFCCARTESIANPOINTLIST2D')];
  const pointIds = reader.idsOfType('IFCCARTESIANPOINT');
  const listBudget = listIds.length === 0 ? 0 : pointIds.length === 0 ? maxPoints : maxPoints >> 1;
  const out: Vec3[] = [];
  for (const id of stride(pointIds, maxPoints - listBudget)) {
    const p = readPoint(reader, id);
    if (p) out.push(p);
  }
  if (listBudget > 0) {
    const lists = stride(listIds, Math.min(64, listBudget));
    const perList = Math.max(1, Math.floor(listBudget / lists.length));
    for (const id of lists) {
      const size = reader.sizeOf?.(id);
      if (size !== undefined && size > MAX_POINT_LIST_BYTES) continue;
      const tuples = reader.get(id)?.attributes[0];
      if (!Array.isArray(tuples)) continue;
      for (const tuple of stride(tuples, perList)) {
        const p = vec(numbers(tuple));
        if (p) out.push(p);
      }
    }
  }
  return out;
}

export function coordinateMagnitudes(reader: EntityReader, siteId: number | undefined, maxPoints?: number): CoordinateMagnitudes {
  const site = siteId === undefined ? undefined : reader.get(siteId);
  const sitePlacementId = site ? ref(site.attributes[5]) : undefined;
  const siteOrigin = placementOrigin(reader, sitePlacementId);
  const points = samplePoints(reader, maxPoints);
  const result: CoordinateMagnitudes = { sampledPoints: points.length };
  if (siteOrigin) result.siteOrigin = siteOrigin;
  if (sitePlacementId !== undefined) result.sitePlacementId = sitePlacementId;
  if (points.length > 0) {
    result.pointMedian = { x: median(points.map((p) => p.x)), y: median(points.map((p) => p.y)), z: median(points.map((p) => p.z)) };
    const horizontal = points.map((p) => Math.hypot(p.x, p.y)).sort((a, b) => a - b);
    result.pointP90Horizontal = horizontal[Math.min(horizontal.length - 1, Math.floor(horizontal.length * 0.9))];
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
