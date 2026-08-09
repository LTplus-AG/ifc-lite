/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Winding-robust 2D outline provider backed by the Rust `meshOutline2d`
 * binding (issue #979), for the projection stage of `useDrawingGeneration`.
 *
 * Split out of the hook so the failure policy is testable on its own: the
 * provider is called ONCE PER MESH, so a binding that throws for every mesh
 * (a wasm bundle whose exported ABI no longer matches this JS — the same
 * deployment-skew class as issue #2079) would otherwise emit one log line per
 * element and drown the console. The provider therefore reports only the FIRST
 * failure and then stays quiet; a fresh provider is built per drawing
 * generation, so the next generation reports again.
 */

import type { MeshOutline2D } from '@ifc-lite/drawing-2d';

/** Handle returned by the wasm binding. Freed by the provider before it returns. */
export interface MeshOutlineHandle {
  readonly axisMin: number;
  readonly axisMax: number;
  readonly contourCount: number;
  contour(index: number): Float32Array | undefined;
  free(): void;
}

/** The `meshOutline2d` free function as exported by `@ifc-lite/wasm`. */
export type MeshOutline2dFn = (
  positions: Float32Array,
  indices: Uint32Array,
  axis: number,
  flipped: boolean,
) => MeshOutlineHandle | undefined;

/** Mesh shape the drawing generator hands to the outline provider. */
export interface MeshOutlineInput {
  positions: Float32Array;
  indices: Uint32Array;
  origin?: readonly number[];
}

export type MeshOutlineProvider = (
  mesh: MeshOutlineInput,
  axis: 'x' | 'y' | 'z',
  flipped: boolean,
) => MeshOutline2D | null;

export const AXIS_CODE: Record<'x' | 'y' | 'z', number> = { x: 0, y: 1, z: 2 };

/**
 * Build the per-generation outline provider around `outlineFn`. Returns `null`
 * from a call whose binding failed, which the generator reads as "no outline
 * for this mesh" and answers with the TS mesh silhouette instead.
 */
export function createMeshOutlineProvider(outlineFn: MeshOutline2dFn): MeshOutlineProvider {
  // Once-per-provider (= once-per-drawing-generation) log latch — see the
  // module comment for why a per-mesh log is not an option here.
  let reportedFailure = false;

  return (mesh, axis, flipped) => {
    try {
      // Positions are in the element's local frame (world = origin +
      // position). Feed WORLD positions to the outline extractor so its
      // contours + axisMin/axisMax come back in the same render-frame
      // world space as the (origin-folded) section cut. No-op when the
      // origin is absent/[0,0,0].
      const o = mesh.origin;
      let outlinePositions = mesh.positions;
      if (o && (o[0] !== 0 || o[1] !== 0 || o[2] !== 0)) {
        outlinePositions = new Float32Array(mesh.positions.length);
        for (let i = 0; i < mesh.positions.length; i += 3) {
          outlinePositions[i] = mesh.positions[i] + o[0];
          outlinePositions[i + 1] = mesh.positions[i + 1] + o[1];
          outlinePositions[i + 2] = mesh.positions[i + 2] + o[2];
        }
      }
      const handle = outlineFn(outlinePositions, mesh.indices, AXIS_CODE[axis], flipped);
      if (!handle) return null;
      try {
        const contours: Float32Array[] = [];
        for (let i = 0; i < handle.contourCount; i++) {
          const ring = handle.contour(i);
          if (ring) contours.push(ring.slice()); // copy off the WASM heap
        }
        if (contours.length === 0) return null;
        return { contours, axisMin: handle.axisMin, axisMax: handle.axisMax };
      } finally {
        handle.free();
      }
    } catch (err) {
      if (!reportedFailure) {
        reportedFailure = true;
        console.warn(
          '[drawing-2d] meshOutline2d failed; projection falls back to the TS mesh '
          + 'silhouette for the rest of this drawing. Further failures are not logged.',
          err,
        );
      }
      return null; // binding unavailable/failed → silhouette fallback
    }
  };
}
