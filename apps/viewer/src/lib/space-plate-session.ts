/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SpacePlateSession` — the owner of the persistent `SpacePlateHandle` and its
 * editing lifecycle.
 *
 * The wasm handle owns Rust-side `Vec`s on the shared dlmalloc heap, so it must
 * be freed deterministically (never via JS GC — a long-lived handle that
 * outlives its frees corrupts the heap). Centralising that discipline here keeps
 * the React layer from ever touching `.duplicate()` / `.free()` directly, and
 * collapses the ~6 copies of the `duplicate → try → commit / catch → free →
 * restore` pattern into one `edit()`.
 *
 * - **Mutations** go through `edit(fn)`: snapshot the plate, run `fn`, push the
 *   snapshot onto the undo stack on success (clearing redo), or roll back to it
 *   and rethrow on failure (so the caller reads the typed `editError`).
 * - **Drags** go through `beginDrag` / `dragTo` / `commitDrag` / `cancelDrag`:
 *   one pre-drag snapshot, live mutation, commit on drop or restore on cancel.
 * - **Reads** go through the typed query methods; the raw handle is never
 *   exposed, so a mutation can't sneak past the undo machinery.
 */

import init, { SpacePlateHandle } from '@ifc-lite/wasm';

export interface Room {
  face: number;
  area: number;
  simple: boolean;
  outline: [number, number][];
}

export interface Boundary {
  edge: number;
  source: number | null;
}

/** Undo depth — bounded so a long session can't grow the heap unboundedly. */
export const MAX_UNDO = 40;

let wasmReady: Promise<void> | null = null;
/** Initialise the wasm module once (idempotent). */
export function ensureSpaceWasm(): Promise<void> {
  if (!wasmReady) wasmReady = init().then(() => undefined);
  return wasmReady;
}

/** Half-thickness (m) per wall segment, parallel to the coords/sources arrays;
 *  carried onto derived edges so net/gross outlines can be queried. Empty = none. */
export type Thicknesses = Float64Array;

/** Build a plate from flat wall segments. With `manualTol` null, escalate the
 *  corner-snap tolerance until one encloses rooms (real centrelines miss corners
 *  by ~½ a wall thickness, so a tight snap leaves the loop open → 0 rooms). */
function buildHandle(
  coords: Float64Array,
  sources: Int32Array,
  thicknesses: Thicknesses,
  manualTol: number | null,
  minArea: number,
): { handle: SpacePlateHandle; tol: number } {
  if (manualTol != null) {
    return { handle: new SpacePlateHandle(coords, sources, thicknesses, manualTol, minArea), tol: manualTol };
  }
  let handle: SpacePlateHandle | null = null;
  let tol = 0.1;
  for (const t of [0.1, 0.25, 0.5]) {
    const p = new SpacePlateHandle(coords, sources, thicknesses, t, minArea);
    handle?.free();
    handle = p;
    tol = t;
    if (p.roomCount > 0) break;
  }
  return { handle: handle!, tol };
}

/** One room from a throwaway-plate snapshot: its centreline outline + the outline
 *  at the requested wall boundary (net/gross/centre). */
export interface RoomWithBoundary {
  outline: [number, number][];
  boundary: [number, number][];
}

function flatToPts(flat: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

/** Flatten N wall rectangles ([[x,y]×4] each, CCW) into the `8·N` float array
 *  `fromWallRects` expects (4 corners × 2 coords per wall, wall-major). */
export function flattenWallRects(rects: ([number, number][])[]): Float64Array {
  const flat = new Float64Array(rects.length * 8);
  rects.forEach((r, w) => {
    for (let c = 0; c < 4; c++) {
      flat[w * 8 + c * 2] = r[c][0];
      flat[w * 8 + c * 2 + 1] = r[c][1];
    }
  });
  return flat;
}

/** Build a throwaway plate, read each room's centreline + boundary outline at
 *  `boundary` mode, and free it — for paths (whole-building bake) that need a
 *  storey's rooms without a live session. */
export function snapshotRooms(
  coords: Float64Array,
  sources: Int32Array,
  thicknesses: Thicknesses,
  boundary: 'center' | 'inner' | 'outer',
  minArea = 0.5,
): RoomWithBoundary[] {
  const { handle } = buildHandle(coords, sources, thicknesses, null, minArea);
  const rooms = handle.snapshot() as Room[];
  const out = rooms.map((r) => ({
    outline: r.outline,
    boundary: boundary === 'center' ? r.outline : flatToPts(handle.netOutline(r.face, boundary === 'inner')),
  }));
  handle.free();
  return out;
}

/** Face-based whole-building bake: build a throwaway plate from wall RECTANGLES.
 *  `fromWallRects` returns a centreline plate whose room outline IS the wall axis
 *  (the gross-area basis), so the boundary at the chosen mode is the axis itself
 *  (`center`) or `net_outline` inset/outset to the inner (net) / outer (gross)
 *  face. Frees the plate. */
export function snapshotRoomsFromRects(
  rectCoords: Float64Array,
  boundary: 'center' | 'inner' | 'outer',
  snapTolerance = 0.05,
  minArea = 0.3,
): RoomWithBoundary[] {
  const handle = SpacePlateHandle.fromWallRects(rectCoords, snapTolerance, minArea);
  const rooms = handle.snapshot() as Room[];
  const out = rooms.map((r) => ({
    outline: r.outline, // the wall axis (centreline) — gross-area basis
    boundary: boundary === 'center' ? r.outline : flatToPts(handle.netOutline(r.face, boundary === 'inner')),
  }));
  handle.free();
  return out;
}

export class SpacePlateSession {
  private handle: SpacePlateHandle | null = null;
  private undoStack: SpacePlateHandle[] = [];
  private redoStack: SpacePlateHandle[] = [];
  /** Pre-drag snapshot held for the duration of a live drag. */
  private pending: SpacePlateHandle | null = null;
  /** True once the plate has been edited since the last build/bake-clear. */
  dirty = false;

  /** Adopt an already-built handle (no history). For tests / direct seeding;
   *  normal use goes through `build`. */
  static fromHandle(handle: SpacePlateHandle): SpacePlateSession {
    const s = new SpacePlateSession();
    s.handle = handle;
    return s;
  }

  get alive(): boolean { return this.handle != null; }
  get roomCount(): number { return this.handle?.roomCount ?? 0; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** Build a fresh plate, replacing the current one and clearing all history.
   *  Resets `dirty` (a fresh derive is the new clean baseline). */
  build(coords: Float64Array, sources: Int32Array, thicknesses: Thicknesses, manualTol: number | null, minArea = 0.5): { rooms: Room[]; tol: number } {
    const { handle, tol } = buildHandle(coords, sources, thicknesses, manualTol, minArea);
    this.discardPending();
    this.disposeHandle();
    this.clearHistory();
    this.handle = handle;
    this.dirty = false;
    return { rooms: this.rooms(), tol };
  }

  /** Build a plate from wall RECTANGLES (each wall's 4 footprint corners,
   *  wall-major, `8·N` floats — see `flattenWallRects`). Rooms are detected as the
   *  bounded gaps between the rectangles (boundary literally on the wall faces, no
   *  centroid bias), then LIFTED to the wall axis: the returned plate is a normal
   *  centreline plate whose room outlines ARE the wall axes and whose vertices ARE
   *  the displayed nodes — so editing (drag / split / merge) acts directly on what
   *  the user sees. `net_outline` recovers the inner (net) / outer (gross) faces.
   *  Replaces the current plate and clears history. */
  buildFromRects(rectCoords: Float64Array, snapTolerance = 0.05, minArea = 0.3): { rooms: Room[] } {
    const handle = SpacePlateHandle.fromWallRects(rectCoords, snapTolerance, minArea);
    this.discardPending();
    this.disposeHandle();
    this.clearHistory();
    this.handle = handle;
    this.dirty = false;
    return { rooms: this.rooms() };
  }

  // ───────────────────────────── reads ─────────────────────────────

  rooms(): Room[] { return this.handle ? (this.handle.snapshot() as Room[]) : []; }

  /** A room's outline at the chosen wall boundary: the centreline / wall axis
   *  (`center`), the net inner face (`inner`), or the gross outer face (`outer`). */
  boundaryOutline(face: number, boundary: 'center' | 'inner' | 'outer'): [number, number][] {
    if (!this.handle || boundary === 'center') {
      const room = this.rooms().find((r) => r.face === face);
      return room ? room.outline : [];
    }
    return flatToPts(this.handle.netOutline(face, boundary === 'inner'));
  }

  neighborAcross(edge: number): number | undefined { return this.handle?.neighborAcross(edge); }
  boundingElements(face: number): Boundary[] {
    return this.handle ? (this.handle.boundingElements(face) as Boundary[]) : [];
  }
  findVertexNear(x: number, y: number, tol: number): number | null {
    const v = this.handle?.findVertexNear(x, y, tol);
    return v === undefined ? null : v;
  }

  // ─────────────────────────── mutations ───────────────────────────

  /**
   * Run a mutation against the live plate, with undo/rollback handled here.
   * On success the pre-edit snapshot is pushed to the undo stack and `dirty` is
   * set; on a thrown rejection the plate is rolled back to the snapshot and the
   * error is rethrown. `shouldCommit` lets an op that reports "nothing changed"
   * (e.g. `prune` returning 0) skip the undo entry without leaving a dangling
   * snapshot.
   */
  edit<T>(fn: (h: SpacePlateHandle) => T, shouldCommit: (result: T) => boolean = () => true): T {
    const h = this.require();
    const snap = h.duplicate();
    let result: T;
    try {
      result = fn(h);
    } catch (e) {
      h.free();
      this.handle = snap; // restore the pre-edit state
      throw e;
    }
    if (shouldCommit(result)) {
      this.pushUndo(snap);
      this.dirty = true;
    } else {
      snap.free(); // no change — discard the snapshot, keep the (unchanged) plate
    }
    return result;
  }

  // ─────────────────────────── dragging ────────────────────────────

  /** Begin a live drag: snapshot the current plate. Returns false if no plate. */
  beginDrag(): boolean {
    if (!this.handle) return false;
    this.discardPending();
    this.pending = this.handle.duplicate();
    return true;
  }

  /** Apply a live drag step to vertex `v`. Swallows a torn-down-plate throw
   *  (the handle can be freed mid-drag by a rebuild). */
  dragTo(v: number, x: number, y: number): void {
    try {
      this.handle?.dragVertex(v, x, y);
    } catch (e) {
      console.debug('[space-sketch] dragVertex failed (plate torn down mid-drag?)', e);
    }
  }

  /** Commit a drag: push the pre-drag snapshot onto the undo stack. */
  commitDrag(): void {
    if (!this.pending) return;
    this.pushUndo(this.pending);
    this.pending = null;
    this.dirty = true;
  }

  /** Cancel a drag: restore the plate to its pre-drag snapshot. */
  cancelDrag(): void {
    if (this.pending && this.handle) {
      this.handle.free();
      this.handle = this.pending;
      this.pending = null;
    }
  }

  // ────────────────────────── undo / redo ──────────────────────────

  undo(): boolean {
    if (!this.handle || !this.undoStack.length) return false;
    this.redoStack.push(this.handle);
    this.handle = this.undoStack.pop()!;
    return true;
  }

  redo(): boolean {
    if (!this.handle || !this.redoStack.length) return false;
    this.undoStack.push(this.handle);
    this.handle = this.redoStack.pop()!;
    return true;
  }

  /** Free every handle the session owns (current, history, pending). */
  dispose(): void {
    this.discardPending();
    this.clearHistory();
    this.disposeHandle();
  }

  // ───────────────────────────── internal ─────────────────────────────

  private require(): SpacePlateHandle {
    if (!this.handle) throw new Error('StaleHandle');
    return this.handle;
  }

  private pushUndo(snap: SpacePlateHandle): void {
    this.undoStack.push(snap);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()!.free();
    this.redoStack.forEach((h) => h.free());
    this.redoStack = [];
  }

  private discardPending(): void {
    this.pending?.free();
    this.pending = null;
  }

  private clearHistory(): void {
    this.undoStack.forEach((h) => h.free());
    this.redoStack.forEach((h) => h.free());
    this.undoStack = [];
    this.redoStack = [];
  }

  private disposeHandle(): void {
    this.handle?.free();
    this.handle = null;
  }
}
