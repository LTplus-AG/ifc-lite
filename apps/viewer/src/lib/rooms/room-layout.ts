/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Room tool's editable room layout per storey (charter #6232 M4): the
 * wasm DCEL (`SpacePlateHandle.fromWallRects`) built from the storey's walls,
 * which the tool's Edit mode reshapes with the plate's own topology ops —
 * the ones the tool drives (`dragVertex`, `splitEdge` + `splitFace`,
 * `mergeFaces`, `removeEdge`, `dissolveVertex`, `prune`).
 *
 * The model is the truth; the layout follows it. An edit writes the rooms it
 * touches through the command's transaction (one undo step), and the edited
 * plate is filed under the model's undo head AFTER that step. Undo moves the
 * head back, so the layout filed under the earlier head (never mutated: every
 * edit works on a copy) is the one read; redo brings the edited one back,
 * because redo restores the same mutation ids. A head with no layout filed
 * (the tool made a room, or anything else changed the model) carries the
 * layout last used on to it, so a rename does not lose a split; a change of
 * the walls themselves builds a fresh one, as does another weld tolerance.
 *
 * Every plate is a wasm handle on the shared heap and is freed here
 * deterministically: on eviction (a bounded history per storey), when
 * replaced, and in `clearRoomLayouts`.
 */

import { SpacePlateHandle } from '@ifc-lite/wasm';
import { DEFAULT_ROOM_CREATION } from './room-creation-options';
import type { ViewerState } from '@/store';
import { editError } from '@/lib/space-edit-error';
import { distToSeg, polyArea, type Pt } from '@/lib/rooms/plate-geometry';
import type { Room, Boundary } from '@/lib/rooms/space-wasm';

/** Default corner weld (m): rectangle corners closer than this are one node. */
export const DEFAULT_WELD = 0.05;
/** Faces smaller than this (m²) are slivers, not rooms. */
export const DEFAULT_MIN_AREA = DEFAULT_ROOM_CREATION.minArea;
/** Layouts kept per storey and weld: the undo depth the layout can follow. */
const MAX_HISTORY = 40;

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

interface Entry {
  walls: string;
  plate: SpacePlateHandle;
  faces: LayoutFace[] | null;
}

interface Scope {
  entries: Map<string, Entry>;
  /** The layout read last: the one a new undo step carries on. */
  last: Entry | null;
}

const scopes = new Map<string, Scope>();
/** Bumped whenever a layout is filed, so a reader's cache can tell. */
let version = 0;

/** The layouts' version: changes when an edit files a layout (even one that wrote nothing to the model). */
export function layoutVersion(): number {
  return version;
}

/** The model's undo head: which edit the model is at (redo restores the same ids). */
export function undoHead(s: ViewerState, modelId: string): string {
  const stack = s.undoStacks.get(modelId) ?? [];
  return `${stack.length}:${stack.at(-1)?.id ?? ''}`;
}

/** Wall rectangles → the `8·N` floats `fromWallRects` takes. */
export function flattenRects(rects: readonly (readonly Pt[])[]): Float64Array {
  const flat = new Float64Array(rects.length * 8);
  rects.forEach((r, w) => r.slice(0, 4).forEach((p, c) => { flat[w * 8 + c * 2] = p[0]; flat[w * 8 + c * 2 + 1] = p[1]; }));
  return flat;
}

/** The walls a layout was built from, to the millimetre. */
export function wallsSignature(rects: readonly (readonly Pt[])[]): string {
  return rects.map((r) => r.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(';')).join('|');
}

const scopeKey = (modelId: string, storeyId: number, weld: number) => `${modelId}|${storeyId}|${weld}`;

function freeEntry(entry: Entry | undefined): void {
  entry?.plate.free();
}

/** A fresh plate from the walls (the caller owns it). */
export function buildPlate(rects: readonly (readonly Pt[])[], weld: number, minArea = DEFAULT_MIN_AREA): SpacePlateHandle {
  return SpacePlateHandle.fromWallRects(flattenRects(rects), weld, minArea);
}

const pts = (flat: Float64Array): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

/** Every room face of `plate`, with its wall-axis, inner and outer outlines. */
export function readFaces(plate: SpacePlateHandle): LayoutFace[] {
  return (plate.snapshot() as Room[]).map((r) => ({
    face: r.face,
    centre: r.outline,
    inner: pts(plate.netOutline(r.face, true)),
    outer: pts(plate.netOutline(r.face, false)),
  }));
}

function scopeOf(modelId: string, storeyId: number, weld: number): Scope {
  const key = scopeKey(modelId, storeyId, weld);
  return scopes.get(key) ?? scopes.set(key, { entries: new Map(), last: null }).get(key)!;
}

function drop(scope: Scope, head: string): void {
  const entry = scope.entries.get(head);
  if (!entry) return;
  if (scope.last === entry) scope.last = null;
  freeEntry(entry);
  scope.entries.delete(head);
}

function file(scope: Scope, head: string, entry: Entry): void {
  if (scope.entries.get(head) !== entry) drop(scope, head);
  scope.entries.delete(head);
  scope.entries.set(head, entry);
  scope.last = entry;
  version++;
  while (scope.entries.size > MAX_HISTORY) drop(scope, scope.entries.keys().next().value!);
}

/**
 * The storey's layout faces at the model's current undo head, building it
 * from `rects` (storey-local wall rectangles) when none is filed or the walls
 * changed under it.
 */
export function layoutFaces(s: ViewerState, modelId: string, storeyId: number, weld: number, rects: readonly (readonly Pt[])[], minArea = DEFAULT_MIN_AREA): LayoutFace[] {
  return layoutEntry(s, modelId, storeyId, weld, rects).faces!.filter((face) =>
    // The original two-stage build applied the cutoff to both the inner
    // gap and lifted axis face. Preserve that area contract on retained reads.
    Math.min(polyArea(face.inner.length >= 3 ? face.inner : face.centre), polyArea(face.centre)) >= minArea);
}

function layoutEntry(s: ViewerState, modelId: string, storeyId: number, weld: number, rects: readonly (readonly Pt[])[]): Entry {
  const scope = scopeOf(modelId, storeyId, weld);
  const head = undoHead(s, modelId);
  const walls = wallsSignature(rects);
  let entry = scope.entries.get(head);
  if (!entry || entry.walls !== walls) {
    const carried = scope.last && scope.last.walls === walls ? scope.last : null;
    // Retain all bounded faces in the editable topology. Minimum creation
    // area filters reads; changing it must never replace a user's DCEL edits.
    // The WASM binding treats zero as "use default", so pass its smallest
    // positive f64 value to retain every geometrically valid bounded face.
    entry = { walls, plate: carried ? carried.plate.duplicate() : buildPlate(rects, weld, Number.MIN_VALUE), faces: carried?.faces ?? null };
    file(scope, head, entry);
  }
  scope.last = entry;
  entry.faces ??= readFaces(entry.plate);
  return entry;
}

/** An edited copy of the storey's current layout, and its faces; the caller files or frees it. */
export function editedLayout(
  s: ViewerState, modelId: string, storeyId: number, weld: number, rects: readonly (readonly Pt[])[], op: LayoutOp, tol: number,
): { plate: SpacePlateHandle; walls: string; faces: LayoutFace[]; changed: boolean } {
  const entry = layoutEntry(s, modelId, storeyId, weld, rects);
  const plate = entry.plate.duplicate();
  try {
    const changed = applyLayoutOp(plate, op, tol);
    return { plate, walls: entry.walls, faces: readFaces(plate), changed };
  } catch (error) {
    plate.free();
    throw error;
  }
}

/** File `plate` as the storey's layout at the model's current undo head (after the edit's transaction). */
export function fileLayout(s: ViewerState, modelId: string, storeyId: number, weld: number, walls: string, plate: SpacePlateHandle): void {
  file(scopeOf(modelId, storeyId, weld), undoHead(s, modelId), { walls, plate, faces: null });
}

/** Free the layouts of one model (removed, or reloaded under the same id: its walls and undo head start over). */
export function clearModelLayouts(modelId: string): void {
  for (const [key, scope] of scopes) {
    if (!key.startsWith(`${modelId}|`)) continue;
    for (const entry of scope.entries.values()) freeEntry(entry);
    scopes.delete(key);
  }
  version++;
}

/** Free every layout (tests; a reloaded model). */
export function clearRoomLayouts(): void {
  for (const scope of scopes.values()) for (const entry of scope.entries.values()) freeEntry(entry);
  scopes.clear();
}

const EPS = 1e-6;
const same = (p: Pt, q: Pt) => Math.abs(p[0] - q[0]) < EPS && Math.abs(p[1] - q[1]) < EPS;

/** The layout edge nearest `p` within `tol`: its half-edge id and the face on this side. */
function edgeAt(h: SpacePlateHandle, p: At, tol: number): { edge: number; face: number; a: Pt; b: Pt } | null {
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
function cutNode(h: SpacePlateHandle, p: At, tol: number): { v: number; at: Pt } {
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
export function applyLayoutOp(h: SpacePlateHandle, op: LayoutOp, tol: number): boolean {
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
          const reason = editError(dissolveError).message;
          for (const r of h.snapshot() as Room[]) {
            const k = r.outline.findIndex((q) => Math.hypot(q[0] - op.at[0], q[1] - op.at[1]) <= tol);
            if (k < 0) continue;
            const bounds = h.boundingElements(r.face) as Boundary[];
            for (const idx of [k, (k - 1 + r.outline.length) % r.outline.length]) {
              const b = bounds[idx];
              if (!b) continue;
              try { removeEdge(h, b.edge); return true; } catch (error) { console.debug('[room.place] enclosing wall retained', editError(error).message); }
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
function removeEdge(h: SpacePlateHandle, edge: number): void {
  const across = h.neighborAcross(edge);
  const rooms = new Set(h.roomIds());
  const own = (h.snapshot() as Room[]).find((r) => (h.boundingElements(r.face) as Boundary[]).some((b) => b.edge === edge))?.face;
  if (across !== undefined && own !== undefined && across !== own && rooms.has(across)) h.mergeFaces(edge);
  else h.removeEdge(edge);
}
