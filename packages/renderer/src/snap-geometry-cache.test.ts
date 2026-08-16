/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import type { Intersection, Vec3 } from './raycaster.js';
import { buildGeometryCache, type MeshGeometryCache } from './snap-geometry-cache.js';
import { bestEdgeCandidate, type EdgeCandidate } from './snap-corner.js';
import type { SnapEdge } from './snap-edge-runs.js';
import { SnapDetector, SnapType } from './snap-detector.js';

/**
 * Issue #2199: the snap cache must expose the model edges a user sees, so that a
 * length taken from a snapped edge is the length on the drawing.
 *
 * Every fixture here is UNWELDED — one private copy of each vertex per triangle —
 * because that is what the wasm mesher emits (`rust/geometry/src/mesh_weld.rs`
 * keys vertex identity on position bits AND normal, so the two sides of a crease
 * stay split). The repo's only other edge fixture is a welded unit cube, which
 * exercises a classification path real geometry never reaches.
 */

type P = [number, number, number];
type Tri = [P, P, P];

function quad(a: P, b: P, c: P, d: P): Tri[] {
  return [[a, b, c], [a, c, d]];
}

/** An unwelded MeshData: every triangle carries its own three vertices. */
function meshFrom(tris: Tri[], expressId = 1): MeshData {
  const positions = new Float32Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  let p = 0;
  tris.forEach((tri, t) => {
    tri.forEach((v, k) => {
      positions[p++] = v[0];
      positions[p++] = v[1];
      positions[p++] = v[2];
      indices[t * 3 + k] = t * 3 + k;
    });
  });
  return {
    expressId,
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

/**
 * The measured case, from IfcSlab #52 of `apps/viewer/public/samples/
 * building-architecture.ifc`: an opening edge at x = 5.600, y = 0.000 running
 * continuously from z = -5.000 to z = -3.000 — ONE straight 2.000 m model edge.
 *
 * The two faces meeting along it subdivide it independently: the y = 0 face at
 * z = -4.800, the x = 5.600 face at z = -3.200. The cache used to hold four
 * fragments of it (0.200 / 1.800 / 1.600 / 0.200) and no cursor position
 * anywhere on the edge ever reported 2.000.
 *
 * `withRib` adds the shelf that makes z = -4.800 a REAL junction, mirroring the
 * two edges measured incident there on the shipped model:
 * (5.600, -0.250, -4.800)->(5.600, 0.000, -4.800) and
 * (5.600, 0.000, -4.800)->(7.000, 0.000, -4.800).
 */
function slabOpeningEdge(withRib: boolean): MeshData {
  const tris: Tri[] = [
    // Face A, the y = 0 plane, subdivided at z = -4.800.
    ...quad([5.6, 0, -5], [7, 0, -5], [7, 0, -4.8], [5.6, 0, -4.8]),
    ...quad([5.6, 0, -4.8], [7, 0, -4.8], [7, 0, -3], [5.6, 0, -3]),
    // Face B, the x = 5.600 plane, subdivided at z = -3.200.
    ...quad([5.6, 0, -5], [5.6, 0, -3.2], [5.6, -0.25, -3.2], [5.6, -0.25, -5]),
    ...quad([5.6, 0, -3.2], [5.6, 0, -3], [5.6, -0.25, -3], [5.6, -0.25, -3.2]),
  ];
  if (withRib) {
    tris.push(...quad([5.6, 0, -4.8], [6, 0, -4.8], [6, -0.25, -4.8], [5.6, -0.25, -4.8]));
  }
  return meshFrom(tris);
}

/** Cache edges lying on the x = 5.600, y = 0.000 line of the slab fixture. */
function onOpeningLine(edges: SnapEdge[]): SnapEdge[] {
  const on = (v: Vec3) => Math.abs(v.x - 5.6) < 1e-3 && Math.abs(v.y) < 1e-3;
  return edges.filter((e) => on(e.v0) && on(e.v1));
}

test('#2199 a straight run split across several triangles reconstructs as ONE edge of the full length', () => {
  const edges = buildGeometryCache(slabOpeningEdge(false)).edges;
  const run = onOpeningLine(edges);

  assert.equal(run.length, 1, 'the 2.000 m opening edge must be one cache edge, not four fragments');
  assert.ok(
    Math.abs(run[0].length - 2) < 1e-4,
    `expected the full 2.0000 m edge, got ${run[0].length.toFixed(4)}`
  );
});

test('#2199 a triangulation diagonal is not a model edge', () => {
  // One flat square, two triangles. The shared diagonal is an artefact of the
  // triangulation; only the four boundary edges are real.
  const mesh = meshFrom(quad([0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]));
  const edges = buildGeometryCache(mesh).edges;

  assert.equal(edges.length, 4, `expected 4 boundary edges, got ${edges.length}`);
  for (const e of edges) {
    assert.ok(Math.abs(e.length - 1) < 1e-5, `unexpected edge of length ${e.length.toFixed(4)}`);
  }
});

test('#2199 an inconsistently wound coplanar pair is still a diagonal (the dot is taken absolute)', () => {
  // Same square, second triangle wound the other way: the adjacent normals are
  // exactly opposite, so the raw dot is -1 and only its magnitude identifies
  // the pair as coplanar.
  const mesh = meshFrom([
    [[0, 0, 0], [1, 0, 0], [1, 0, 1]],
    [[0, 0, 0], [1, 0, 1], [0, 0, 1]].reverse() as Tri,
  ]);
  const edges = buildGeometryCache(mesh).edges;

  const diagonal = edges.filter((e) => e.length > 1.2);
  assert.equal(diagonal.length, 0, `the diagonal survived as ${diagonal.length} edge(s)`);
});

test('#2199 a tessellated curve is NOT fused into one straight edge', () => {
  // The finest arc the Rust tessellator can emit: calculate_circle_segments
  // clamps to a minimum of 8 segments, so a 5 mm radius gives an 8-gon with a
  // 3.827 mm chord and a 381 um single-chord sagitta. Fusing those chords would
  // report a confidently wrong number.
  const r = 0.005;
  const h = 0.02;
  const n = 8;
  const ring = (y: number): P[] =>
    Array.from({ length: n }, (_, i) => {
      const a = (2 * Math.PI * i) / n;
      return [r * Math.cos(a), y, r * Math.sin(a)] as P;
    });
  const bottom = ring(0);
  const top = ring(h);
  const tris: Tri[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push(...quad(bottom[i], bottom[j], top[j], top[i]));
    // Caps, as triangle fans about vertex 0 — coplanar, so their interior edges
    // must be filtered while the rim chords survive as creases.
    if (i > 0 && j !== 0) {
      tris.push([bottom[0], bottom[j], bottom[i]]);
      tris.push([top[0], top[i], top[j]]);
    }
  }

  const edges = buildGeometryCache(meshFrom(tris)).edges;
  const chord = 2 * r * Math.sin(Math.PI / n);
  const chords = edges.filter((e) => Math.abs(e.length - chord) < chord * 0.01);
  const verticals = edges.filter((e) => Math.abs(e.length - h) < h * 0.01);

  assert.equal(chords.length, 2 * n, `expected ${2 * n} unfused rim chords, got ${chords.length}`);
  assert.equal(verticals.length, n, `expected ${n} vertical facet edges, got ${verticals.length}`);
  assert.equal(edges.length, 3 * n, `expected ${3 * n} edges in total, got ${edges.length}`);
});

/** Two quads hinged on the line y = 0, z = 0, meeting at `deg` degrees. */
function hinged(deg: number): MeshData {
  const a = (deg * Math.PI) / 180;
  return meshFrom([
    ...quad([0, 0, -1], [1, 0, -1], [1, 0, 0], [0, 0, 0]),
    ...quad([0, 0, 0], [1, 0, 0], [1, Math.sin(a), Math.cos(a)], [0, Math.sin(a), Math.cos(a)]),
  ]);
}

function onHinge(edges: SnapEdge[]): SnapEdge[] {
  return edges.filter((e) =>
    Math.abs(e.v0.y) < 1e-6 && Math.abs(e.v0.z) < 1e-6 &&
    Math.abs(e.v1.y) < 1e-6 && Math.abs(e.v1.z) < 1e-6);
}

test('#2199 the coplanar cutoff keeps shallow real creases and drops only coplanar seams', () => {
  // Real BIM geometry lives at shallow angles: a 2% drainage fall is 1.15
  // degrees, a 2.5% bridge crossfall 1.43 degrees, and infra-bridge.ifc's
  // measured deck edge (IfcBuildingElementProxy #723, a 3.500 m model edge)
  // meets at 3.617 degrees. Every one of those is an edge a user must be able
  // to snap and measure. What is NOT a model edge is a triangulation seam of a
  // genuinely flat face, whose normal pair dots to 1 within f32 noise
  // (measured >= 1 - 8.1e-8 across the committed samples). An earlier 0.98
  // cutoff (~11.5 degrees) deleted the whole shallow band; this pins its
  // members as KEPT so that regression cannot come back.
  for (const deg of [45, 3.617, 2.5, 0.49]) {
    const crease = onHinge(buildGeometryCache(hinged(deg)).edges);
    assert.equal(crease.length, 1, `a ${deg} degree crease is a model edge and must be kept`);
    assert.ok(Math.abs(crease[0].length - 1) < 1e-5);
  }

  const seam = onHinge(buildGeometryCache(hinged(0)).edges);
  assert.equal(seam.length, 0, 'an exactly coplanar seam is a triangulation diagonal and must be dropped');
});

test('#2199 an interior split of a straight run is not a corner, but a real junction is', () => {
  const plain = buildGeometryCache(slabOpeningEdge(false)).edges;
  const plainRun = onOpeningLine(plain)[0];
  assert.equal(plainRun.junctions.length, 0, 'a pure triangulation split must not read as a corner');

  const ribbed = buildGeometryCache(slabOpeningEdge(true)).edges;
  const ribbedRun = onOpeningLine(ribbed)[0];
  assert.ok(Math.abs(ribbedRun.length - 2) < 1e-4, 'the run still merges THROUGH the junction');
  assert.equal(ribbedRun.junctions.length, 1, 'the junction the run was merged through must be kept');
  const junction = ribbedRun.junctions[0];
  assert.ok(Math.abs(junction.point.z + 4.8) < 1e-4, `junction at z=${junction.point.z.toFixed(4)}`);
  assert.ok(junction.valence >= 2, `junction valence ${junction.valence}`);
});

/**
 * Full geometric signature of a cache edge: endpoints and length, but ALSO the
 * valences and junction list. Endpoints/length alone cannot see the valence
 * channel, which feeds `isCorner` and the corner confidence - an
 * order-dependence there slipped past a v0/v1/length-only signature once.
 */
function shape(edges: SnapEdge[]): string[] {
  return edges.map((e) =>
    [
      ...[e.v0.x, e.v0.y, e.v0.z, e.v1.x, e.v1.y, e.v1.z, e.length].map((n) => n.toFixed(6)),
      `val:${e.v0Valence}/${e.v1Valence}`,
      `j:[${e.junctions
        .map((j) => `${j.point.x.toFixed(6)},${j.point.y.toFixed(6)},${j.point.z.toFixed(6)},v${j.valence},t${j.t.toFixed(6)}`)
        .join(';')}]`,
    ].join(',')
  );
}

/**
 * The whole cache, not just the edges: the welded VERTEX list is a snap channel
 * of its own (`findVertices` serves it), and a weld that moves with input order
 * can in principle move it without moving any edge. Sorted, so the comparison
 * is over content rather than construction order.
 */
function cacheSignature(cache: MeshGeometryCache): string[] {
  return [
    ...cache.vertices
      .map((v) => `p:${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`)
      .sort(),
    ...shape(cache.edges).sort(),
  ];
}

test('#2199 valences do not depend on triangle emission order either', () => {
  // Two coplanar unwelded triangles meeting at (1, 0, 0). B contributes a
  // 0.01 m stub whose far point sits 10 um off the x axis - inside the weld
  // tolerance, so it is the SAME line as A's x-axis edge. Valence used to be
  // computed on the raw segment array with an asymmetric first-match test
  // (candidate point against representative line), so whichever direction the
  // mesher emitted first became "the line": order A,B read valence 3 at the
  // shared vertex and order B,A read 4 - and valence feeds `isCorner` and the
  // corner confidence, i.e. a user-visible vertex-vs-edge outcome.
  const A: Tri = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  const B: Tri = [[1, 0, 0], [1.01, 1e-5, 0], [1, -1, 0]];
  const abCache = buildGeometryCache(meshFrom([A, B]));
  const baCache = buildGeometryCache(meshFrom([B, A]));
  const ab = abCache.edges;

  assert.deepEqual(
    cacheSignature(abCache), cacheSignature(baCache),
    'valence/junction data moved with triangle emission order'
  );

  // Pin the value too: x-axis line (the stub folds into it within tolerance),
  // the diagonal to (0, 1, 0), and the vertical to (1, -1, 0) - three lines.
  const atShared = ab.flatMap((e) =>
    [[e.v0, e.v0Valence] as const, [e.v1, e.v1Valence] as const]
      .filter(([v]) => Math.abs(v.x - 1) < 1e-6 && Math.abs(v.y) < 1e-6)
      .map(([, val]) => val));
  assert.ok(atShared.length > 0, 'no cache edge ends at the shared vertex');
  for (const val of atShared) assert.equal(val, 3, `valence at (1,0,0) is ${val}, expected 3`);
});

test('#2199 the weld itself does not depend on triangle emission order (tolerance chain)', () => {
  // Three triangles carry three private copies of "the same" corner, spread
  // into a tolerance CHAIN: |c0-c1| and |c1-c2| are within the weld tolerance
  // but |c0-c2| is not. Under a first-hit representative scheme the number of
  // welded ids at the corner depended on which copy the mesher emitted first
  // (2 ids when c0 led, 1 when c1 did), so reordering triangles changed
  // adjacency, edge classification and the reconstructed runs - the exact
  // emission-order dependence this change exists to remove, one level down.
  // The weld must be a pure function of the position multiset.
  const tol = 1 / 65536;
  const c0: P = [1, 0, 0];
  const c1: P = [1 + 0.9 * tol, 0, 0];
  const c2: P = [1 + 1.8 * tol, 0, 0];
  const T0: Tri = [c0, [1, 1, 0], [0, 0, 0]];
  const T1: Tri = [c1, [2, 0, 0], [1.5, 1, 0]];
  const T2: Tri = [c2, [1, -1, 0], [2, -1, 0]];

  const orders: Tri[][] = [
    [T0, T1, T2], [T1, T0, T2], [T2, T1, T0], [T1, T2, T0], [T0, T2, T1], [T2, T0, T1],
  ];
  const signatures = new Set(
    orders.map((tris) => cacheSignature(buildGeometryCache(meshFrom(tris))).join('#'))
  );
  assert.equal(
    signatures.size, 1,
    `the welded cache moved with triangle emission order (${signatures.size} distinct shapes)`
  );
});

// ---------------------------------------------------------------------------
// Through the real detector.
// ---------------------------------------------------------------------------

const CAMERA = { position: { x: 5.62, y: 5, z: -4 }, fov: Math.PI / 4 };
const SCREEN_H = 800;
const NO_LOCK = { edge: null, meshExpressId: null, lockStrength: 0 };
const RAY = { origin: CAMERA.position, direction: { x: 0, y: -1, z: 0 } };

function hitAt(z: number): Intersection {
  return {
    point: { x: 5.62, y: 0, z },
    normal: { x: 0, y: 1, z: 0 },
    distance: 5,
    meshIndex: 0,
    triangleIndex: 0,
    expressId: 1,
    barycentricCoord: { u: 1, v: 0, w: 0 },
  };
}

function reportedEdgeLength(vertices: Vec3[] | undefined): number {
  if (!vertices || vertices.length < 2) return NaN;
  const [a, b] = vertices;
  return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
}

test('#2199 the detector reports the whole 2.000 m edge everywhere along it', () => {
  const meshes = [slabOpeningEdge(false)];
  for (const z of [-4.9, -4.5, -4.0, -3.5, -3.1]) {
    const detector = new SnapDetector();
    const result = detector.detectMagneticSnap(RAY, meshes, hitAt(z), CAMERA, SCREEN_H, NO_LOCK);
    const length = reportedEdgeLength(result.snapTarget?.metadata?.vertices);
    assert.ok(
      Math.abs(length - 2) < 1e-4,
      `cursor z=${z} reported an edge of ${length.toFixed(4)} m, not 2.0000`
    );
  }
});

test('#2199 the snap point does not freeze on an interior split vertex', () => {
  // z = -4.800 is where the y = 0 face subdivides the edge. With nothing else
  // meeting there it is not a corner, so the cursor keeps sliding.
  const detector = new SnapDetector();
  const result = detector.detectMagneticSnap(
    RAY, [slabOpeningEdge(false)], hitAt(-4.8), CAMERA, SCREEN_H, NO_LOCK
  );
  assert.equal(result.snapTarget?.type, SnapType.EDGE, 'an interior split is not a corner');
  assert.equal(result.edgeLock.isCorner, false);
});

test('#2199 a real junction inside a merged run still snaps as a vertex', () => {
  // Approach the junction along the run from z = -4.750: the winning candidate
  // is the merged run itself (the rib's own edges are further away), so the
  // vertex snap can only come from the junction the run was merged through.
  const detector = new SnapDetector();
  const result = detector.detectMagneticSnap(
    RAY, [slabOpeningEdge(true)], hitAt(-4.75), CAMERA, SCREEN_H, NO_LOCK
  );
  assert.equal(result.snapTarget?.type, SnapType.VERTEX, 'the junction must keep its vertex snap');
  assert.ok(Math.abs((result.snapTarget?.position.z ?? 0) + 4.8) < 1e-4);
  // The vertex SNAP is exact through snapTarget.position, but the corner RING
  // contract is endpoint-only: `edgeLock.isCorner`'s sole consumer draws the
  // ring at `edgeT < 0.5 ? v0 : v1` - a start/end boolean that would place a
  // mid-run junction up to half the run away (0.200 m here, at z = -5.000
  // instead of -4.800). Junction rings are deferred until that consumer
  // (PR #2641) can carry a corner position, so a junction must NOT set it.
  assert.equal(result.edgeLock.isCorner, false, 'a mid-run junction must not claim the endpoint-ring contract');
  assert.equal(result.edgeLock.cornerValence, 0);
  // ...and the run it sits on is still the whole 2.000 m edge.
  const length = reportedEdgeLength(result.snapTarget?.metadata?.vertices);
  assert.ok(Math.abs(length - 2) < 1e-4, `highlighted ${length.toFixed(4)} m, not 2.0000`);

  // The same cursor on the fixture WITHOUT the rib keeps sliding, so the pair
  // pins both directions: split -> no corner, junction -> corner.
  const plain = new SnapDetector().detectMagneticSnap(
    RAY, [slabOpeningEdge(false)], hitAt(-4.75), CAMERA, SCREEN_H, NO_LOCK
  );
  assert.equal(plain.snapTarget?.type, SnapType.EDGE);
});

test('#2199 a reversed edge lock finds an interior junction at the mirrored parameter', () => {
  // The cached run is stored lexicographically: v0 = (5.6, 0, -5),
  // v1 = (5.6, 0, -3), junction at z = -4.8, i.e. cached t = 0.1. A caller can
  // hold the lock in the REVERSE orientation (locks are acquired from its own
  // state, not re-read from the cache each frame). maintainEdgeLock swaps the
  // endpoints and endpoint valences into the lock's orientation - and must
  // mirror every junction parameter with it (t -> 1 - t), because `edgeT` is
  // computed along the LOCK. Unmirrored, the junction "lived" at the cursor
  // position that mirrors the real one, so the real junction lost its vertex
  // snap under a reversed lock.
  const meshes = [slabOpeningEdge(true)];
  const reversedLock = {
    edge: { v0: { x: 5.6, y: 0, z: -3 }, v1: { x: 5.6, y: 0, z: -5 } },
    meshExpressId: 1,
    lockStrength: 0.5,
  };

  // Cursor on the real junction: lock-space t = 0.9, cached t = 0.1.
  const detector = new SnapDetector();
  const atJunction = detector.detectMagneticSnap(
    RAY, meshes, hitAt(-4.8), CAMERA, SCREEN_H, reversedLock
  );
  assert.equal(
    atJunction.snapTarget?.type, SnapType.VERTEX,
    'the junction must keep its vertex snap under a reversed lock'
  );
  assert.ok(Math.abs((atJunction.snapTarget?.position.z ?? 0) + 4.8) < 1e-4);
  // The endpoint-only ring contract holds in this orientation too.
  assert.equal(atJunction.edgeLock.isCorner, false);
  assert.equal(atJunction.edgeLock.cornerValence, 0);

  // The MIRRORED cursor position (lock-space t = 0.1, where the unflipped
  // parameter used to sit) is plain edge sliding - this guards against
  // "fixing" the flip on edgeT instead of on the junction parameters.
  const atMirror = new SnapDetector().detectMagneticSnap(
    RAY, meshes, hitAt(-3.2), CAMERA, SCREEN_H, reversedLock
  );
  assert.equal(
    atMirror.snapTarget?.type, SnapType.EDGE,
    'the mirror of the junction parameter must not read as a corner'
  );
});

test('#2199 an endpoint corner still carries the ring contract, consistently with edgeT', () => {
  // Cursor near the z = -5.000 end of the 2.000 m run: the corner IS a run
  // endpoint, so `edgeLock.isCorner` fires, and `edgeT < 0.5` names exactly
  // the endpoint that was snapped - the contract the ring consumer assumes.
  const result = new SnapDetector().detectMagneticSnap(
    RAY, [slabOpeningEdge(false)], hitAt(-4.95), CAMERA, SCREEN_H, NO_LOCK
  );
  assert.equal(result.snapTarget?.type, SnapType.VERTEX);
  assert.ok(Math.abs((result.snapTarget?.position.z ?? 0) + 5) < 1e-4);
  assert.equal(result.edgeLock.isCorner, true);
  assert.ok(result.edgeLock.cornerValence >= 2);
  assert.ok(result.edgeLock.edgeT < 0.5, 'edgeT must name the snapped end');
});

test('#2199 a shallow real crease stays snappable through the detector', () => {
  // The measured regression case, reduced: infra-bridge.ifc #723 carries a
  // 3.500 m deck edge whose faces meet at 3.617 degrees. Under a 0.98 coplanar
  // cutoff it vanished from the cache and a cursor 21 mm away (camera 5 m,
  // 800 px, 20 px radius) fell through to FACE - the crease was unsnappable
  // and unmeasurable. Same configuration on the hinged fixture.
  const cursor = { x: 0.5, y: 0, z: -0.021 };
  const camera = { position: { x: 0.5, y: 5, z: -0.021 }, fov: Math.PI / 4 };
  const result = new SnapDetector().detectMagneticSnap(
    { origin: camera.position, direction: { x: 0, y: -1, z: 0 } },
    [hinged(3.617)],
    {
      point: cursor, normal: { x: 0, y: 1, z: 0 }, distance: 5, meshIndex: 0,
      triangleIndex: 0, expressId: 1, barycentricCoord: { u: 1, v: 0, w: 0 },
    },
    camera, SCREEN_H, NO_LOCK
  );
  assert.equal(result.snapTarget?.type, SnapType.EDGE, 'a 3.617 degree crease must be an edge snap target');
  assert.ok(Math.abs(result.snapTarget?.position.z ?? 1) < 1e-5, 'the snap point must land on the hinge line');
});

test('#2199 the answer does not depend on triangle emission order', () => {
  // Reversing the triangle order permutes the cache, which is exactly what a
  // change in the wasm mesher does. The reported edge must not move (#2388).
  const forward = slabOpeningEdge(false);
  const reversedTris: Tri[] = [];
  const indices = forward.indices as Uint32Array;
  const positions = forward.positions;
  for (let t = indices.length / 3 - 1; t >= 0; t--) {
    const v = (k: number): P => {
      const i = indices[t * 3 + k] * 3;
      return [positions[i], positions[i + 1], positions[i + 2]];
    };
    reversedTris.push([v(0), v(1), v(2)]);
  }
  const reversed = meshFrom(reversedTris);

  assert.deepEqual(
    cacheSignature(buildGeometryCache(forward)),
    cacheSignature(buildGeometryCache(reversed)),
    'the cache must be a function of the geometry, not of the order'
  );

  for (const z of [-4.5, -4.0, -3.5]) {
    const lengthA = reportedEdgeLength(
      new SnapDetector().detectMagneticSnap(RAY, [forward], hitAt(z), CAMERA, SCREEN_H, NO_LOCK)
        .snapTarget?.metadata?.vertices
    );
    const lengthB = reportedEdgeLength(
      new SnapDetector().detectMagneticSnap(RAY, [reversed], hitAt(z), CAMERA, SCREEN_H, NO_LOCK)
        .snapTarget?.metadata?.vertices
    );
    assert.equal(lengthA.toFixed(6), lengthB.toFixed(6), `cursor z=${z} flipped with the input order`);
    assert.equal(lengthA.toFixed(4), '2.0000');
  }
});

test('#2199 equidistant candidates resolve geometrically, not by array order', () => {
  const at = (v0: Vec3, v1: Vec3, t: number): EdgeCandidate => ({
    edge: {
      v0, v1, index: 0,
      length: Math.sqrt((v1.x - v0.x) ** 2 + (v1.y - v0.y) ** 2 + (v1.z - v0.z) ** 2),
      v0Valence: 2, v1Valence: 2, junctions: [],
    },
    closestPoint: { x: 0, y: 0, z: 0 },
    distance: 0.25,
    t,
  });

  // Same distance, different lengths: the longer run is the model edge.
  const shortEdge = at({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0.5);
  const longEdge = at({ x: 0, y: 1, z: 0 }, { x: 3, y: 1, z: 0 }, 0.5);
  assert.equal(bestEdgeCandidate([shortEdge, longEdge]), longEdge);
  assert.equal(bestEdgeCandidate([longEdge, shortEdge]), longEdge);

  // Same distance and length: the one the cursor actually lies along wins over
  // the one whose closest point is clamped to an end.
  const spanning = at({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0.5);
  const clamped = at({ x: 0, y: 2, z: 0 }, { x: 2, y: 2, z: 0 }, 1);
  assert.equal(bestEdgeCandidate([clamped, spanning]), spanning);
  assert.equal(bestEdgeCandidate([spanning, clamped]), spanning);
});
