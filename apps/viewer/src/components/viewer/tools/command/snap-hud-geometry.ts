/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the snap HUD draws for a `SnapResult` (charter #6232, WP3), as plain
 * data in workplane-local 2D: which glyph sits on the solved point, and the
 * finite pieces of each guide. Pure, so the choices are testable without a
 * camera; `SnapHud` only projects and paints them.
 *
 * Infinite guides (lines, rays) are drawn from where they come from to the
 * solved point: an extension from the nearer end of its edge, an axis or a
 * parallel from its chain point / anchor, a lock from the anchor. Past the
 * solved point the renderer adds a short screen-space overshoot.
 */

import type { SnapGlyphKind } from '@/components/viewport-ui/scene';
import type { Guide, SnapKind, SnapResult, Vec2 } from '@/lib/snap/types';

type GuideRole = Guide['role'];

/** Engine kind → glyph. `workplane` (a bare plane hit) gets none. */
const GLYPH: Readonly<Record<SnapKind, SnapGlyphKind | null>> = {
  endpoint: 'endpoint',
  vertex: 'endpoint',
  midpoint: 'midpoint',
  intersection: 'intersection',
  perpendicular: 'perpendicular',
  extension: 'extension',
  parallel: 'parallel',
  edge: 'edge',
  face: 'center',
  grid: 'grid',
  gridIntersection: 'grid',
  workplane: null,
};

export function glyphFor(snap: SnapResult | null): SnapGlyphKind | null {
  const kind = snap?.winner?.kind;
  return kind ? GLYPH[kind] : null;
}

export type GuideStroke =
  /** A finite piece: the snapped edge itself, a perpendicular drop. */
  | { kind: 'segment'; a: Vec2; b: Vec2; role: GuideRole }
  /** An infinite guide, drawn from `from` through the solved point and a little beyond. */
  | { kind: 'through'; from: Vec2; to: Vec2; role: GuideRole }
  | { kind: 'circle'; center: Vec2; radius: number; role: GuideRole };

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Where an extension guide is drawn from: the nearer end of the edge it
 * extends. Inference builds the line as `origin = edge.a`, `dir = edge.b - edge.a`
 * (raw, not normalised), so both ends are on the guide itself.
 */
function nearerEnd(line: Extract<Guide, { kind: 'line' }>, to: Vec2): Vec2 {
  const b: Vec2 = [line.origin[0] + line.dir[0], line.origin[1] + line.dir[1]];
  return dist(line.origin, to) <= dist(b, to) ? line.origin : b;
}

function key(s: GuideStroke): string {
  switch (s.kind) {
    case 'segment': return `s:${s.a}:${s.b}`;
    case 'through': return `t:${s.from}:${s.to}:${s.role}`;
    case 'circle': return `c:${s.center}:${s.radius}`;
  }
}

/** The strokes to draw for a result's guides, deduplicated, lock first. */
export function guideStrokes(snap: SnapResult | null): GuideStroke[] {
  if (!snap) return [];
  const to = snap.local;
  const out: GuideStroke[] = [];
  const seen = new Set<string>();
  const push = (s: GuideStroke): void => {
    const k = key(s);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  for (const g of snap.guides) {
    switch (g.kind) {
      case 'segment':
        push({ kind: 'segment', a: g.a, b: g.b, role: g.role });
        break;
      case 'circle':
        push({ kind: 'circle', center: g.center, radius: g.radius, role: g.role });
        break;
      case 'line':
      case 'ray': {
        const from = g.kind === 'line' && g.role === 'extension' ? nearerEnd(g, to) : g.origin;
        // A guide through its own start point has nothing to show.
        if (dist(from, to) > 0) push({ kind: 'through', from, to, role: g.role });
        break;
      }
    }
  }
  return out;
}
