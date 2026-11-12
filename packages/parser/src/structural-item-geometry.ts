/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a structural item or activity sits: its topology representation
 * (`IfcVertexPoint`, `IfcEdge` / `IfcEdgeCurve` / `IfcOrientedEdge`, or a face
 * bound) carried through its `ObjectPlacement` chain into IFC world
 * coordinates, in metres, Z up. This is the internal seam of
 * `structural-glyphs.ts`; nothing here knows about glyphs.
 *
 * The geometry pipeline meshes curve members as ribbons along the same edge
 * (`rust/geometry/src/processors/structural_edge.rs`) and does not mesh
 * vertices, so a support or point load has no rendered geometry to sit on.
 * The point read here is the one the ribbon ends at: same placement chain,
 * same `IfcFirstProjAxis` fill (`firstProjAxis`), same length-unit scale.
 * Curved edges are reduced to their two vertices: a glyph needs a station
 * along the member, not the curve.
 *
 * Reads the source bytes. Items created in a session (mutation view only)
 * have no source record and read as `null`: no glyph, rather than a guess.
 */

import { firstProjAxis, walkPlacementChain } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import { EntityExtractor } from './entity-extractor.js';
import { asBoolean, asRef, asRefList, readAttr, unwrapTyped } from './structural-step-values.js';

export type Vec3 = readonly [number, number, number];

/** An orthonormal frame in IFC world axes. */
export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

/** The shape of one item, in IFC world metres. */
export type ItemShape =
  | { kind: 'vertex'; point: Vec3 }
  | { kind: 'edge'; start: Vec3; end: Vec3 }
  /**
   * `surface`: the face's reference surface frame (an `IfcFaceSurface` on an
   * `IfcPlane`, z along its normal and flipped when `SameSense` is false),
   * which sets the local axes of a surface item; absent for a bare `IfcFace`.
   */
  | { kind: 'face'; polygon: Vec3[]; surface?: Frame };

export const IDENTITY: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** `IfcProduct` slots. */
const OBJECT_PLACEMENT = 5;
const REPRESENTATION = 6;
/** Face bounds and edge loops nest this deep at most; a cycle or a long chain of oriented edges stops here. */
const MAX_EDGE_ELEMENT_DEPTH = 16;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export function normalize(a: Vec3): Vec3 | null {
  const l = length(a);
  return l > 1e-12 && Number.isFinite(l) ? scale(a, 1 / l) : null;
}

/** A vector given in `frame`'s axes, in world axes. */
export const rotate = (frame: Frame, v: Vec3): Vec3 =>
  add(add(scale(frame.x, v[0]), scale(frame.y, v[1])), scale(frame.z, v[2]));
/** A point given in `frame`, in world coordinates. */
const apply = (frame: Frame, p: Vec3): Vec3 => add(frame.origin, rotate(frame, p));
/** `outer` after `inner`: `inner` is expressed in `outer`. */
export const compose = (outer: Frame, inner: Frame): Frame => ({
  origin: apply(outer, inner.origin),
  x: rotate(outer, inner.x),
  y: rotate(outer, inner.y),
  z: rotate(outer, inner.z),
});

/**
 * An orthonormal frame with `z` along `axis` and `x` as close to `ref` as the
 * plane normal to `axis` allows (`IfcFirstProjAxis` when `ref` is absent).
 */
export function frameFrom(origin: Vec3, axis: Vec3 | null, ref: Vec3 | null): Frame {
  const z = (axis && normalize(axis)) ?? [0, 0, 1];
  let x = ref ? normalize(sub(ref, scale(z, dot(ref, z)))) : null;
  if (!x) x = firstProjAxis([z[0], z[1], z[2]]);
  const y = cross(z, x);
  return { origin, x, y, z };
}

function triple(value: unknown): Vec3 | null {
  const v = unwrapTyped(value);
  if (!Array.isArray(v) || v.length < 2) return null;
  const n = [v[0], v[1], v.length > 2 ? v[2] : 0].map((c) => unwrapTyped(c));
  return n.every((c) => typeof c === 'number' && Number.isFinite(c)) ? (n as unknown as Vec3) : null;
}

interface Entity {
  type: string;
  attributes: unknown[];
}

/**
 * Reads item geometry from one store. One reader per extraction: the entity
 * cache is shared by every item, since members share their end vertices.
 */
export class ItemGeometryReader {
  private readonly extractor: EntityExtractor;
  private readonly entities = new Map<number, Entity | null>();
  private readonly placements = new Map<number, Frame | null>();
  private readonly unitScale: number;

  constructor(private readonly store: IfcDataStore) {
    this.extractor = new EntityExtractor(store.source);
    const s = store.lengthUnitScale;
    this.unitScale = typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
  }

  private entity(id: number | undefined): Entity | null {
    if (id === undefined) return null;
    const hit = this.entities.get(id);
    if (hit !== undefined) return hit;
    const ref = getEntityRefFromStore(this.store, id);
    const raw = ref ? this.extractor.extractEntity(ref) : null;
    const entity = raw ? { type: String(raw.type).toUpperCase(), attributes: raw.attributes ?? [] } : null;
    this.entities.set(id, entity);
    return entity;
  }

  private point(id: number | undefined): Vec3 | null {
    const e = this.entity(id);
    return e?.type === 'IFCCARTESIANPOINT' ? triple(e.attributes[0]) : null;
  }

  private direction(id: number | undefined): Vec3 | null {
    const e = this.entity(id);
    return e?.type === 'IFCDIRECTION' ? triple(e.attributes[0]) : null;
  }

  /** An `IfcAxis2Placement3D` or `2D` as a frame in its parent's coordinates, unscaled; null when unreadable. */
  axisPlacement(id: number | undefined): Frame | null {
    const e = this.entity(id);
    if (!e) return null;
    const origin = this.point(asRef(e.attributes[0]));
    if (!origin) return null;
    if (e.type === 'IFCAXIS2PLACEMENT3D') {
      return frameFrom(origin, this.direction(asRef(e.attributes[1])), this.direction(asRef(e.attributes[2])));
    }
    if (e.type === 'IFCAXIS2PLACEMENT2D') return frameFrom(origin, null, this.direction(asRef(e.attributes[1])) ?? [1, 0, 0]);
    return null;
  }

  /**
   * The world frame of an `IfcLocalPlacement`, in file length units. Null for
   * a cycle, an unreadable link or another placement kind (grid, linear):
   * a glyph is skipped rather than drawn at a guessed origin.
   */
  private placement(id: number): Frame | null {
    const cached = this.placements.get(id);
    if (cached !== undefined) return cached;
    const chain = walkPlacementChain(id, (link) => {
      const e = this.entity(link);
      return e?.type === 'IFCLOCALPLACEMENT' ? asRef(e.attributes[0]) : undefined;
    });
    let frame: Frame | null = chain.end === 'cycle' ? null : IDENTITY;
    // Root first, so each link composes into its parent.
    for (const link of [...chain.ids].reverse()) {
      if (!frame) break;
      const e = this.entity(link);
      const local = e?.type === 'IFCLOCALPLACEMENT' ? this.axisPlacement(asRef(e.attributes[1])) : null;
      frame = local ? compose(frame, local) : null;
    }
    this.placements.set(id, frame);
    return frame;
  }

  /** A product's placement frame in file units; identity when it has none (`$`). */
  productFrame(productId: number): Frame | null {
    const product = this.entity(productId);
    if (!product) return null;
    const placementId = asRef(product.attributes[OBJECT_PLACEMENT]);
    return placementId === undefined ? IDENTITY : this.placement(placementId);
  }

  /**
   * An `IfcStructuralAnalysisModel`'s `SharedPlacement` in world axes:
   * undefined when it has none (IFC2X3 has no such attribute), null when it
   * is set but cannot be read.
   */
  sharedPlacementFrame(modelId: number): Frame | null | undefined {
    const model = this.entity(modelId);
    const ref = model ? asRef(readAttr('IfcStructuralAnalysisModel', model.attributes, 'SharedPlacement', this.store.schemaVersion)) : undefined;
    return ref === undefined ? undefined : this.placement(ref);
  }

  /** A file length (e.g. a load configuration's `Locations`) in metres. */
  metres(value: number): number {
    return value * this.unitScale;
  }

  /** An `IfcDirection` in a product's placement axes, in world axes; null when either is unreadable. */
  productDirection(productId: number, directionId: number | undefined): Vec3 | null {
    const frame = this.productFrame(productId);
    const d = this.direction(directionId);
    return frame && d ? normalize(rotate(frame, d)) : null;
  }

  /** The product's topology shape in IFC world metres, or null when it has none this reader can place. */
  shape(productId: number): ItemShape | null {
    const product = this.entity(productId);
    const frame = this.productFrame(productId);
    if (!product || !frame) return null;
    const shapeDef = this.entity(asRef(product.attributes[REPRESENTATION]));
    // IFC2X3 exporters (Axis) reference the supertype `IfcProductRepresentation` directly.
    if (shapeDef?.type !== 'IFCPRODUCTDEFINITIONSHAPE' && shapeDef?.type !== 'IFCPRODUCTREPRESENTATION') return null;
    const toWorld = (p: Vec3): Vec3 => scale(apply(frame, p), this.unitScale);
    for (const repId of asRefList(shapeDef.attributes[2])) {
      const rep = this.entity(repId);
      if (rep?.type !== 'IFCTOPOLOGYREPRESENTATION') continue;
      for (const itemId of asRefList(rep.attributes[3])) {
        const local = this.topologyItem(itemId);
        if (!local) continue;
        if (local.kind === 'vertex') return { kind: 'vertex', point: toWorld(local.point) };
        if (local.kind === 'edge') return { kind: 'edge', start: toWorld(local.start), end: toWorld(local.end) };
        const surface = local.surface && { ...compose(frame, local.surface), origin: toWorld(local.surface.origin) };
        return { kind: 'face', polygon: local.polygon.map(toWorld), ...(surface ? { surface } : {}) };
      }
    }
    return null;
  }

  /**
   * A point item's position: its vertex, or the origin of its own
   * `ObjectPlacement` when it has a placement but no representation (the
   * placement is then the only statement of where it is).
   */
  pointShape(productId: number): ItemShape | null {
    const shape = this.shape(productId);
    if (shape) return shape;
    const origin = this.placementOrigin(productId);
    return origin && { kind: 'vertex', point: origin };
  }

  /** The origin of a product's own `ObjectPlacement` in world metres; null when it has none. */
  private placementOrigin(productId: number): Vec3 | null {
    if (asRef(this.entity(productId)?.attributes[OBJECT_PLACEMENT]) === undefined) return null;
    const frame = this.productFrame(productId);
    return frame && scale(frame.origin, this.unitScale);
  }

  private vertex(id: number | undefined): Vec3 | null {
    const e = this.entity(id);
    return e?.type === 'IFCVERTEXPOINT' ? this.point(asRef(e.attributes[0])) : null;
  }

  /** An edge's two vertices in edge direction; oriented edges follow `EdgeElement`, flipped when `Orientation` is false. */
  private edge(id: number | undefined, depth = 0): [Vec3, Vec3] | null {
    const e = this.entity(id);
    if (!e || depth > MAX_EDGE_ELEMENT_DEPTH) return null;
    if (e.type === 'IFCORIENTEDEDGE') {
      const inner = this.edge(asRef(e.attributes[2]), depth + 1);
      const forward = asBoolean(e.attributes[3]) !== false;
      return inner && (forward ? inner : [inner[1], inner[0]]);
    }
    if (e.type !== 'IFCEDGE' && e.type !== 'IFCEDGECURVE' && e.type !== 'IFCSUBEDGE') return null;
    const start = this.vertex(asRef(e.attributes[0]));
    const end = this.vertex(asRef(e.attributes[1]));
    return start && end ? [start, end] : null;
  }

  /** An `IfcPlane`'s position in file units, z flipped when the face runs against it; null for another surface. */
  private planeFrame(id: number | undefined, sameSense: boolean): Frame | null {
    const plane = this.entity(id);
    const frame = plane?.type === 'IFCPLANE' ? this.axisPlacement(asRef(plane.attributes[0])) : null;
    if (!frame || sameSense) return frame;
    return { origin: frame.origin, x: frame.x, y: scale(frame.y, -1), z: scale(frame.z, -1) };
  }

  /** The outer (else first) bound of a face as a polygon. */
  private face(e: Entity): Vec3[] | null {
    const bounds = asRefList(e.attributes[0]).map((id) => this.entity(id));
    const bound = bounds.find((b) => b?.type === 'IFCFACEOUTERBOUND') ?? bounds.find((b) => b?.type === 'IFCFACEBOUND');
    const loop = this.entity(asRef(bound?.attributes[0]));
    if (!loop) return null;
    let polygon: Vec3[] = [];
    if (loop.type === 'IFCPOLYLOOP') {
      polygon = asRefList(loop.attributes[0]).map((id) => this.point(id)).filter((p): p is Vec3 => !!p);
    } else if (loop.type === 'IFCEDGELOOP') {
      for (const edgeId of asRefList(loop.attributes[0])) {
        const edge = this.edge(edgeId);
        if (edge) polygon.push(edge[0]);
      }
    }
    return polygon.length >= 3 ? polygon : null;
  }

  private topologyItem(id: number): ItemShape | null {
    const e = this.entity(id);
    if (!e) return null;
    if (e.type === 'IFCVERTEXPOINT') {
      const point = this.vertex(id);
      return point && { kind: 'vertex', point };
    }
    if (e.type === 'IFCFACESURFACE' || e.type === 'IFCFACE') {
      const polygon = this.face(e);
      const surface = e.type === 'IFCFACESURFACE' ? this.planeFrame(asRef(e.attributes[1]), asBoolean(e.attributes[2]) !== false) : null;
      return polygon && { kind: 'face', polygon, ...(surface ? { surface } : {}) };
    }
    const edge = this.edge(id);
    return edge && { kind: 'edge', start: edge[0], end: edge[1] };
  }
}
