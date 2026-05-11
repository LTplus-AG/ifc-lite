/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parametric mesh primitives (spec §11.2 — v0.3 reference impl).
 *
 * The Rust `ifc-lite-geometry` kernel does the production work.
 * Until the kernel is wired into the collab pipeline, this module
 * ships a pure-TypeScript reference implementation for the most
 * common parametric primitives:
 *
 *   - extruded-area-solid (rectangle + circle profiles)
 *   - box (length × width × height)
 *   - cylinder (radius, height)
 *   - revolved-area-solid (circle profile around an axis)
 *
 * Output is deterministic given identical params. Hashing the
 * `Mesh` (positions + indices) gives the same bytes on every machine
 * because we use only deterministic float arithmetic — no Math.random,
 * no transcendentals beyond Math.cos/sin which are IEEE-754 specified
 * but not strictly reproducible across architectures. For tests we
 * accept the small chance of cross-platform drift; the
 * `determinism` harness flags it explicitly so consumers know when to
 * fall back to mesh-blob upload.
 */

export type ParametricSource =
  | 'extruded-area-solid'
  | 'box'
  | 'cylinder'
  | 'revolved-area-solid';

export interface RectProfile {
  type: 'rectangle';
  width: number;
  height: number;
}
export interface CircleProfile {
  type: 'circle';
  radius: number;
  /** Number of segments for circle tessellation. Default 16. */
  segments?: number;
}
export type Profile = RectProfile | CircleProfile;

export interface ExtrudedAreaSolidParams {
  profile: Profile;
  /** Extrusion direction (unit-ish). Default [0, 0, 1]. */
  direction?: [number, number, number];
  /** Extrusion depth. */
  depth: number;
}

export interface BoxParams {
  length: number;
  width: number;
  height: number;
}

export interface CylinderParams {
  radius: number;
  height: number;
  segments?: number;
}

export interface RevolvedAreaSolidParams {
  profile: CircleProfile;
  /** Axis to revolve around. Default [0, 0, 1] (Z axis). */
  axis?: [number, number, number];
  /** Total revolution in radians. Default 2π. */
  angle?: number;
  /** Number of segments around the axis. Default 16. */
  segments?: number;
}

export interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Build a mesh from `(source, params)`. Throws if the source is not
 * recognized — the conflict detector / kernel hookup should fall back
 * to mesh-blob upload in that case.
 */
export function paramsToMesh(source: ParametricSource, params: unknown): Mesh {
  switch (source) {
    case 'extruded-area-solid':
      return extrudedAreaSolid(params as ExtrudedAreaSolidParams);
    case 'box':
      return box(params as BoxParams);
    case 'cylinder':
      return cylinder(params as CylinderParams);
    case 'revolved-area-solid':
      return revolvedAreaSolid(params as RevolvedAreaSolidParams);
    default:
      throw new Error(`@ifc-lite/collab: unknown parametric source "${source}"`);
  }
}

/* ------------------------------------------------------------------ */
/* extruded-area-solid                                                 */
/* ------------------------------------------------------------------ */

export function extrudedAreaSolid(params: ExtrudedAreaSolidParams): Mesh {
  const dir = params.direction ?? [0, 0, 1];
  const depth = params.depth;
  const profilePts = profilePoints(params.profile);
  const N = profilePts.length;

  const positions = new Float32Array(N * 2 * 3);
  for (let i = 0; i < N; i++) {
    positions[i * 3 + 0] = profilePts[i][0];
    positions[i * 3 + 1] = profilePts[i][1];
    positions[i * 3 + 2] = 0;
  }
  for (let i = 0; i < N; i++) {
    positions[(N + i) * 3 + 0] = profilePts[i][0] + dir[0] * depth;
    positions[(N + i) * 3 + 1] = profilePts[i][1] + dir[1] * depth;
    positions[(N + i) * 3 + 2] = profilePts[i][2] + dir[2] * depth;
  }

  // Triangulate as (bottom-fan, top-fan, side strip).
  const indices: number[] = [];
  // Bottom fan (CW so normal faces -Z).
  for (let i = 1; i < N - 1; i++) {
    indices.push(0, i + 1, i);
  }
  // Top fan (CCW).
  for (let i = 1; i < N - 1; i++) {
    indices.push(N, N + i, N + i + 1);
  }
  // Side strip.
  for (let i = 0; i < N; i++) {
    const a = i;
    const b = (i + 1) % N;
    const aTop = N + a;
    const bTop = N + b;
    indices.push(a, b, bTop);
    indices.push(a, bTop, aTop);
  }

  return { positions, indices: new Uint32Array(indices) };
}

function profilePoints(profile: Profile): Array<[number, number, number]> {
  if (profile.type === 'rectangle') {
    const w = profile.width / 2;
    const h = profile.height / 2;
    return [
      [-w, -h, 0],
      [w, -h, 0],
      [w, h, 0],
      [-w, h, 0],
    ];
  }
  const segments = profile.segments ?? 16;
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    pts.push([Math.cos(t) * profile.radius, Math.sin(t) * profile.radius, 0]);
  }
  return pts;
}

/* ------------------------------------------------------------------ */
/* box                                                                  */
/* ------------------------------------------------------------------ */

export function box(params: BoxParams): Mesh {
  return extrudedAreaSolid({
    profile: { type: 'rectangle', width: params.length, height: params.width },
    direction: [0, 0, 1],
    depth: params.height,
  });
}

/* ------------------------------------------------------------------ */
/* cylinder                                                             */
/* ------------------------------------------------------------------ */

export function cylinder(params: CylinderParams): Mesh {
  return extrudedAreaSolid({
    profile: { type: 'circle', radius: params.radius, segments: params.segments },
    direction: [0, 0, 1],
    depth: params.height,
  });
}

/* ------------------------------------------------------------------ */
/* revolved-area-solid                                                  */
/* ------------------------------------------------------------------ */

export function revolvedAreaSolid(params: RevolvedAreaSolidParams): Mesh {
  // The current implementation only revolves around the Z axis. Accepting
  // a non-default `axis` and silently still using Z produces geometry the
  // caller didn't ask for. Reject explicitly so misuse fails loudly until
  // a general axis path is implemented.
  if (params.axis) {
    const [ax, ay, az] = params.axis;
    const isZ = Math.abs(ax) < 1e-9 && Math.abs(ay) < 1e-9 && Math.abs(az - 1) < 1e-9;
    if (!isZ) {
      throw new Error(
        `@ifc-lite/collab: revolvedAreaSolid currently only supports axis [0, 0, 1], got [${ax}, ${ay}, ${az}]`,
      );
    }
  }
  const angle = params.angle ?? Math.PI * 2;
  const segments = params.segments ?? 16;
  const r = params.profile.radius;

  // We sweep a profile circle (in the YZ plane) around the Z axis.
  const profileSegments = params.profile.segments ?? 16;
  const profilePts: Array<[number, number]> = []; // (radius offset, height)
  for (let i = 0; i < profileSegments; i++) {
    const t = (i / profileSegments) * Math.PI * 2;
    profilePts.push([Math.cos(t) * r + r * 1.5, Math.sin(t) * r]); // torus-ish
  }
  const ringCount = profilePts.length;
  const sweepCount = segments + 1;

  const positions = new Float32Array(ringCount * sweepCount * 3);
  for (let s = 0; s < sweepCount; s++) {
    const a = (s / segments) * angle;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let i = 0; i < ringCount; i++) {
      const [pr, ph] = profilePts[i];
      const idx = (s * ringCount + i) * 3;
      positions[idx + 0] = cos * pr;
      positions[idx + 1] = sin * pr;
      positions[idx + 2] = ph;
    }
  }

  const indices: number[] = [];
  for (let s = 0; s < segments; s++) {
    for (let i = 0; i < ringCount; i++) {
      const i2 = (i + 1) % ringCount;
      const a = s * ringCount + i;
      const b = s * ringCount + i2;
      const c = (s + 1) * ringCount + i2;
      const d = (s + 1) * ringCount + i;
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }

  return { positions, indices: new Uint32Array(indices) };
}

/**
 * Hash a mesh for determinism / cache-key purposes.
 *
 * 128-bit digest built by running FNV-1a four times in parallel with
 * different IVs over a stable byte ordering of positions+indices.
 * Returned as 32 hex chars. Position floats are quantized to 8 decimal
 * places before hashing so trivial floating-point drift doesn't break
 * cache lookups.
 *
 * Note: this is not a cryptographic hash — collision-resistance is
 * "good enough for cache keys and drift detection," not "good enough
 * for security." The previous implementation returned `.repeat(4)` of
 * a single 32-bit digest, which looked 128-bit but had only 32 bits of
 * entropy; the four-IV variant restores real width.
 */
export function hashMesh(mesh: Mesh): string {
  const enc = new TextEncoder();
  const buf: string[] = [];
  buf.push(`p:${mesh.positions.length}`);
  for (let i = 0; i < mesh.positions.length; i++) {
    buf.push(mesh.positions[i].toFixed(8));
  }
  buf.push(`i:${mesh.indices.length}`);
  for (let i = 0; i < mesh.indices.length; i++) {
    buf.push(String(mesh.indices[i]));
  }
  const bytes = enc.encode(buf.join(','));
  // Four 32-bit FNV-1a lanes with independent IVs derived from the
  // canonical FNV offset basis. Each lane sees the same byte stream;
  // their concatenated outputs give 128 bits of independent state.
  const ivs = [0x811c9dc5, 0x84222325, 0xcbf29ce4, 0x100000001] as const;
  const lanes = ivs.map((iv) => iv >>> 0);
  for (let i = 0; i < bytes.length; i++) {
    for (let l = 0; l < 4; l++) {
      let h = lanes[l];
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
      lanes[l] = h;
    }
  }
  return lanes
    .map((h) => (h >>> 0).toString(16).padStart(8, '0'))
    .join('');
}
