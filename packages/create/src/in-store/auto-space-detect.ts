/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Detect enclosed regions from a set of 2D wall axis segments.
 *
 * Pipeline:
 *   1. Snap close vertices within `snapTolerance` (collapses tiny gaps
 *      between wall ends that should meet at a corner).
 *   2. Resolve pairwise segment intersections — each crossing splits
 *      both segments into shorter pieces meeting at the new vertex.
 *   3. Build a half-edge graph (DCEL): every undirected segment
 *      becomes two opposing directed half-edges; per vertex, the
 *      half-edges leaving it are ordered by polar angle so we can
 *      find the next CCW-around-a-face neighbour in O(1).
 *   4. Walk minimum cycles by always taking the leftmost turn. Each
 *      half-edge belongs to exactly one face cycle.
 *   5. Drop the outer (unbounded) face — the one with the most-
 *      negative signed area.
 *   6. Filter the remaining faces by `minArea`.
 *
 * Pure: no IFC dependencies. Output is a list of CCW polygons
 * (`outline`) plus the signed area of each. Callers feed these into
 * the per-storey IfcSpace builder.
 */

export type Vec2 = [number, number];

export interface Segment {
  a: Vec2;
  b: Vec2;
}

export interface DetectedSpace {
  /** CCW outline (no implicit closing edge — first vertex isn't repeated). */
  outline: Vec2[];
  /** Absolute polygon area, m². */
  area: number;
}

export interface DetectOptions {
  /** Distance below which two endpoints are merged. Default 0.05 m. */
  snapTolerance?: number;
  /** Faces below this area are dropped. Default 0.5 m². */
  minArea?: number;
  /**
   * When true, the detector emits `console.debug` messages tracing the
   * pipeline (vertex/edge counts, face areas, drop reasons). Surfaces
   * the data needed to diagnose "no enclosed regions detected" without
   * touching the algorithm.
   */
  debug?: boolean;
}

export interface DetectStats {
  inputSegments: number;
  vertices: number;
  segmentsAfterSplit: number;
  edges: number;
  faces: number;
  outerFacesDropped: number;
  belowMinAreaDropped: number;
  /** Largest detected interior face area (m²). 0 when no face passed. */
  largestArea: number;
}

const DEFAULT_SNAP = 0.05;
const DEFAULT_MIN_AREA = 0.5;
const EPS = 1e-9;

interface Vertex {
  id: number;
  pt: Vec2;
}

interface HalfEdge {
  id: number;
  /** Origin vertex id. */
  origin: number;
  /** Destination vertex id. */
  dest: number;
  /** Twin half-edge id (the same undirected edge in the opposite direction). */
  twin: number;
  /** Polar angle (atan2) of the direction vector at `origin`. */
  angle: number;
  /** Cycle id assigned during face-walking. -1 before. */
  face: number;
  /** Next half-edge around the same face. -1 before. */
  next: number;
  /** Pre-computed direction (unit-ish). */
  dx: number;
  dy: number;
}

export function detectEnclosedAreas(
  segments: Segment[],
  options: DetectOptions = {},
): DetectedSpace[] {
  return detectEnclosedAreasWithStats(segments, options).spaces;
}

/**
 * Same pipeline as `detectEnclosedAreas`, but returns the per-stage
 * counts alongside the spaces so callers can surface diagnostic
 * information (used by the orchestrator + viewer Auto Spaces panel).
 */
export function detectEnclosedAreasWithStats(
  segments: Segment[],
  options: DetectOptions = {},
): { spaces: DetectedSpace[]; stats: DetectStats } {
  const snap = options.snapTolerance ?? DEFAULT_SNAP;
  const minArea = options.minArea ?? DEFAULT_MIN_AREA;
  const debug = !!options.debug;
  const log = debug ? (...args: unknown[]) => console.debug('[auto-space-detect]', ...args) : () => {};
  const stats: DetectStats = {
    inputSegments: segments.length,
    vertices: 0,
    segmentsAfterSplit: 0,
    edges: 0,
    faces: 0,
    outerFacesDropped: 0,
    belowMinAreaDropped: 0,
    largestArea: 0,
  };
  log(`input: ${segments.length} segments, snapTolerance=${snap}, minArea=${minArea}`);
  if (segments.length < 3) {
    log('input below 3 segments — no faces possible');
    return { spaces: [], stats };
  }

  // ── 1. Snap endpoints ──
  const vertices: Vertex[] = [];
  const lookup = (pt: Vec2): number => {
    for (const v of vertices) {
      const dx = v.pt[0] - pt[0];
      const dy = v.pt[1] - pt[1];
      if (dx * dx + dy * dy <= snap * snap) return v.id;
    }
    const id = vertices.length;
    vertices.push({ id, pt: [pt[0], pt[1]] });
    return id;
  };

  // Initial vertex set: every endpoint, snapped.
  const indexedSegs: Array<[number, number]> = [];
  for (const seg of segments) {
    const ai = lookup(seg.a);
    const bi = lookup(seg.b);
    if (ai === bi) continue; // zero-length, post-snap
    indexedSegs.push([ai, bi]);
  }
  log(`after snap: ${vertices.length} vertices, ${indexedSegs.length} segments`);

  // ── 1b. Snap dangling endpoints onto nearby edge interiors ──
  // Walls extracted from real IFC files often DON'T share corner
  // vertices: each wall's axis runs centreline-to-centreline, but
  // adjacent perpendicular walls have axes ending at the inside
  // face of the partner wall — so the endpoints land on each
  // other's interior, not at the same point. A pure endpoint snap
  // misses this; we project each unique endpoint onto every nearby
  // segment and, when within snap tolerance, mark the projection
  // as the canonical vertex (and queue the host segment to be
  // split there).
  const splitSegs: Array<[number, number]> = [];
  for (let i = 0; i < indexedSegs.length; i++) {
    splitSegs.push([...indexedSegs[i]]);
  }
  const snapSq = snap * snap;
  let tjunctionPasses = 0;
  let tjunctionsApplied = false;
  do {
    tjunctionsApplied = false;
    tjunctionPasses++;
    // Snapshot endpoints we need to test — segs grow during the loop,
    // but the new pieces share endpoints with the originals so we
    // don't have to re-scan them.
    const endpointIds = new Set<number>();
    for (const [a, b] of splitSegs) { endpointIds.add(a); endpointIds.add(b); }
    for (const vid of endpointIds) {
      const p = vertices[vid].pt;
      for (let s = 0; s < splitSegs.length; s++) {
        const [a, b] = splitSegs[s];
        if (a === vid || b === vid) continue;
        const proj = closestPointOnSegment(p, vertices[a].pt, vertices[b].pt);
        if (!proj) continue;
        const dx = proj.point[0] - p[0];
        const dy = proj.point[1] - p[1];
        if (dx * dx + dy * dy > snapSq) continue;
        // Strictly interior — skip projections that land on the
        // segment endpoints (those are handled by the regular vertex
        // snap and would degenerate the split).
        if (proj.t < 1e-6 || proj.t > 1 - 1e-6) continue;
        // Insert the dangling endpoint as the split vertex (its
        // coords are already in `vertices[vid]`); split the host edge.
        splitSegs[s] = [a, vid];
        splitSegs.push([vid, b]);
        tjunctionsApplied = true;
        break;
      }
      if (tjunctionsApplied) break;
    }
  } while (tjunctionsApplied && tjunctionPasses < Math.max(50, indexedSegs.length * 5));
  log(`T-junction snap: ${tjunctionPasses} pass(es)`);

  const maxIterations = Math.max(100, indexedSegs.length * 10);
  let changed = true;
  let guard = 0;
  while (changed && guard < maxIterations) {
    changed = false;
    guard++;
    outer: for (let i = 0; i < splitSegs.length; i++) {
      for (let j = i + 1; j < splitSegs.length; j++) {
        const [ai, bi] = splitSegs[i];
        const [aj, bj] = splitSegs[j];
        if (ai === aj || ai === bj || bi === aj || bi === bj) continue;
        const ip = segmentIntersection(
          vertices[ai].pt, vertices[bi].pt,
          vertices[aj].pt, vertices[bj].pt,
        );
        if (!ip) continue;
        const newIdx = lookup(ip);
        if (newIdx === ai || newIdx === bi || newIdx === aj || newIdx === bj) {
          // Intersection coincides with an existing vertex — split
          // only the segments that don't already touch it.
          if (newIdx !== ai && newIdx !== bi) {
            splitSegs[i] = [ai, newIdx];
            splitSegs.push([newIdx, bi]);
            changed = true;
          }
          if (newIdx !== aj && newIdx !== bj) {
            splitSegs[j] = [aj, newIdx];
            splitSegs.push([newIdx, bj]);
            changed = true;
          }
          if (changed) break outer;
        } else {
          // Genuine T or X crossing.
          splitSegs[i] = [ai, newIdx];
          splitSegs.push([newIdx, bi]);
          splitSegs[j] = [aj, newIdx];
          splitSegs.push([newIdx, bj]);
          changed = true;
          break outer;
        }
      }
    }
  }

  if (changed && guard >= maxIterations) {
    // Iteration cap hit before the splitter converged — detection
    // results may be incomplete, but emit them rather than failing.
    log(`intersection splitter hit iteration cap ${maxIterations}; results may be incomplete`);
  }

  // Deduplicate (a, b) and (b, a) pairs.
  const undirected = new Set<string>();
  const finalSegs: Array<[number, number]> = [];
  for (const [a, b] of splitSegs) {
    if (a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (undirected.has(key)) continue;
    undirected.add(key);
    finalSegs.push([a, b]);
  }
  stats.vertices = vertices.length;
  stats.segmentsAfterSplit = finalSegs.length;
  log(`after intersect-split: ${finalSegs.length} unique edges`);

  if (finalSegs.length < 3) {
    log('after split: fewer than 3 edges — no faces possible');
    return { spaces: [], stats };
  }

  // ── 3. Build half-edge graph ──
  const edges: HalfEdge[] = [];
  const vertexEdges: number[][] = vertices.map(() => []);
  for (const [a, b] of finalSegs) {
    const dxA = vertices[b].pt[0] - vertices[a].pt[0];
    const dyA = vertices[b].pt[1] - vertices[a].pt[1];
    const fwd = edges.length;
    const bwd = edges.length + 1;
    edges.push({
      id: fwd,
      origin: a,
      dest: b,
      twin: bwd,
      angle: Math.atan2(dyA, dxA),
      face: -1,
      next: -1,
      dx: dxA,
      dy: dyA,
    });
    edges.push({
      id: bwd,
      origin: b,
      dest: a,
      twin: fwd,
      angle: Math.atan2(-dyA, -dxA),
      face: -1,
      next: -1,
      dx: -dxA,
      dy: -dyA,
    });
    vertexEdges[a].push(fwd);
    vertexEdges[b].push(bwd);
  }

  // Sort each vertex's outgoing edges by angle so we can compute
  // "next around face" via the leftmost-turn rule in O(1).
  for (const list of vertexEdges) {
    list.sort((p, q) => edges[p].angle - edges[q].angle);
  }

  // ── 4. Walk faces ──
  // Around a face (CCW interior), the next half-edge after entering
  // a vertex along edge `e` is the half-edge whose origin is the
  // entered vertex AND whose direction is the *clockwise* neighbour
  // of e.twin's direction in the cyclic angle ordering.
  //
  //     prev = e
  //     v = e.dest
  //     fanIdx = position of e.twin in vertexEdges[v]
  //     next = vertexEdges[v][(fanIdx - 1 + len) % len]
  for (const e of edges) {
    if (e.next !== -1) continue;
    const v = e.dest;
    const fan = vertexEdges[v];
    const idx = fan.indexOf(e.twin);
    if (idx < 0) continue; // structurally impossible, but defensive
    const nextIdx = (idx - 1 + fan.length) % fan.length;
    e.next = fan[nextIdx];
  }

  let faceCount = 0;
  const faceCycles: number[][] = [];
  for (const e of edges) {
    if (e.face !== -1) continue;
    const cycle: number[] = [];
    let cur = e.id;
    let safety = 0;
    while (cur !== -1 && edges[cur].face === -1 && safety++ < edges.length + 4) {
      edges[cur].face = faceCount;
      cycle.push(cur);
      cur = edges[cur].next;
      if (cur === e.id) break;
    }
    faceCycles.push(cycle);
    faceCount++;
  }

  // ── 5. Compute signed area for each cycle, drop outer ──
  type FaceArea = { idx: number; area: number; signed: number };
  const faceAreas: FaceArea[] = faceCycles.map((cycle, idx) => {
    let signed = 0;
    for (const eid of cycle) {
      const eg = edges[eid];
      const p = vertices[eg.origin].pt;
      const q = vertices[eg.dest].pt;
      signed += p[0] * q[1] - q[0] * p[1];
    }
    signed *= 0.5;
    return { idx, signed, area: Math.abs(signed) };
  });

  stats.edges = edges.length;
  stats.faces = faceCycles.length;
  log(`half-edge graph: ${edges.length} half-edges, ${faceCycles.length} faces total`);

  // ── 6. Drop outer faces + filter by min area + emit CCW outlines ──
  // With the leftmost-turn walk every interior (enclosed) face winds
  // CCW (signed area > 0); the unbounded face surrounding each
  // connected component winds CW (signed area < 0). Drop the
  // negatives — that handles the multi-component case naturally,
  // since each component contributes its own outer face.
  const out: DetectedSpace[] = [];
  for (const f of faceAreas) {
    if (f.signed <= 0) {
      stats.outerFacesDropped++;
      continue;
    }
    if (f.area < minArea) {
      stats.belowMinAreaDropped++;
      log(`face #${f.idx}: dropped (area=${f.area.toFixed(3)} < minArea=${minArea})`);
      continue;
    }
    const cycle = faceCycles[f.idx];
    const outline: Vec2[] = cycle.map((eid) => {
      const v = vertices[edges[eid].origin].pt;
      return [v[0], v[1]];
    });
    out.push({ outline, area: f.area });
    if (f.area > stats.largestArea) stats.largestArea = f.area;
  }

  // Stable sort: largest area first so the UI shows "main rooms" up top.
  out.sort((a, b) => b.area - a.area);
  log(`detected ${out.length} interior region(s); dropped ${stats.outerFacesDropped} outer + ${stats.belowMinAreaDropped} below min-area`);
  return { spaces: out, stats };
}

/**
 * Closest point on segment ab to a query point q, plus the
 * parametric distance `t ∈ [0, 1]` along ab. Returns null for
 * zero-length segments.
 */
function closestPointOnSegment(
  q: Vec2, a: Vec2, b: Vec2,
): { point: Vec2; t: number } | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return null;
  let t = ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return { point: [a[0] + t * dx, a[1] + t * dy], t };
}

/**
 * Proper-segment intersection test in 2D. Returns the crossing point
 * when the segments cross strictly inside both (excluding shared
 * endpoints at parameter 0 or 1, which produce no new vertex). Uses
 * a small parametric tolerance so two near-coincident endpoints
 * don't register as a fresh interior crossing.
 */
function segmentIntersection(
  p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2,
): Vec2 | null {
  const x1 = p1[0], y1 = p1[1];
  const x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1];
  const x4 = p4[0], y4 = p4[1];
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < EPS) return null; // parallel / coincident
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
  // Allow exact endpoints (t == 0 / 1) so a T-junction registers and
  // splits the through-segment, but skip when both segments meet
  // *only* at a shared endpoint (no new vertex needed).
  const tol = 1e-7;
  if (t < -tol || t > 1 + tol) return null;
  if (u < -tol || u > 1 + tol) return null;
  if ((t < tol || t > 1 - tol) && (u < tol || u > 1 - tol)) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}
