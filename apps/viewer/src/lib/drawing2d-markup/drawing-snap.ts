/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Object snapping over a generated `Drawing2D`, built on the vendored
 * drafting core (`lib/drafting-core`, `SnapIndex` + `findSnap`).
 *
 * The drawing becomes a list of `DraftShape`s: every cut polygon's outer
 * ring and holes as closed polylines, and every drawn line as a line. A
 * parallel list maps each shape back to its `{ entityId, modelIndex }`, so a
 * snap can name the element it landed on. Collinear pieces of one entity's
 * face are joined first (`drawing-snap-merge.ts`), so a generator split is
 * never offered as an endpoint and a midpoint is the face's true midpoint.
 *
 * Lines are taken as the 2D canvas draws them: `cut` lines that
 * `isPolygonCutLine` marks are triangulation edges of polygons already
 * indexed through their outlines and are skipped, and hidden lines are left
 * out unless asked for. Non-finite coordinates are skipped.
 *
 * The index is built on the first query and memoised per `Drawing2D` object
 * (a new drawing is a new object), so moving the cursor costs a grid lookup.
 */

import { isPolygonCutLine, type Drawing2D } from '@ifc-lite/drawing-2d';
import { nearestOnShape, shapeKeyPoints } from '../drafting-core/curves';
import { findSnap, SnapIndex } from '../drafting-core/snaps';
import type { DraftShape, Pt, SnapMode } from '../drafting-core/types';
import { mergeCollinearSegments, simplifyRing, VertexOwners, VERTEX_TOLERANCE } from './drawing-snap-merge';

/** The drawing element a snap shape came from. */
export interface DrawingSnapSource {
  entityId: number;
  modelIndex: number;
}

export interface DrawingSnapShapes {
  shapes: readonly DraftShape[];
  /** `sources[i]` is the element `shapes[i]` came from. */
  sources: readonly DrawingSnapSource[];
}

export interface DrawingSnapIndex extends DrawingSnapShapes {
  index: SnapIndex;
}

export interface DrawingSnapBuildOptions {
  /** Index lines classified `hidden` too (the canvas draws them only with "show hidden lines"). */
  includeHiddenLines?: boolean;
}

export interface DrawingSnapQuery extends DrawingSnapBuildOptions {
  /** Search radius in drawing metres (screen pixels / view scale). */
  tolerance: number;
  /** Modes to offer; defaults to `DIMENSION_SNAP_MODES`. */
  modes?: ReadonlySet<SnapMode>;
  /** Reference point for `perpendicular`: the foot from here onto the element under the cursor. */
  from?: Pt | null;
}

export interface DrawingSnapResult {
  point: Pt;
  mode: SnapMode;
  /** The element the snap lies on; for an intersection, the one nearest the cursor. */
  source: DrawingSnapSource;
}

/** Modes the dimension tool offers, resolved in the core's priority order (endpoint first, nearest last). */
export const DIMENSION_SNAP_MODES: ReadonlySet<SnapMode> = new Set<SnapMode>([
  'endpoint',
  'intersection',
  'midpoint',
  'perpendicular',
  'nearest',
]);

/** Default snap radius in screen pixels. */
export const SNAP_RADIUS_PX = 10;

/** Snap tolerance in drawing metres for a radius in screen pixels at a view scale (pixels per metre). */
export function snapToleranceForScale(viewScale: number, radiusPx = SNAP_RADIUS_PX): number {
  return viewScale > 0 && Number.isFinite(viewScale) ? radiusPx / viewScale : 0;
}

function finite(p: Pt): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function ownerKey(modelIndex: number, entityId: number): string {
  return `${modelIndex}:${entityId}`;
}

/**
 * Snap shapes and their sources for a drawing, with same-entity collinear
 * pieces merged. Pure: callers normally want `getDrawingSnapIndex`.
 */
export function buildDrawingSnapShapes(drawing: Drawing2D, opts: DrawingSnapBuildOptions = {}): DrawingSnapShapes {
  const owners = new VertexOwners();
  const rings: { owner: string; source: DrawingSnapSource; pts: Pt[] }[] = [];
  for (const poly of drawing.cutPolygons) {
    const source = { entityId: poly.entityId, modelIndex: poly.modelIndex };
    const owner = ownerKey(poly.modelIndex, poly.entityId);
    for (const ring of [poly.polygon.outer, ...poly.polygon.holes]) {
      if (ring.length < 3 || !ring.every(finite)) continue;
      rings.push({ owner, source, pts: ring });
      for (const p of ring) owners.add(p, owner);
    }
  }

  const lineGroups = new Map<string, { source: DrawingSnapSource; segs: [Pt, Pt][] }>();
  for (const line of drawing.lines) {
    if (isPolygonCutLine(line)) continue;
    if (!opts.includeHiddenLines && line.visibility === 'hidden') continue;
    const { start, end } = line.line;
    if (!finite(start) || !finite(end)) continue;
    if (Math.hypot(end.x - start.x, end.y - start.y) <= VERTEX_TOLERANCE) continue;
    const owner = ownerKey(line.modelIndex, line.entityId);
    let group = lineGroups.get(owner);
    if (!group) {
      group = { source: { entityId: line.entityId, modelIndex: line.modelIndex }, segs: [] };
      lineGroups.set(owner, group);
    }
    group.segs.push([start, end]);
    owners.add(start, owner);
    owners.add(end, owner);
  }

  const shapes: DraftShape[] = [];
  const sources: DrawingSnapSource[] = [];
  for (const ring of rings) {
    shapes.push({ type: 'polyline', pts: simplifyRing(ring.pts, ring.owner, owners), closed: true });
    sources.push(ring.source);
  }
  for (const [owner, group] of lineGroups) {
    for (const [a, b] of mergeCollinearSegments(group.segs, owner, owners)) {
      shapes.push({ type: 'line', a, b });
      sources.push(group.source);
    }
  }
  return { shapes, sources };
}

interface CacheEntry {
  visible?: DrawingSnapIndex;
  withHidden?: DrawingSnapIndex;
}

const cache = new WeakMap<Drawing2D, CacheEntry>();

/** The snap index for a drawing, built on first use and kept for as long as the drawing object lives. */
export function getDrawingSnapIndex(drawing: Drawing2D, opts: DrawingSnapBuildOptions = {}): DrawingSnapIndex {
  let entry = cache.get(drawing);
  if (!entry) {
    entry = {};
    cache.set(drawing, entry);
  }
  const slot = opts.includeHiddenLines ? 'withHidden' : 'visible';
  let built = entry[slot];
  if (!built) {
    const { shapes, sources } = buildDrawingSnapShapes(drawing, opts);
    built = { shapes, sources, index: new SnapIndex(shapes) };
    entry[slot] = built;
  }
  return built;
}

/**
 * How far `point` is from being a `mode` snap on `shape` (0 when it is one).
 * Endpoint, midpoint and center hits are key points; a center lies `r` off
 * the curve, so it must not fall through to the curve distance.
 */
export function snapHitFit(shape: DraftShape, mode: SnapMode, point: Pt): number {
  if (mode === 'endpoint' || mode === 'midpoint' || mode === 'center') {
    const kp = shapeKeyPoints(shape);
    const list = mode === 'endpoint' ? kp.endpoints : mode === 'midpoint' ? kp.midpoints : kp.centers;
    let best = Infinity;
    for (const p of list) best = Math.min(best, Math.hypot(p.x - point.x, p.y - point.y));
    return best;
  }
  return nearestOnShape(shape, point).dist;
}

/**
 * The shape a core snap hit came from: among the shapes near the cursor,
 * those the hit fits (within 1e-6 m), the one whose curve is nearest the
 * cursor. `findSnap` reports only a point and a mode, and the vendored core
 * stays byte-pinned, so the source is recovered here.
 */
function sourceShape(snap: DrawingSnapIndex, cursor: Pt, tolerance: number, mode: SnapMode, point: Pt): number {
  const ids = snap.index.query(
    { x: Math.min(cursor.x, point.x) - tolerance, y: Math.min(cursor.y, point.y) - tolerance },
    { x: Math.max(cursor.x, point.x) + tolerance, y: Math.max(cursor.y, point.y) + tolerance },
  );
  let best = -1;
  let bestCursor = Infinity;
  for (const i of ids) {
    const shape = snap.shapes[i];
    if (snapHitFit(shape, mode, point) > VERTEX_TOLERANCE) continue;
    const d = nearestOnShape(shape, cursor).dist;
    if (d < bestCursor) {
      bestCursor = d;
      best = i;
    }
  }
  return best;
}

/**
 * The shapes near `cursor` cut down to the edges that reach its tolerance
 * window: each polyline becomes the runs of consecutive such edges. The
 * core's intersection pass pairs whole shapes, so two rings near the cursor
 * cost every edge of one against every edge of the other on each pointer
 * move: 3.6 ms for two 200-edge rings, 226 ms for two 2000-edge ones, against
 * 0.07 ms and 0.3 ms windowed (#10076 review). Every snap within `tolerance` lies on an edge that reaches
 * the window, so the hit is the same; `snaps.ts` stays byte-pinned.
 */
export function windowedSnapShapes(snap: DrawingSnapIndex, cursor: Pt, tolerance: number): DraftShape[] {
  const lo = { x: cursor.x - tolerance, y: cursor.y - tolerance };
  const hi = { x: cursor.x + tolerance, y: cursor.y + tolerance };
  const reaches = (a: Pt, b: Pt): boolean =>
    Math.max(a.x, b.x) >= lo.x && Math.min(a.x, b.x) <= hi.x && Math.max(a.y, b.y) >= lo.y && Math.min(a.y, b.y) <= hi.y;
  const out: DraftShape[] = [];
  for (const i of snap.index.query(lo, hi)) {
    const shape = snap.shapes[i];
    if (shape.type !== 'polyline') { out.push(shape); continue; }
    const { pts } = shape;
    const n = pts.length;
    const edges = shape.closed && n > 2 ? n : n - 1;
    const hits = Array.from({ length: Math.max(edges, 0) }, (_, k) => reaches(pts[k], pts[(k + 1) % n]));
    if (hits.every(Boolean)) { out.push(shape); continue; }
    // Start after an edge outside the window, so a run across a closed ring's seam stays one run.
    const start = shape.closed && n > 2 ? hits.indexOf(false) + 1 : 0;
    let run: Pt[] | null = null;
    for (let s = 0; s < edges; s++) {
      const k = (start + s) % edges;
      if (!hits[k]) {
        if (run) out.push({ type: 'polyline', pts: run, closed: false });
        run = null;
        continue;
      }
      if (!run) run = [pts[k]];
      run.push(pts[(k + 1) % n]);
    }
    if (run) out.push({ type: 'polyline', pts: run, closed: false });
  }
  return out;
}

/**
 * The best snap within `tolerance` of `cursor`: by mode priority (endpoint,
 * intersection, midpoint, center, quadrant, perpendicular, nearest), then
 * nearest the cursor within that mode. `null` when nothing is in reach or
 * the drawing has no geometry.
 */
export function findDrawingSnap(drawing: Drawing2D, cursor: Pt, query: DrawingSnapQuery): DrawingSnapResult | null {
  if (!(query.tolerance > 0) || !finite(cursor)) return null;
  const snap = getDrawingSnapIndex(drawing, query);
  if (snap.shapes.length === 0) return null;
  const hit = findSnap(cursor, windowedSnapShapes(snap, cursor, query.tolerance), null, {
    tolerance: query.tolerance,
    modes: query.modes ?? DIMENSION_SNAP_MODES,
    from: query.from ?? null,
  });
  if (!hit) return null;
  const i = sourceShape(snap, cursor, query.tolerance, hit.mode, hit.point);
  if (i < 0) return null;
  return { point: hit.point, mode: hit.mode, source: snap.sources[i] };
}
