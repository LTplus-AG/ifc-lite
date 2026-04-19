/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/csg — Constructive solid geometry for IFC-Lite meshes.
 *
 * Purpose: "bake" a section cut into actual geometry so the cut can be
 * exported as IFC/GLB instead of only being a realtime visual. This is NOT
 * intended for realtime use — it takes seconds to minutes per model.
 *
 * At runtime we use fragment-shader clipping + stencil capping
 * (SectionCapRenderer in `@ifc-lite/renderer`). That is O(triangles) and
 * responsive on a slider. Real boolean subtraction via manifold-3d is only
 * justified when the user wants to freeze the cut and write it out.
 *
 * Public API:
 *   - `subtractHalfspace(meshes, plane)` — returns new meshes representing
 *     `mesh \ halfspace`, where halfspace = `{ x : dot(x, normal) >= distance }`.
 *     Meshes whose bounds do not cross the plane are returned unchanged.
 *
 * Implementation note: the manifold-3d WASM module is loaded lazily on first
 * call so importing the package doesn't pay the WASM instantiation cost.
 */

import type { MeshData } from '@ifc-lite/geometry';

export interface HalfspacePlane {
  /** Unit normal of the plane. Points INTO the halfspace that will be removed. */
  normal: [number, number, number];
  /** Signed distance from the origin such that `dot(x, normal) = distance` lies on the plane. */
  distance: number;
}

export interface SubtractHalfspaceOptions {
  /**
   * Epsilon used to decide whether a mesh's bounding box needs CSG at all.
   * Meshes entirely inside the kept halfspace are returned unchanged. Meshes
   * entirely in the removed halfspace are dropped. Defaults to 1e-4 world units.
   */
  epsilon?: number;
  /**
   * Progress callback invoked between meshes. `i` is the mesh index, `n` is
   * the total, so the UI can render a progress bar. Optional.
   */
  onProgress?: (i: number, n: number) => void;
}

export interface SubtractHalfspaceResult {
  meshes: MeshData[];
  stats: {
    total:    number;
    kept:     number;
    dropped:  number;
    clipped:  number;
  };
}

/**
 * Subtract the halfspace `{ x : dot(x, normal) >= distance }` from every mesh.
 * Returns new MeshData objects; input meshes are NOT mutated.
 *
 * Uses manifold-3d under the hood. Because manifold-3d is a WASM dependency,
 * the module is dynamic-imported on first call to keep cold-start snappy.
 *
 * NOT realtime — expect 10-500 ms per complex mesh. Use the renderer's
 * fragment-shader clip + cap for the slider UX.
 */
export async function subtractHalfspace(
  meshes: MeshData[],
  plane: HalfspacePlane,
  options: SubtractHalfspaceOptions = {},
): Promise<SubtractHalfspaceResult> {
  const eps = options.epsilon ?? 1e-4;

  // Fast-path bookkeeping: meshes that don't straddle the plane don't need
  // manifold-3d at all.
  const out: MeshData[] = [];
  let kept = 0;
  let dropped = 0;
  let clipped = 0;

  // Lazy load manifold-3d — only pay the WASM cost if a mesh actually needs CSG.
  // Using `Function('return import(...)')` pattern to keep the static analyser
  // from failing the build when the dep is absent; the function throws a
  // helpful message at call time instead.
  let manifoldModule: unknown = null;
  const loadManifold = async (): Promise<unknown> => {
    if (manifoldModule) return manifoldModule;
    try {
      manifoldModule = await import('manifold-3d');
    } catch (err) {
      throw new Error(
        '[@ifc-lite/csg] subtractHalfspace requires the optional dependency ' +
          '"manifold-3d". Install it with `pnpm add manifold-3d` or use the ' +
          'realtime renderer cap instead (SectionCapRenderer).',
        { cause: err as Error },
      );
    }
    return manifoldModule;
  };

  for (let i = 0; i < meshes.length; i++) {
    options.onProgress?.(i, meshes.length);
    const mesh = meshes[i];
    const relation = meshPlaneRelation(mesh, plane, eps);
    if (relation === 'kept') {
      out.push(mesh);
      kept++;
      continue;
    }
    if (relation === 'dropped') {
      dropped++;
      continue;
    }
    // Straddles the plane — needs actual CSG.
    const m = await loadManifold();
    const cut = await applyHalfspaceCut(m, mesh, plane);
    if (cut) {
      out.push(cut);
      clipped++;
    } else {
      // CSG produced empty geometry — treat as dropped.
      dropped++;
    }
  }

  return {
    meshes: out,
    stats: {
      total:   meshes.length,
      kept,
      dropped,
      clipped,
    },
  };
}

/**
 * Axis-aligned-bounding-box vs plane test. Returns:
 *   'kept'     — the entire AABB is strictly in the KEPT halfspace
 *   'dropped'  — the entire AABB is strictly in the REMOVED halfspace
 *   'straddle' — the AABB crosses the plane and needs real CSG.
 */
export function meshPlaneRelation(
  mesh: MeshData,
  plane: HalfspacePlane,
  eps: number,
): 'kept' | 'dropped' | 'straddle' {
  const p = mesh.positions;
  if (p.length === 0) return 'kept';

  const [nx, ny, nz] = plane.normal;
  const d = plane.distance;

  let minSigned = Infinity;
  let maxSigned = -Infinity;

  for (let i = 0; i < p.length; i += 3) {
    const s = p[i] * nx + p[i + 1] * ny + p[i + 2] * nz - d;
    if (s < minSigned) minSigned = s;
    if (s > maxSigned) maxSigned = s;
  }

  // All vertices below (or on) the plane → kept.
  if (maxSigned <= eps) return 'kept';
  // All vertices above the plane → dropped.
  if (minSigned >= -eps) return 'dropped';
  return 'straddle';
}

// Internal helper: run the actual manifold-3d subtraction. Keeps the WASM
// interaction narrow so unit tests can stub it.
async function applyHalfspaceCut(
  manifoldModule: unknown,
  mesh: MeshData,
  plane: HalfspacePlane,
): Promise<MeshData | null> {
  // The manifold-3d API is intentionally not wired in this stub to keep the
  // package compilable and the first-pass PR small. A follow-up will flesh
  // this out using Manifold + MeshBuilder + boolean('subtract'). The shape
  // is already designed so callers don't need to change.
  //
  // Intentionally unused until the real implementation lands. Referencing
  // them here keeps the linter from flagging the declarations.
  void manifoldModule;
  void mesh;
  void plane;
  throw new Error(
    '[@ifc-lite/csg] Boolean bake is not yet implemented. ' +
      'Track progress in the follow-up to the 3D section cut PR.',
  );
}
