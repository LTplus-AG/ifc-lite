/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inferred snap targets, derived from what the sources collected plus the
 * gesture's own chain:
 * - extension: the cursor near the infinite line of an edge, beyond its ends;
 * - perpendicular: the foot of the anchor on an edge;
 * - parallel: the line through the anchor parallel to an edge;
 * - axis alignment: the u/v lines through chain points (tracking);
 * - intersection: where two of those guides (or edges) cross, computed in
 *   closed form on the raw guide parameters so it is exact whenever the
 *   inputs are (axis-aligned or integer-coordinate guides);
 * - chain points themselves (closing a polyline).
 *
 * Work is bounded: at most MAX_SEGMENTS edges and MAX_GUIDES guides (so at
 * most MAX_GUIDES·(MAX_GUIDES-1)/2 intersection tests) per query.
 */

import { dist, dot, intersectLinear, projectOntoLocus, sub, toLinear } from './constraints.js';
import type { Guide, SnapCandidate, SnapQuery, Vec2 } from './types.js';

const MAX_SEGMENTS = 8;
const MAX_GUIDES = 8;
const MAX_CHAIN_POINTS = 16;

type Segment = Extract<Guide, { kind: 'segment' }>;
type LineGuide = Extract<Guide, { kind: 'line' }>;

function segmentDistance(p: Vec2, s: Segment): number {
  const d = sub(s.b, s.a);
  const len2 = dot(d, d);
  let t = len2 === 0 ? 0 : dot(sub(p, s.a), d) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(s.a[0] + t * d[0] - p[0], s.a[1] + t * d[1] - p[1]);
}

const segKey = (s: Segment): string => `${s.a[0]},${s.a[1]},${s.b[0]},${s.b[1]}`;

/** Edges to reason about: collected edge guides plus the chain's own segments, nearest first. */
function gatherSegments(q: SnapQuery, cursor: Vec2, base: readonly SnapCandidate[]): Segment[] {
  const seen = new Set<string>();
  const all: { s: Segment; d: number }[] = [];
  const add = (s: Segment): void => {
    if (s.a[0] === s.b[0] && s.a[1] === s.b[1]) return;
    const k = segKey(s);
    if (seen.has(k)) return;
    seen.add(k);
    all.push({ s, d: segmentDistance(cursor, s) });
  };
  for (const c of base) if (c.guide?.kind === 'segment') add(c.guide);
  const chain = q.chain.slice(-MAX_CHAIN_POINTS);
  for (let i = 1; i < chain.length; i++) add({ kind: 'segment', a: chain[i - 1], b: chain[i], role: 'edge' });
  all.sort((x, y) => x.d - y.d);
  return all.slice(0, MAX_SEGMENTS).map((e) => e.s);
}

/**
 * Append inferred candidates to `out`. `cursor` is the reference point (the
 * cursor already projected onto the active lock); only targets within
 * `radius` of it are emitted.
 */
export function inferCandidates(
  q: SnapQuery,
  cursor: Vec2,
  radius: number,
  base: readonly SnapCandidate[],
  out: SnapCandidate[],
): void {
  const segments = gatherSegments(q, cursor, base);
  const guides: { g: Guide; d: number }[] = [];
  const anchor = q.anchor;

  for (const s of segments) {
    const d = sub(s.b, s.a);
    const line: LineGuide = { kind: 'line', origin: s.a, dir: d, role: 'extension' };
    const foot = projectOntoLocus(cursor, { kind: 'line', origin: s.a, dir: d });
    const lineD = dist(foot, cursor);
    // Guides for intersections: the edge itself and its extension line.
    guides.push({ g: s, d: segmentDistance(cursor, s) });
    guides.push({ g: line, d: lineD });

    const t = dot(sub(cursor, s.a), d) / dot(d, d);
    if ((t < 0 || t > 1) && lineD <= radius) {
      out.push({ kind: 'extension', local: foot, source: 'inference', guide: line, trace: [s] });
    }
    if (anchor) {
      const f = projectOntoLocus(anchor, { kind: 'line', origin: s.a, dir: d });
      const ft = dot(sub(f, s.a), d) / dot(d, d);
      if (ft >= 0 && ft <= 1 && dist(f, cursor) <= radius && dist(f, anchor) > 0) {
        out.push({
          kind: 'perpendicular', local: f, source: 'inference',
          trace: [s, { kind: 'segment', a: anchor, b: f, role: 'perpendicular' }],
        });
      }
      const par: LineGuide = { kind: 'line', origin: anchor, dir: d, role: 'parallel' };
      const pf = projectOntoLocus(cursor, par);
      const pd = dist(pf, cursor);
      if (pd <= radius && dist(cursor, anchor) > radius) {
        out.push({ kind: 'parallel', local: pf, source: 'inference', guide: par, trace: [s] });
        guides.push({ g: par, d: pd });
      }
    }
  }

  // Axis tracking through chain points (the anchor included) and closing onto them.
  for (const p of q.chain.slice(-MAX_CHAIN_POINTS)) {
    const isAnchor = anchor !== null && p[0] === anchor[0] && p[1] === anchor[1];
    if (!isAnchor && dist(p, cursor) <= radius) out.push({ kind: 'endpoint', local: p, source: 'inference' });
    const axes: LineGuide[] = [
      { kind: 'line', origin: p, dir: [1, 0], role: 'axis' },
      { kind: 'line', origin: p, dir: [0, 1], role: 'axis' },
    ];
    for (const ax of axes) {
      const foot = projectOntoLocus(cursor, ax);
      const d = dist(foot, cursor);
      if (d > radius) continue;
      guides.push({ g: ax, d });
      if (dist(foot, p) > radius) out.push({ kind: 'extension', local: foot, source: 'inference', guide: ax });
    }
  }

  // Intersections of the nearest guides.
  guides.sort((x, y) => x.d - y.d);
  const top = guides.filter((e) => e.d <= radius).slice(0, MAX_GUIDES);
  for (let i = 0; i < top.length; i++) {
    const li = toLinear(top[i].g);
    if (!li) continue;
    for (let j = i + 1; j < top.length; j++) {
      const lj = toLinear(top[j].g);
      if (!lj) continue;
      const x = intersectLinear(li, lj);
      if (!x || dist(x, cursor) > radius) continue;
      out.push({ kind: 'intersection', local: x, source: 'inference', trace: [top[i].g, top[j].g] });
    }
  }
}
