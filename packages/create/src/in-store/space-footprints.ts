/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan footprints of a model's existing `IfcSpace`s, per storey, as
 * RINGS (charter #6232 M4): the Room tool tests "is this point already in a
 * room" and links its layout faces to the rooms they are, both of which need
 * a polygon, not a vertex cloud.
 *
 *   - An extruded body's footprint is its swept profile, already a ring.
 *   - A faceted body (IfcTriangulatedFaceSet, IfcPolygonalFaceSet,
 *     IfcFacetedBrep, as AC20-FZK-Haus's rooms are) is outlined by the
 *     boundary of its UP-facing faces: for a volume with one floor and one
 *     ceiling over every plan point those faces tile the footprint exactly
 *     once, so the edges only one of them uses are the outline. Should that
 *     fail (an open shell, no up-facing face) the convex hull stands in: a
 *     simple polygon, never a cloud.
 *
 * Every footprint is storey-local metres. The body is read in the file's
 * length unit, and so is a space authored this session: the in-store
 * builders write native units (`resolveSpatialAnchor` carries the scale), so
 * both are scaled alike.
 */

import { EntityExtractor, type IfcAttributeValue, type IfcDataStore } from '@ifc-lite/parser';
import type { Vec2 } from './auto-space-detect.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import {
  applyFrame,
  frameInStoreyFrame,
  numericAttr,
  readEntity,
  readVec3,
  storeyPlacementChain,
  type OverlayWallReader,
} from './placement-frame.js';
import { buildRelatingChildrenIndex, createOverlayLookup, effectiveMemberType, effectiveStoreyIds } from './spatial-children.js';
import { gatherExtrudedFootprint, resolveEntityTypeName } from './extract-walls.js';

type Vec3 = [number, number, number];
type Entity = { type?: string; attributes: IfcAttributeValue[] };

/** One existing space's footprint on its storey. */
export interface SpaceFootprint {
  expressId: number;
  /** Storey-local metres, a simple ring (no repeated closing vertex). */
  footprint: Vec2[];
}

function signedArea(ring: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Andrew's monotone chain, CCW. */
function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Vec2[]) => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * The plan outline of a faceted body: the boundary of its up-facing faces,
 * chained into loops, the largest kept. Faces are 3D polygons in one frame.
 */
export function facetedFootprint(faces: readonly (readonly Vec3[])[]): Vec2[] | null {
  const key = (p: Vec3) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
  const at = new Map<string, Vec2>();
  const uses = new Map<string, number>();
  const directed: Array<[string, string]> = [];
  const all: Vec2[] = [];
  for (const face of faces) {
    for (const p of face) all.push([p[0], p[1]]);
    if (face.length < 3) continue;
    // Newell normal: its z is twice the projected signed area.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < face.length; i++) {
      const p = face[i], q = face[(i + 1) % face.length];
      nx += (p[1] - q[1]) * (p[2] + q[2]);
      ny += (p[2] - q[2]) * (p[0] + q[0]);
      nz += (p[0] - q[0]) * (p[1] + q[1]);
    }
    if (nz <= 0.1 * Math.hypot(nx, ny, nz)) continue;
    for (let i = 0; i < face.length; i++) {
      const a = key(face[i]), b = key(face[(i + 1) % face.length]);
      if (a === b) continue;
      at.set(a, [face[i][0], face[i][1]]);
      directed.push([a, b]);
      const undirected = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(undirected, (uses.get(undirected) ?? 0) + 1);
    }
  }
  const next = new Map<string, string[]>();
  for (const [a, b] of directed) {
    if (uses.get(a < b ? `${a}|${b}` : `${b}|${a}`) !== 1) continue;
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
  }
  let best: Vec2[] | null = null;
  let bestArea = 0;
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop: Vec2[] = [];
      let cur = start;
      for (let guard = 0; guard <= directed.length; guard++) {
        const outs = next.get(cur);
        if (!outs || outs.length === 0) break;
        loop.push(at.get(cur)!);
        cur = outs.pop()!;
        if (cur === start) break;
      }
      const area = cur === start ? signedArea(loop) : 0;
      if (loop.length >= 3 && Math.abs(area) > bestArea) { bestArea = Math.abs(area); best = loop; }
    }
  }
  if (best) return signedArea(best) < 0 ? best.reverse() : best;
  const hull = convexHull(all);
  return hull.length >= 3 ? hull : null;
}

const list = (v: IfcAttributeValue | undefined): IfcAttributeValue[] => (Array.isArray(v) ? v : []);

/** The faces of an IfcTriangulatedFaceSet / IfcPolygonalFaceSet as 3D polygons. */
function faceSetFaces(store: IfcDataStore, extractor: EntityExtractor, overlay: OverlayWallReader | undefined, item: Entity, polygonal: boolean): Vec3[][] {
  const coordId = numericAttr(item.attributes[0]);
  const coords = coordId === null ? null : readEntity(store, extractor, overlay, coordId);
  const points = list(coords?.attributes[0]).map((p) => readVec3(p));
  // PnIndex (triangulated: 4, polygonal: 3) remaps face indices into the point list.
  const pn = list(item.attributes[polygonal ? 3 : 4]).map((v) => numericAttr(v));
  const point = (index: IfcAttributeValue): Vec3 | null => {
    const i = numericAttr(index);
    if (i === null) return null;
    const j = pn.length > 0 ? pn[i - 1] : i;
    return j === null || j === undefined ? null : points[j - 1] ?? null;
  };
  const loops: IfcAttributeValue[][] = polygonal
    ? list(item.attributes[2]).map((ref) => {
      const id = numericAttr(ref);
      return list(id === null ? undefined : readEntity(store, extractor, overlay, id)?.attributes[0]);
    })
    : list(item.attributes[3]).map((tri) => list(tri));
  return loops.map((loop) => loop.map(point)).filter((f): f is Vec3[] => f.every((p) => p !== null));
}

/** The faces of an IfcFacetedBrep (every bound's polyloop) as 3D polygons. */
function brepFaces(store: IfcDataStore, extractor: EntityExtractor, overlay: OverlayWallReader | undefined, brep: Entity): Vec3[][] {
  const read = (ref: IfcAttributeValue | undefined) => {
    const id = numericAttr(ref);
    return id === null ? null : readEntity(store, extractor, overlay, id);
  };
  const faces: Vec3[][] = [];
  for (const faceRef of list(read(brep.attributes[0])?.attributes[0])) {
    for (const boundRef of list(read(faceRef)?.attributes[0])) {
      const loop = read(read(boundRef)?.attributes[0]);
      const pts = list(loop?.attributes[0]).map((ref) => readVec3(read(ref)?.attributes[0]));
      if (pts.length >= 3 && pts.every((p) => p !== null)) faces.push(pts as Vec3[]);
    }
  }
  return faces;
}

/** Drop a repeated closing vertex. */
function open(ring: Vec2[]): Vec2[] {
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return ring.length > 3 && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9 ? ring.slice(0, -1) : ring;
}

/**
 * The plan footprint RING of a product's body (rep frame, native units): the
 * largest ring over its body items. Null when no item gives one.
 */
export function bodyFootprintRing(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  representationId: number,
): Vec2[] | null {
  const shape = readEntity(store, extractor, overlay, representationId);
  let best: Vec2[] | null = null;
  for (const repRef of list(shape?.attributes[2])) {
    const repId = numericAttr(repRef);
    const rep = repId === null ? null : readEntity(store, extractor, overlay, repId);
    if (!rep || String(rep.attributes[1] ?? '').replace(/'/g, '').toLowerCase() === 'axis') continue;
    for (const itemRef of list(rep.attributes[3])) {
      const itemId = numericAttr(itemRef);
      const item = itemId === null ? null : readEntity(store, extractor, overlay, itemId);
      if (!item || itemId === null) continue;
      const type = resolveEntityTypeName(store, item, itemId);
      let ring: Vec2[] | null = null;
      if (type === 'ifcextrudedareasolid') {
        const pts: Vec2[] = [];
        gatherExtrudedFootprint(store, extractor, overlay, item, pts);
        ring = pts.length >= 3 ? open(pts) : null;
      } else if (type === 'ifctriangulatedfaceset' || type === 'ifcpolygonalfaceset') {
        ring = facetedFootprint(faceSetFaces(store, extractor, overlay, item, type === 'ifcpolygonalfaceset'));
      } else if (type === 'ifcfacetedbrep') {
        ring = facetedFootprint(brepFaces(store, extractor, overlay, item));
      }
      if (ring && ring.length >= 3 && (!best || Math.abs(signedArea(ring)) > Math.abs(signedArea(best)))) best = ring;
    }
  }
  return best;
}

/**
 * Every existing IfcSpace's footprint ring, per storey expressId, with its
 * id. Storeys without one are omitted. Refuses the whole store (empty map)
 * when the length-unit scale can't be trusted — the same refusal
 * `storeyPlanFrame` makes on the write side, so the two never disagree.
 */
export function existingSpaceFootprintEntriesByStorey(
  store: IfcDataStore,
  overlay?: OverlayWallReader,
): Map<number, SpaceFootprint[]> {
  const out = new Map<number, SpaceFootprint[]>();
  if (!store.source) return out;
  const extractor = new EntityExtractor(store.source);
  const scale = safeLengthUnitScale(store.source, store.entityIndex, 'existingSpaceFootprintsByStorey');
  if (scale === null) return out;
  // Spaces authored this session count as existing (#5249).
  const lookup = createOverlayLookup(overlay);
  const aggregated = buildRelatingChildrenIndex(store, extractor, lookup, 'IFCRELAGGREGATES', 4, 5);
  const contained = buildRelatingChildrenIndex(store, extractor, lookup, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 5, 4);
  for (const storeyId of effectiveStoreyIds(store, lookup)) {
    const kids = [...(aggregated.get(storeyId) ?? []), ...(contained.get(storeyId) ?? [])];
    const storeyChain = storeyPlacementChain(store, extractor, overlay, storeyId);
    const entries: SpaceFootprint[] = [];
    for (const id of kids) {
      if ((effectiveMemberType(store, lookup, id) ?? '').toUpperCase() !== 'IFCSPACE') continue;
      const ent = readEntity(store, extractor, overlay, id);
      const placementId = numericAttr(ent?.attributes[5]); // ObjectPlacement
      const representationId = numericAttr(ent?.attributes[6]); // Representation
      if (placementId === null || representationId === null) continue;
      const frame = frameInStoreyFrame(store, extractor, overlay, placementId, storeyChain);
      const ring = bodyFootprintRing(store, extractor, overlay, representationId);
      if (!frame || !ring) continue;
      entries.push({ expressId: id, footprint: ring.map((p) => {
        const w = applyFrame(frame, p);
        return [w[0] * scale, w[1] * scale] as Vec2;
      }) });
    }
    if (entries.length) out.set(storeyId, entries);
  }
  return out;
}

/**
 * Footprint rings (storey-local metres) of existing `IfcSpace` per storey,
 * so generation can skip only the new rooms that overlap a present space.
 * See `existingSpaceFootprintEntriesByStorey`, which also names each space.
 */
export function existingSpaceFootprintsByStorey(
  store: IfcDataStore,
  overlay?: OverlayWallReader,
): Map<number, Vec2[][]> {
  const out = new Map<number, Vec2[][]>();
  for (const [storeyId, entries] of existingSpaceFootprintEntriesByStorey(store, overlay)) {
    out.set(storeyId, entries.map((e) => e.footprint));
  }
  return out;
}
