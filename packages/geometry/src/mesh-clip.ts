/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mesh vs. convex-volume clipping — the geometry primitive behind "split
 * objects by location" (issue #1810): cut a closed triangle mesh at the
 * boundary planes of a convex volume (a construction section / takt area /
 * zone box) into the part inside the volume and the remainder outside, with
 * both parts closed back up so each is a real solid whose volume can be
 * measured.
 *
 * Everything here is pure and dependency-free: no WASM, no IFC, no renderer.
 * It knows nothing about zones, express ids or materials — callers supply
 * `{ positions, indices }` and a list of half-space planes and get meshes
 * back. Sitting in `@ifc-lite/geometry` (not the viewer) so quantity
 * takeoff, exporters and the viewer can all reach it.
 *
 * Algorithm: Sutherland–Hodgman per triangle against one plane at a time
 * (a convex volume is just an intersection of half-spaces, so clipping is
 * sequential), fan-triangulating each clipped polygon, then rebuilding and
 * ear-clipping the cut cross-section as a cap so the result is watertight.
 *
 * ## Guarantees
 * - **Volume is conserved.** For a watertight, consistently-wound input,
 *   `meshVolume(inside) + meshVolume(outside) === meshVolume(input)` to
 *   floating-point tolerance, because the cut cross-section is capped on
 *   both sides with opposite winding.
 * - **Winding survives.** Sutherland–Hodgman walks the triangle's edges in
 *   order, so clipped polygons keep the source winding; the cap is wound
 *   from the shell's own boundary edges, so it agrees with whatever it
 *   closes rather than relying on an assumed cut direction.
 *
 * ## Limitations (deliberate, and load-bearing for callers)
 * - Coincident vertices must be **bit-identical** for the cap to close.
 *   Meshes with shared indices, or soup meshes whose duplicated corners
 *   carry identical floats, are fine — the plane-crossing points themselves
 *   are computed in a canonical vertex-index order, so adjacent triangles
 *   always agree exactly. Meshes whose seams differ in the last bit will
 *   report `capped: false`.
 * - A cut cross-section with **holes** (nested loops, e.g. slicing a pipe
 *   lengthwise into a ring) has each loop triangulated independently. The
 *   hole loop runs backwards, so its triangles cancel the outer loop's
 *   contribution and the reported volume stays correct, but the cap mesh
 *   itself self-overlaps and should not be rendered as-is.
 * - Non-convex split volumes are not supported; decompose them into convex
 *   pieces first.
 * - Vertex attributes (normals, UVs, colours) are not carried through. New
 *   vertices appear on the cut, so callers rebuild flat normals from the
 *   returned positions.
 */

/** `[x, y, z]`. */
export type ClipVec3 = readonly [number, number, number];

/**
 * One boundary of a convex volume. A point `p` is INSIDE the half-space
 * when `dot(normal, p) <= offset` — i.e. `normal` points OUT of the kept
 * region. `normal` need not be unit length; it is normalized internally, so
 * `offset` is interpreted in the same (un-normalized) units it was given in.
 */
export interface ClipPlane {
  normal: ClipVec3;
  offset: number;
}

/** Minimal triangle-mesh input. `positions` is `[x, y, z, x, y, z, ...]`,
 *  `indices` is 3 vertex indices per triangle. Accepts typed arrays or
 *  plain number arrays. */
export interface ClipMeshInput {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/**
 * A clipped piece. `positions` is `Float64Array` (not `Float32Array`): the
 * whole point of this module is that volumes add up, and f32 rounding of
 * cut vertices loses ~1e-7 relative on building-scale coordinates. Downcast
 * at the render boundary, not here.
 */
export interface ClippedMesh {
  positions: Float64Array;
  indices: Uint32Array;
  /**
   * True when every cut cross-section closed into a loop and was capped, so
   * this piece is a closed solid and {@link meshVolume} is meaningful. False
   * when capping was disabled, or when the input was not watertight enough
   * for the cut edges to chain into loops — in which case the piece is an
   * open shell and its volume is NOT the volume of anything.
   *
   * Never asserted: when no plane runs at all (an empty plane or volume list,
   * where the mesh passes straight through), it is measured off the input's
   * own boundary edges rather than assumed.
   */
  capped: boolean;
}

/** The two halves produced by cutting a mesh with one plane. */
export interface HalfSpaceClipResult {
  /** `dot(normal, p) <= offset` side. */
  inside: ClippedMesh;
  /** `dot(normal, p) >= offset` side. */
  outside: ClippedMesh;
}

/** The result of cutting a mesh against a convex volume. */
export interface ConvexClipResult {
  /** The part within every plane of the volume. */
  inside: ClippedMesh;
  /** Everything else, as one mesh (it may be several disconnected shells). */
  outside: ClippedMesh;
}

/** The result of splitting a mesh across several convex volumes. */
export interface PartitionResult {
  /** One piece per input volume, index-aligned with the `volumes` argument.
   *  A volume the mesh never reaches yields an empty piece rather than being
   *  omitted, so callers can zip parts back onto their zones by position. */
  parts: ClippedMesh[];
  /** The part of the mesh inside none of the volumes. */
  remainder: ClippedMesh;
}

export interface ClipOptions {
  /**
   * Distance (in model units, metres for IFC) within which a vertex counts
   * as lying ON the plane rather than to one side. Only affects the
   * coplanar-face test and which crossings are treated as real; it does not
   * move any geometry. Default 1e-9.
   */
  epsilon?: number;
  /**
   * Close the cut cross-section with a cap so each piece is a solid.
   * Default true. Turn it off only when you want the raw clipped shell and
   * will not be measuring volume.
   */
  cap?: boolean;
}

const DEFAULT_EPSILON = 1e-9;

/**
 * Signed volume of a closed, outward-wound triangle mesh (divergence
 * theorem: sum of the signed volumes of the tetrahedra from the origin to
 * each triangle). Positive for outward-facing winding, and origin-independent
 * for a closed mesh. Meaningless for an open shell — check `capped` first.
 */
export function meshVolume(mesh: ClipMeshInput): number {
  const { positions, indices } = mesh;
  let total = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    // dot(a, cross(b, c))
    total += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return total / 6;
}

/**
 * The six outward half-space planes of an oriented box that rotates about
 * the vertical (Y) axis only — the shape the viewer's location zones use
 * (`apps/viewer/src/lib/zones`), where `size` is FULL extents along the
 * box's own local axes and `rotationY` spins only the X/Z footprint.
 */
export function planesFromOrientedBox(box: {
  center: ClipVec3;
  size: ClipVec3;
  rotationY?: number;
}): ClipPlane[] {
  const [cx, cy, cz] = box.center;
  const hx = box.size[0] / 2;
  const hy = box.size[1] / 2;
  const hz = box.size[2] / 2;
  const rot = box.rotationY ?? 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  // Local X and Z axes in world space, matching `zoneWorldCorners`:
  // world = center + (lx*cos - lz*sin, ly, lx*sin + lz*cos).
  const u: ClipVec3 = [cos, 0, sin];
  const w: ClipVec3 = [-sin, 0, cos];
  const du = u[0] * cx + u[2] * cz;
  const dw = w[0] * cx + w[2] * cz;
  return [
    { normal: u, offset: du + hx },
    { normal: [-u[0], 0, -u[2]], offset: -du + hx },
    { normal: [0, 1, 0], offset: cy + hy },
    { normal: [0, -1, 0], offset: -cy + hy },
    { normal: w, offset: dw + hz },
    { normal: [-w[0], 0, -w[2]], offset: -dw + hz },
  ];
}

/**
 * Cut `mesh` with one plane into the `inside` (`dot(n, p) <= offset`) and
 * `outside` halves, capping the cut on both sides so each half is closed.
 */
export function clipMeshByHalfSpace(
  mesh: ClipMeshInput,
  plane: ClipPlane,
  options: ClipOptions = {},
): HalfSpaceClipResult {
  const eps = options.epsilon ?? DEFAULT_EPSILON;
  const doCap = options.cap ?? true;

  const [rawNx, rawNy, rawNz] = plane.normal;
  const len = Math.hypot(rawNx, rawNy, rawNz);
  if (len === 0) throw new Error('clipMeshByHalfSpace: plane normal must be non-zero');
  const nx = rawNx / len;
  const ny = rawNy / len;
  const nz = rawNz / len;
  const d = plane.offset / len;

  const { positions, indices } = mesh;
  const vertexCount = Math.floor(positions.length / 3);

  // Signed distance per vertex, and the binary side used for the partition.
  // A vertex ON the plane counts as INSIDE, so the two Sutherland–Hodgman
  // passes use one consistent partition and their outputs tile the source
  // triangle exactly (no gap, no double-cover). Coplanar TRIANGLES are
  // special-cased below, which is what stops "on counts as inside" from
  // mis-assigning a face that lies flush on the plane.
  const dist = new Float64Array(vertexCount);
  const outside = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    const s = nx * positions[i * 3] + ny * positions[i * 3 + 1] + nz * positions[i * 3 + 2] - d;
    dist[i] = s;
    outside[i] = s > eps ? 1 : 0;
  }

  const inBuilder = new MeshBuilder();
  const outBuilder = new MeshBuilder();

  // Plane-crossing points are cached by the UNORDERED vertex-index pair and
  // always interpolated from the lower index toward the higher one. Two
  // triangles sharing an edge traverse it in opposite directions, so without
  // this canonicalization they would compute the same point to slightly
  // different floats and the cap loop would fail to chain.
  const crossings = new Map<number, [number, number, number]>();
  const vertexAt = (i: number): [number, number, number] => [
    positions[i * 3],
    positions[i * 3 + 1],
    positions[i * 3 + 2],
  ];
  const crossing = (i: number, j: number): [number, number, number] => {
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    const cacheKey = lo * vertexCount + hi;
    const hit = crossings.get(cacheKey);
    if (hit) return hit;
    const sLo = dist[lo];
    const sHi = dist[hi];
    // Snap to an existing vertex when the crossing lands on one. `v + 1*(w -
    // v)` is NOT `w` in floating point, and a crossing that misses the shared
    // vertex by one ulp stops welding — which leaves a sliver triangle behind
    // and breaks the cap loop. Return the vertex itself instead.
    if (Math.abs(sLo) <= eps) return vertexAt(lo);
    if (Math.abs(sHi) <= eps) return vertexAt(hi);
    const den = sLo - sHi;
    const raw = Math.abs(den) < 1e-300 ? 0 : sLo / den;
    // Never extrapolate past the segment: the crossing lies on it by
    // construction, so anything outside [0, 1] is rounding noise.
    const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
    const p: [number, number, number] = [
      positions[lo * 3] + t * (positions[hi * 3] - positions[lo * 3]),
      positions[lo * 3 + 1] + t * (positions[hi * 3 + 1] - positions[lo * 3 + 1]),
      positions[lo * 3 + 2] + t * (positions[hi * 3 + 2] - positions[lo * 3 + 2]),
    ];
    crossings.set(cacheKey, p);
    return p;
  };

  const tri: [number, number, number] = [0, 0, 0];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    tri[0] = indices[t];
    tri[1] = indices[t + 1];
    tri[2] = indices[t + 2];

    const coplanar =
      Math.abs(dist[tri[0]]) <= eps && Math.abs(dist[tri[1]]) <= eps && Math.abs(dist[tri[2]]) <= eps;
    if (coplanar) {
      // A face lying flush on the plane belongs to whichever piece its solid
      // is on, which its own outward normal tells us. It is not a cut, so it
      // contributes no cap edge.
      const facesInward =
        triangleNormalDot(positions, tri[0], tri[1], tri[2], nx, ny, nz) >= 0;
      emitTriangle(facesInward ? inBuilder : outBuilder, positions, tri[0], tri[1], tri[2]);
      continue;
    }

    const outCount = outside[tri[0]] + outside[tri[1]] + outside[tri[2]];
    if (outCount === 0) {
      emitTriangle(inBuilder, positions, tri[0], tri[1], tri[2]);
      continue;
    }
    if (outCount === 3) {
      emitTriangle(outBuilder, positions, tri[0], tri[1], tri[2]);
      continue;
    }

    clipTriangle(tri, 0, inBuilder, positions, outside, crossing);
    clipTriangle(tri, 1, outBuilder, positions, outside, crossing);
  }

  const inCapped = capCrossSection(inBuilder, nx, ny, nz, d, doCap);
  const outCapped = capCrossSection(outBuilder, nx, ny, nz, d, doCap);

  return {
    inside: inBuilder.build(inCapped),
    outside: outBuilder.build(outCapped),
  };
}

/**
 * Cut `mesh` against a convex volume given as its outward half-space planes
 * (see {@link planesFromOrientedBox}). Applies the planes in sequence, so
 * `outside` is the union of what each successive plane rejected.
 *
 * An empty `planes` list means "no boundaries at all", i.e. the volume is
 * all of space: the whole mesh comes back as `inside`.
 */
export function clipMeshByConvexVolume(
  mesh: ClipMeshInput,
  planes: readonly ClipPlane[],
  options: ClipOptions = {},
): ConvexClipResult {
  const seedPositions = toFloat64(mesh.positions);
  const seedIndices = toUint32(mesh.indices);
  if (planes.length === 0) {
    // No plane runs, so nothing re-derives `capped` downstream — it has to be
    // measured off the input here or the caller receives an unexamined claim.
    return {
      inside: {
        positions: seedPositions,
        indices: seedIndices,
        capped: isClosedMesh(seedPositions, seedIndices),
      },
      outside: mergeMeshes([]),
    };
  }
  let inside: ClippedMesh = {
    positions: seedPositions,
    indices: seedIndices,
    capped: true,
  };
  const rejected: ClippedMesh[] = [];
  for (const plane of planes) {
    if (inside.indices.length === 0) {
      // Nothing left to cut, but later planes still cannot un-reject
      // anything, so stop rather than churn through empty meshes.
      inside = { positions: new Float64Array(0), indices: new Uint32Array(0), capped: inside.capped };
      break;
    }
    const step = clipMeshByHalfSpace(inside, plane, options);
    rejected.push(step.outside);
    inside = { ...step.inside, capped: step.inside.capped && inside.capped };
  }
  return { inside, outside: mergeMeshes(rejected) };
}

/**
 * Split `mesh` across several convex volumes, returning one piece per volume
 * plus whatever fell outside all of them.
 *
 * Volumes are applied in order and each piece is carved out of what is left,
 * so OVERLAPPING volumes do not double-count: the overlap lands in the
 * earlier volume. Together, `parts` and `remainder` reproduce the input
 * exactly — `sum(meshVolume(parts)) + meshVolume(remainder)` equals
 * `meshVolume(mesh)`, which is the property that makes a per-zone quantity
 * breakdown trustworthy.
 */
export function partitionMeshByConvexVolumes(
  mesh: ClipMeshInput,
  volumes: readonly (readonly ClipPlane[])[],
  options: ClipOptions = {},
): PartitionResult {
  const seedPositions = toFloat64(mesh.positions);
  const seedIndices = toUint32(mesh.indices);
  if (volumes.length === 0) {
    // Same reason as in clipMeshByConvexVolume: with no volume to clip
    // against, the seed IS the answer, so it must be measured not asserted.
    return {
      parts: [],
      remainder: {
        positions: seedPositions,
        indices: seedIndices,
        capped: isClosedMesh(seedPositions, seedIndices),
      },
    };
  }
  const parts: ClippedMesh[] = [];
  let rest: ClipMeshInput & { capped: boolean } = {
    positions: seedPositions,
    indices: seedIndices,
    capped: true,
  };
  for (const planes of volumes) {
    const { inside, outside } = clipMeshByConvexVolume(rest, planes, options);
    parts.push({ ...inside, capped: inside.capped && rest.capped });
    rest = { ...outside, capped: outside.capped && rest.capped };
  }
  return {
    parts,
    remainder: { positions: toFloat64(rest.positions), indices: toUint32(rest.indices), capped: rest.capped },
  };
}

// ===========================================================================
// Internals
// ===========================================================================

function toFloat64(a: ArrayLike<number>): Float64Array {
  return a instanceof Float64Array ? a : Float64Array.from(a as ArrayLike<number>);
}

function toUint32(a: ArrayLike<number>): Uint32Array {
  return a instanceof Uint32Array ? a : Uint32Array.from(a as ArrayLike<number>);
}

/**
 * True when `mesh` is a closed surface — the same boundary-edge test
 * {@link capCrossSection} uses on a clipped piece, applied to a raw input:
 * a directed edge with no opposite anywhere in the mesh is a boundary, and a
 * mesh with a boundary is an open shell, not a solid.
 *
 * Vertices are welded by exact coordinate first (the key {@link MeshBuilder}
 * welds on), so a "soup" mesh whose duplicated corners carry identical floats
 * is recognised as closed, matching what the clipper itself would produce.
 * Zero-area triangles are skipped for the same reason `MeshBuilder.triangle`
 * drops them: they contribute no surface and therefore no boundary.
 */
function isClosedMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): boolean {
  if (indices.length === 0) return true;

  const vertexCount = Math.floor(positions.length / 3);
  const weld = new Map<string, number>();
  const canonical = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
    const hit = weld.get(key);
    if (hit === undefined) {
      weld.set(key, i);
      canonical[i] = i;
    } else {
      canonical[i] = hit;
    }
  }

  const directed = new Set<number>();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = canonical[indices[t]];
    const b = canonical[indices[t + 1]];
    const c = canonical[indices[t + 2]];
    if (a === b || b === c || a === c) continue;
    directed.add(a * vertexCount + b);
    directed.add(b * vertexCount + c);
    directed.add(c * vertexCount + a);
  }
  for (const edge of directed) {
    const a = Math.floor(edge / vertexCount);
    const b = edge % vertexCount;
    if (!directed.has(b * vertexCount + a)) return false;
  }
  return true;
}

function mergeMeshes(meshes: readonly ClippedMesh[]): ClippedMesh {
  if (meshes.length === 1) return meshes[0];
  let vTotal = 0;
  let iTotal = 0;
  let capped = true;
  for (const m of meshes) {
    vTotal += m.positions.length;
    iTotal += m.indices.length;
    capped = capped && m.capped;
  }
  const positions = new Float64Array(vTotal);
  const indices = new Uint32Array(iTotal);
  let vOff = 0;
  let iOff = 0;
  for (const m of meshes) {
    positions.set(m.positions, vOff);
    const base = vOff / 3;
    for (let k = 0; k < m.indices.length; k += 1) indices[iOff + k] = m.indices[k] + base;
    vOff += m.positions.length;
    iOff += m.indices.length;
  }
  return { positions, indices, capped };
}

/** Accumulates positions + triangles, welding exactly-coincident vertices so
 *  cut points shared by neighbouring triangles become one vertex (which is
 *  what lets the cap loop chain by index). */
class MeshBuilder {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  private readonly lookup = new Map<string, number>();

  vertex(x: number, y: number, z: number): number {
    const k = `${x},${y},${z}`;
    const hit = this.lookup.get(k);
    if (hit !== undefined) return hit;
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.lookup.set(k, index);
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    // A welded duplicate index means the triangle collapsed to a line or a
    // point: zero area, zero volume, nothing to render. Drop it.
    if (a === b || b === c || a === c) return;
    this.indices.push(a, b, c);
  }

  point(i: number): [number, number, number] {
    return [this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]];
  }

  build(capped: boolean): ClippedMesh {
    return {
      positions: Float64Array.from(this.positions),
      indices: Uint32Array.from(this.indices),
      capped,
    };
  }
}

function triangleNormalDot(
  positions: ArrayLike<number>,
  i0: number,
  i1: number,
  i2: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
  const e1x = positions[i1 * 3] - ax, e1y = positions[i1 * 3 + 1] - ay, e1z = positions[i1 * 3 + 2] - az;
  const e2x = positions[i2 * 3] - ax, e2y = positions[i2 * 3 + 1] - ay, e2z = positions[i2 * 3 + 2] - az;
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  return cx * nx + cy * ny + cz * nz;
}

function emitTriangle(
  builder: MeshBuilder,
  positions: ArrayLike<number>,
  i0: number,
  i1: number,
  i2: number,
): void {
  const a = builder.vertex(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
  const b = builder.vertex(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
  const c = builder.vertex(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
  builder.triangle(a, b, c);
}

/**
 * Sutherland–Hodgman clip of one triangle, keeping the vertices whose
 * `outside` flag equals `keepSide`, emitted as a fan into `builder`.
 */
function clipTriangle(
  tri: readonly [number, number, number],
  keepSide: 0 | 1,
  builder: MeshBuilder,
  positions: ArrayLike<number>,
  outside: Uint8Array,
  crossing: (i: number, j: number) => [number, number, number],
): void {
  const poly: number[] = [];
  const push = (p: readonly [number, number, number]): void => {
    poly.push(builder.vertex(p[0], p[1], p[2]));
  };

  for (let k = 0; k < 3; k += 1) {
    const p = tri[k];
    const q = tri[(k + 1) % 3];
    const pKeep = outside[p] === keepSide;
    const qKeep = outside[q] === keepSide;
    if (qKeep) {
      if (!pKeep) push(crossing(p, q));
      push([positions[q * 3], positions[q * 3 + 1], positions[q * 3 + 2]]);
    } else if (pKeep) {
      push(crossing(p, q));
    }
  }

  // Fan the clipped polygon. Welding may have collapsed neighbouring entries
  // onto the same vertex (a crossing that landed exactly on an original
  // corner); those fan triangles come out with a repeated index and
  // `MeshBuilder.triangle` drops them, so no explicit de-duplication pass is
  // needed here.
  for (let k = 1; k + 1 < poly.length; k += 1) {
    builder.triangle(poly[0], poly[k], poly[k + 1]);
  }
}

/**
 * Close the hole a clip left in `builder`, using the shell's own topology
 * rather than any assumption about which way the cut ran: an edge that
 * appears in only one direction across the piece's triangles is a boundary
 * edge, and the cap patch supplies the missing opposite direction. Winding
 * therefore follows from the surface it closes — it cannot come out inverted
 * (a flipped cap renders black and, worse, silently negates the piece's
 * measured volume).
 *
 * Only boundary edges lying ON the clip plane are capped. A piece whose
 * boundary wanders off the plane, or whose on-plane boundary does not chain
 * into closed loops, was never a solid to begin with: it is left open and
 * `false` is returned so callers know not to trust its volume.
 */
function capCrossSection(
  builder: MeshBuilder,
  nx: number,
  ny: number,
  nz: number,
  d: number,
  doCap: boolean,
): boolean {
  const indices = builder.indices;
  if (indices.length === 0) return true;

  const vertexCount = builder.positions.length / 3;
  const directed = new Set<number>();
  for (let t = 0; t < indices.length; t += 3) {
    directed.add(indices[t] * vertexCount + indices[t + 1]);
    directed.add(indices[t + 1] * vertexCount + indices[t + 2]);
    directed.add(indices[t + 2] * vertexCount + indices[t]);
  }

  // Plane-membership tolerance. Crossing points are computed to land on the
  // plane, but only to within rounding at the scale of the coordinates.
  const tol = 1e-9 * (1 + Math.abs(d));
  const onPlane = new Uint8Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) {
    const s =
      nx * builder.positions[i * 3] +
      ny * builder.positions[i * 3 + 1] +
      nz * builder.positions[i * 3 + 2] -
      d;
    onPlane[i] = Math.abs(s) <= tol ? 1 : 0;
  }

  // Boundary edges, stored REVERSED: the cap traverses the hole the other
  // way round from the shell, which is what makes the two agree.
  const next = new Map<number, number[]>();
  let open = false;
  let count = 0;
  for (const edge of directed) {
    const a = Math.floor(edge / vertexCount);
    const b = edge % vertexCount;
    if (directed.has(b * vertexCount + a)) continue;
    if (onPlane[a] === 0 || onPlane[b] === 0) {
      open = true; // boundary that is not on the cut plane: not a solid
      continue;
    }
    const list = next.get(b);
    if (list) list.push(a);
    else next.set(b, [a]);
    count += 1;
  }
  if (count === 0) return !open;
  if (!doCap) return false;

  // 2-D basis on the plane; either handedness works because the loop's own
  // direction decides the winding.
  const [ux, uy, uz] = perpendicular(nx, ny, nz);
  const wx = ny * uz - nz * uy;
  const wy = nz * ux - nx * uz;
  const wz = nx * uy - ny * ux;

  let ok = !open;
  const startKeys = Array.from(next.keys());
  for (const start of startKeys) {
    for (;;) {
      const first = takeNext(next, start);
      if (first === undefined) break;
      const loop = [start, first];
      let cursor = first;
      let closed = false;
      // Bounded by the number of boundary edges; a malformed graph exits via
      // the `undefined` branch rather than spinning.
      for (let guard = 0; guard <= count; guard += 1) {
        if (cursor === start) {
          loop.pop();
          closed = true;
          break;
        }
        const step = takeNext(next, cursor);
        if (step === undefined) break;
        loop.push(step);
        cursor = step;
      }
      if (!closed || loop.length < 3) {
        ok = false;
        continue;
      }
      emitCap(builder, loop, ux, uy, uz, wx, wy, wz);
    }
  }
  return ok;
}

function takeNext(next: Map<number, number[]>, from: number): number | undefined {
  const list = next.get(from);
  if (!list || list.length === 0) return undefined;
  return list.pop();
}

/** Any unit vector perpendicular to `n`. */
function perpendicular(nx: number, ny: number, nz: number): [number, number, number] {
  // `(-nz, 0, nx)` is perpendicular to `n` and vanishes only for a vertical
  // `n`; `(-ny, nx, 0)` covers that case. Pick whichever is longer so the
  // basis is never built from a near-zero vector.
  const horizontal = Math.hypot(nx, nz);
  const [px, py, pz] = horizontal >= Math.abs(ny) ? [-nz, 0, nx] : [-ny, nx, 0];
  const len = Math.hypot(px, py, pz);
  return [px / len, py / len, pz / len];
}

function emitCap(
  builder: MeshBuilder,
  loop: readonly number[],
  ux: number, uy: number, uz: number,
  wx: number, wy: number, wz: number,
): void {
  const n = loop.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    const [px, py, pz] = builder.point(loop[k]);
    xs[k] = px * ux + py * uy + pz * uz;
    ys[k] = px * wx + py * wy + pz * wz;
  }

  let area2 = 0;
  for (let k = 0; k < n; k += 1) {
    const j = (k + 1) % n;
    area2 += xs[k] * ys[j] - xs[j] * ys[k];
  }
  if (area2 === 0) return; // collinear loop encloses nothing

  // Ear clipping needs a counter-clockwise polygon. If the loop runs the
  // other way, clip the reversal and emit each triangle reversed, so the
  // cap keeps the winding the loop asked for.
  const flipped = area2 < 0;
  const order = new Int32Array(n);
  for (let k = 0; k < n; k += 1) order[k] = flipped ? n - 1 - k : k;

  const ring: number[] = [];
  for (let k = 0; k < n; k += 1) ring.push(order[k]);

  const emit = (a: number, b: number, c: number): void => {
    if (flipped) builder.triangle(loop[c], loop[b], loop[a]);
    else builder.triangle(loop[a], loop[b], loop[c]);
  };

  let guard = ring.length * ring.length + 8;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < ring.length; k += 1) {
      const ia = ring[(k + ring.length - 1) % ring.length];
      const ib = ring[k];
      const ic = ring[(k + 1) % ring.length];
      const cross =
        (xs[ib] - xs[ia]) * (ys[ic] - ys[ia]) - (ys[ib] - ys[ia]) * (xs[ic] - xs[ia]);
      if (cross <= 0) continue; // reflex or straight: not an ear
      let blocked = false;
      for (const other of ring) {
        if (other === ia || other === ib || other === ic) continue;
        if (pointInTriangle2D(xs[other], ys[other], xs[ia], ys[ia], xs[ib], ys[ib], xs[ic], ys[ic])) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      emit(ia, ib, ic);
      ring.splice(k, 1);
      clipped = true;
      break;
    }
    // No ear found (self-intersecting or numerically degenerate loop): fall
    // back to a fan so the cross-section is still closed rather than left
    // as a hole.
    if (!clipped) break;
  }
  for (let k = 1; k + 1 < ring.length; k += 1) emit(ring[0], ring[k], ring[k + 1]);
}

function pointInTriangle2D(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
): boolean {
  const d1 = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  const d2 = (px - bx) * (cy - by) - (py - by) * (cx - bx);
  const d3 = (px - cx) * (ay - cy) - (py - cy) * (ax - cx);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
