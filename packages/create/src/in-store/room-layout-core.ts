/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Shared native DCEL reads and edit policy for the Room command (#6232 D5).
 * The host supplies the actual WASM plate; this module owns no runtime heap. */
import { polygonArea } from './room-footprint-offset.js';

export type Pt = [number, number];
export interface Room { face: number; area: number; simple: boolean; outline: Pt[] }
export interface Boundary { edge: number; source: number | null }

/** Structural contract implemented by the canonical Rust SpacePlateHandle. */
export interface RoomPlate {
  snapshot(): unknown;
  netOutline(face: number, inset: boolean): Float64Array;
  boundingElements(face: number): unknown;
  findVertexNear(x: number, y: number, tol: number): number | undefined;
  splitEdge(edge: number, x: number, y: number): number;
  splitFace(face: number, a: number, b: number, source: number): unknown;
  dragVertex(vertex: number, x: number, y: number): unknown;
  dissolveVertex(vertex: number): unknown;
  neighborAcross(edge: number): number | undefined;
  roomIds(): Uint32Array;
  mergeFaces(edge: number): unknown;
  removeEdge(edge: number): unknown;
  prune(): number;
  duplicate(): RoomPlate;
  free(): void;
}

const errorMessage = (error: unknown): string => error instanceof Error
  ? error.message || error.name || 'Edit failed'
  : String(error).replace(/^\w+:\s*/, '');

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** One face of the layout: its wall-axis outline and the two wall-face outlines. */
export interface LayoutFace {
  face: number;
  centre: Pt[];
  inner: Pt[];
  outer: Pt[];
}

/** A layout topology edit, by position (re-resolved on the plate it runs on). */
type At = readonly [number, number];
export type LayoutOp =
  | { kind: 'drag'; from: At; to: At }
  | { kind: 'split'; a: At; b: At }
  | { kind: 'remove'; at: At }
  | { kind: 'prune' };

const pts = (flat: Float64Array): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

/** Every room face of `plate`, with its wall-axis, inner and outer outlines. */
export function readFaces(plate: RoomPlate): LayoutFace[] {
  return (plate.snapshot() as Room[]).map((r) => ({
    face: r.face,
    centre: r.outline,
    inner: pts(plate.netOutline(r.face, true)),
    outer: pts(plate.netOutline(r.face, false)),
  }));
}

/** Creation cutoff filters reads without discarding a retained edited plate. */
export function filterRoomFaces(faces: readonly LayoutFace[], minArea: number): LayoutFace[] {
  return faces.filter((face) => Math.min(polygonArea(face.inner.length >= 3 ? face.inner : face.centre), polygonArea(face.centre)) >= minArea);
}

const EPS = 1e-6;
const same = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;

/** The layout edge nearest `p` within `tol`: its half-edge id and the face on this side. */
function edgeAt(h: RoomPlate, p: At, tol: number): { edge: number; face: number; a: Pt; b: Pt } | null {
  let best: { edge: number; face: number; a: Pt; b: Pt; d: number } | null = null;
  for (const r of h.snapshot() as Room[]) {
    const bounds = h.boundingElements(r.face) as Boundary[];
    const n = r.outline.length;
    for (let i = 0; i < n; i++) {
      const a = r.outline[i], b = r.outline[(i + 1) % n];
      const d = distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]);
      if (bounds[i] && d <= tol && (!best || d < best.d)) best = { edge: bounds[i].edge, face: r.face, a, b, d };
    }
  }
  return best;
}

/** Project `p` onto segment a→b. */
function onSegment(p: At, a: Pt, b: Pt): Pt {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1e-12)));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** A cut end: an existing node, else a new node on the wall edge there. */
function cutNode(h: RoomPlate, p: At, tol: number): { v: number; at: Pt } {
  const v = h.findVertexNear(p[0], p[1], tol);
  if (v !== undefined) {
    const room = (h.snapshot() as Room[]).flatMap((r) => r.outline).find((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol);
    return { v, at: room ?? [p[0], p[1]] };
  }
  const e = edgeAt(h, p, tol);
  if (!e) throw new Error('pick the cut ends on the room outline');
  const at = onSegment(p, e.a, e.b);
  return { v: h.splitEdge(e.edge, at[0], at[1]), at };
}

/**
 * Run `op` on `h` (the Edit gestures, as plate calls). Throws the
 * engine's refusal (`editError` reads it). Returns false when nothing changed.
 */
export function applyLayoutOp(h: RoomPlate, op: LayoutOp, tol: number): boolean {
  switch (op.kind) {
    case 'prune':
      return h.prune() > 0;
    case 'drag': {
      const v = h.findVertexNear(op.from[0], op.from[1], tol);
      if (v === undefined) throw new Error('no room corner here');
      h.dragVertex(v, op.to[0], op.to[1]);
      return true;
    }
    case 'split': {
      // Insert any new node on a wall edge, then cut the room both ends bound.
      const a = cutNode(h, op.a, tol);
      const b = cutNode(h, op.b, tol);
      if (a.v === b.v) throw new Error('the two cut points are the same');
      const onBoundary = (r: Room, p: Pt) => r.outline.some((q) => same(q, p));
      const room = (h.snapshot() as Room[]).find((r) => onBoundary(r, a.at) && onBoundary(r, b.at));
      if (!room) throw new Error('the two points are not on the same room');
      h.splitFace(room.face, a.v, b.v, -1);
      return true;
    }
    case 'remove': {
      const v = h.findVertexNear(op.at[0], op.at[1], tol);
      if (v !== undefined) {
        // A corner between two walls dissolves; a wall junction won't, so remove one of its walls.
        try {
          h.dissolveVertex(v);
          return true;
        } catch (dissolveError) {
          const reason = errorMessage(dissolveError);
          for (const r of h.snapshot() as Room[]) {
            const k = r.outline.findIndex((q) => Math.hypot(q[0] - op.at[0], q[1] - op.at[1]) <= tol);
            if (k < 0) continue;
            const bounds = h.boundingElements(r.face) as Boundary[];
            for (const idx of [k, (k - 1 + r.outline.length) % r.outline.length]) {
              const b = bounds[idx];
              if (!b) continue;
              try { removeEdge(h, b.edge); return true; } catch (error) { console.debug('[room.place] enclosing wall retained', errorMessage(error)); }
            }
          }
          throw new Error(`no wall here separates two rooms (${reason})`);
        }
      }
      const e = edgeAt(h, op.at, tol);
      if (!e) throw new Error('no room edge here');
      removeEdge(h, e.edge);
      return true;
    }
  }
}

/** Merge the two rooms an edge separates, or delete a bridge / spur wall and its orphans. */
function removeEdge(h: RoomPlate, edge: number): void {
  const across = h.neighborAcross(edge);
  const rooms = new Set(h.roomIds());
  const own = (h.snapshot() as Room[]).find((r) => (h.boundingElements(r.face) as Boundary[]).some((b) => b.edge === edge))?.face;
  if (across !== undefined && own !== undefined && across !== own && rooms.has(across)) h.mergeFaces(edge);
  else h.removeEdge(edge);
}

/** Factory supplied by the canonical WASM runtime, already initialised by its host. */
export interface RoomPlateFactory {
  fromWallRects(rectangles: Float64Array, weld: number, minArea: number): RoomPlate;
}

export function flattenRoomRects(rects: readonly (readonly Pt[])[]): Float64Array {
  const flat = new Float64Array(rects.length * 8);
  rects.forEach((r, w) => r.slice(0, 4).forEach((p, c) => { flat[w * 8 + c * 2] = p[0]; flat[w * 8 + c * 2 + 1] = p[1]; }));
  return flat;
}
