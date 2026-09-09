/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hit-testing for 2D annotations (cloud, text, polygon area, measure),
 * split out of `useAnnotation2D.ts` to keep that hook under its
 * module-size budget and to make the hit-test resolution independently
 * unit-testable.
 *
 * Resolution has two passes rather than a single first-match-by-type scan
 * (see #4195, #4198):
 *
 *  1. GENUINE hits — the click falls inside a shape's actual rendered
 *     extent (a cloud's true bbox, a text box, a polygon's centroid
 *     label). Checked in reverse paint order (cloud -> text -> polygon),
 *     each array walked backwards, so the topmost item wins when shapes
 *     genuinely overlap.
 *  2. PADDED hits — the click is only within a type's click-tolerance
 *     padding (a cloud's bbox expanded by HIT_TEST_RADIUS_PX, a polygon
 *     edge or measure line within threshold px). Resolved by nearest
 *     distance across ALL padded candidates, not by paint order or type.
 *
 * Pass 1 always wins over pass 2: a genuine hit on a lower shape must not
 * be stolen by a higher shape's padding-only "near miss". Without this
 * split, a cloud's padded bbox (checked first for paint order) could hit-
 * test a click that is actually well inside a neighbouring text box and
 * outside the cloud's drawn extent — a real regression, not merely a
 * cosmetic one, because `handleMouseDown`/delete act on whatever this
 * function returns.
 */

import type {
  Point2D, TextAnnotation2D, SelectedAnnotation2D,
  Measure2DResult, PolygonArea2DResult, CloudAnnotation2D,
} from '@/store/slices/drawing2DSlice';
import { computePolygonCentroid } from '@/components/viewer/tools/computePolygonArea';

/** Nearest point on segment a-b to p, in drawing coordinates. */
export function nearestPointOnSegment(
  p: Point2D, a: Point2D, b: Point2D
): { point: Point2D; dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) {
    return { point: a, dist: Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2) };
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const nearest = { x: a.x + t * dx, y: a.y + t * dy };
  return { point: nearest, dist: Math.sqrt((p.x - nearest.x) ** 2 + (p.y - nearest.y) ** 2) };
}

/** Distance from p to the nearest point on segment a-b, in screen coordinates. */
function nearestPointOnScreenSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number }
): { dist: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.01) {
    return { dist: Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2) };
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const nx = a.x + t * dx;
  const ny = a.y + t * dy;
  return { dist: Math.sqrt((p.x - nx) ** 2 + (p.y - ny) ** 2) };
}

export interface HitTestAnnotationsParams {
  screenX: number;
  screenY: number;
  threshold: number;
  drawingToScreen: (pt: Point2D) => { x: number; y: number };
  texts: TextAnnotation2D[];
  clouds: CloudAnnotation2D[];
  polys: PolygonArea2DResult[];
  measures: Measure2DResult[];
}

/** A padded-tier candidate: a hit that only registers via click tolerance. */
interface PaddedCandidate {
  dist: number;
  selection: SelectedAnnotation2D;
}

export function hitTestAnnotations({
  screenX, screenY, threshold, drawingToScreen, texts, clouds, polys, measures,
}: HitTestAnnotationsParams): SelectedAnnotation2D | null {
  // ── Pass 1: genuine hits, reverse paint order (topmost wins) ───────────
  // Paint order: measure -> polygon -> text -> cloud, so the reverse
  // (topmost-first) check order is cloud -> text -> polygon.

  for (let i = clouds.length - 1; i >= 0; i--) {
    const cloud = clouds[i];
    if (cloud.points.length < 2) continue;
    const sp1 = drawingToScreen(cloud.points[0]);
    const sp2 = drawingToScreen(cloud.points[1]);
    const minX = Math.min(sp1.x, sp2.x);
    const maxX = Math.max(sp1.x, sp2.x);
    const minY = Math.min(sp1.y, sp2.y);
    const maxY = Math.max(sp1.y, sp2.y);
    if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
      return { type: 'cloud', id: cloud.id };
    }
  }

  for (let i = texts.length - 1; i >= 0; i--) {
    const annotation = texts[i];
    if (!annotation.text.trim()) continue;
    const sp = drawingToScreen(annotation.position);
    const fontSize = annotation.fontSize;
    const lines = annotation.text.split('\n');
    const lineHeight = fontSize * 1.3;
    const padding = 6;
    const approxCharWidth = fontSize * 0.6;
    const maxLineLen = Math.max(...lines.map((l) => l.length));
    const w = maxLineLen * approxCharWidth + padding * 2;
    const h = lines.length * lineHeight + padding * 2;
    if (screenX >= sp.x - 2 && screenX <= sp.x + w + 2 &&
        screenY >= sp.y - 2 && screenY <= sp.y + h + 2) {
      return { type: 'text', id: annotation.id };
    }
  }

  for (let i = polys.length - 1; i >= 0; i--) {
    const result = polys[i];
    if (result.points.length < 3) continue;
    const centroid = computePolygonCentroid(result.points);
    const sc = drawingToScreen(centroid);
    if (Math.abs(screenX - sc.x) < 40 && Math.abs(screenY - sc.y) < 20) {
      return { type: 'polygon', id: result.id };
    }
  }

  // ── Pass 2: padded (tolerance-only) hits, nearest wins across types ────

  let best: PaddedCandidate | null = null;

  for (let i = clouds.length - 1; i >= 0; i--) {
    const cloud = clouds[i];
    if (cloud.points.length < 2) continue;
    const sp1 = drawingToScreen(cloud.points[0]);
    const sp2 = drawingToScreen(cloud.points[1]);
    const minX = Math.min(sp1.x, sp2.x);
    const maxX = Math.max(sp1.x, sp2.x);
    const minY = Math.min(sp1.y, sp2.y);
    const maxY = Math.max(sp1.y, sp2.y);
    const dx = Math.max(minX - screenX, 0, screenX - maxX);
    const dy = Math.max(minY - screenY, 0, screenY - maxY);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < threshold && (!best || dist < best.dist)) {
      best = { dist, selection: { type: 'cloud', id: cloud.id } };
    }
  }

  for (let i = polys.length - 1; i >= 0; i--) {
    const result = polys[i];
    if (result.points.length < 3) continue;
    for (let j = 0; j < result.points.length; j++) {
      const a = drawingToScreen(result.points[j]);
      const b = drawingToScreen(result.points[(j + 1) % result.points.length]);
      const { dist } = nearestPointOnScreenSegment({ x: screenX, y: screenY }, a, b);
      if (dist < threshold && (!best || dist < best.dist)) {
        best = { dist, selection: { type: 'polygon', id: result.id } };
      }
    }
  }

  for (let i = measures.length - 1; i >= 0; i--) {
    const result = measures[i];
    const sa = drawingToScreen(result.start);
    const sb = drawingToScreen(result.end);
    const { dist } = nearestPointOnScreenSegment({ x: screenX, y: screenY }, sa, sb);
    if (dist < threshold && (!best || dist < best.dist)) {
      best = { dist, selection: { type: 'measure', id: result.id } };
    }
  }

  return best ? best.selection : null;
}
