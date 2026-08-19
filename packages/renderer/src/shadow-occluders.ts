/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Occluder collection for the sun shadow depth pass (issue #2670, Phase 2a).
 *
 * Turns the scene's three GPU draw lists into a flat {@link ShadowOccluderDraw}
 * array the {@link ShadowPass} rasterises. The whole point of this module is
 * the maintainer's acceptance criterion: EVERY geometry path must cast, or part
 * of the model silently stops shadowing. So each of the four paths —
 *
 *   • flat colour batches         → kind 'flat'
 *   • lattice-quantized batches   → kind 'quantized'
 *   • GPU-instanced templates     → kind 'instanced'
 *   • surface-textured meshes     → kind 'textured'
 *
 * is handled here, and `occluder-collection.test.ts` asserts a scene carrying
 * all four emits one occluder per path.
 *
 * Kept pure (no `Scene`, no GPU calls beyond passing buffer handles through) so
 * it is unit-testable with plain fakes.
 */

import type { BatchedMesh } from './types.js';
import type { InstancedTemplateGPU, TexturedMesh } from './scene.js';
import type { ShadowOccluderDraw } from './shadow-pass.js';

/** The three draw lists a `Scene` exposes, as the collector needs them. */
export interface ShadowOccluderSources {
  batches: readonly BatchedMesh[];
  instanced: readonly InstancedTemplateGPU[];
  textured: readonly TexturedMesh[];
}

/** Hide/isolate state, matching `RenderOptions`. */
export interface ShadowVisibility {
  hiddenIds?: ReadonlySet<number>;
  isolatedIds?: ReadonlySet<number>;
}

/** Tuning for {@link collectShadowOccluders}. */
export interface ShadowOccluderOptions {
  /**
   * Material-alpha floor for casting: geometry whose base colour alpha is below
   * this does NOT cast a shadow, so light passes through it (#2670). This is
   * how glass windows let daylight through their opening — the wall mesh keeps
   * the void, the transparent glass filling it simply stops occluding — and it
   * also spares the virtual transparent volumes (IfcSpace, IfcOpeningElement)
   * from throwing solid shadows. Uses the MATERIAL alpha (`color[3]`), not the
   * X-ray/ghost view overrides, so ghosting the model does not delete its
   * shadows. Default {@link DEFAULT_MIN_CAST_ALPHA}.
   */
  minCastAlpha?: number;
}

/**
 * Below this material alpha a surface is treated as glass-like and stops
 * casting. Solid materials are 1.0; IFC glass / spaces / openings render well
 * under it, while a lightly tinted-but-solid material (>= 0.9) still casts.
 */
export const DEFAULT_MIN_CAST_ALPHA = 0.9;

/**
 * Column-major model matrix for a per-batch/per-mesh local frame: identity
 * rotation with the origin in the translation column, matching how the main
 * pass reconstructs `world = origin + position` (the vertex buffers store
 * origin-relative positions). Reused into `out` when provided to avoid a
 * per-draw allocation on the hot path.
 */
export function originModelMatrix(
  origin: readonly [number, number, number] | undefined,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0;
  out[12] = origin ? origin[0] : 0;
  out[13] = origin ? origin[1] : 0;
  out[14] = origin ? origin[2] : 0;
  out[15] = 1;
  return out;
}

/** Whether a batch/mesh with these ids has at least one visible element. */
function anyVisible(ids: readonly number[], vis: ShadowVisibility | undefined): boolean {
  if (!vis) return true;
  const { hiddenIds, isolatedIds } = vis;
  const hasIsolate = isolatedIds != null && isolatedIds.size > 0;
  if (!hiddenIds && !hasIsolate) return true;
  for (const id of ids) {
    if (hiddenIds?.has(id)) continue;
    if (hasIsolate && !isolatedIds!.has(id)) continue;
    return true;
  }
  return false;
}

/**
 * Collect every occluder draw for the shadow depth pass.
 *
 * A batch casts if it is GPU-resident, opaque enough (material alpha >=
 * `minCastAlpha` — transparent glass lets light through, see
 * {@link ShadowOccluderOptions.minCastAlpha}) and has at least one visible
 * element (a partially-hidden batch still casts from its whole geometry —
 * hiding the shadow of individually-hidden elements within a shared batch is a
 * Phase-2b refinement). Instanced templates cast every occurrence; the
 * per-occurrence HIDDEN flag and per-occurrence transparency are not yet
 * honoured for shadows (also 2b). Textured meshes are filtered per element like
 * the main textured sub-pass.
 */
export function collectShadowOccluders(
  sources: ShadowOccluderSources,
  visibility?: ShadowVisibility,
  options?: ShadowOccluderOptions,
): ShadowOccluderDraw[] {
  const draws: ShadowOccluderDraw[] = [];
  const minCastAlpha = options?.minCastAlpha ?? DEFAULT_MIN_CAST_ALPHA;

  for (const batch of sources.batches) {
    if (batch.gpuResident === false) continue;
    if (!batch.vertexBuffer || !batch.indexBuffer || batch.indexCount <= 0) continue;
    if (batch.color[3] < minCastAlpha) continue; // transparent (glass) → light through
    if (!anyVisible(batch.expressIds, visibility)) continue;
    const q = batch.quantized;
    draws.push({
      kind: q ? 'quantized' : 'flat',
      vertexBuffer: batch.vertexBuffer,
      indexBuffer: batch.indexBuffer,
      indexCount: batch.indexCount,
      model: originModelMatrix(batch.origin),
      quantParams: q ? [q.min[0], q.min[1], q.min[2], q.step] : undefined,
    });
  }

  for (const it of sources.instanced) {
    if (!it.vertexBuffer || !it.indexBuffer || it.indexCount <= 0 || it.instanceCount <= 0) continue;
    draws.push({
      kind: 'instanced',
      vertexBuffer: it.vertexBuffer,
      indexBuffer: it.indexBuffer,
      indexCount: it.indexCount,
      instanceBuffer: it.instanceBuffer,
      instanceCount: it.instanceCount,
    });
  }

  for (const tm of sources.textured) {
    if (!tm.vertexBuffer || !tm.indexBuffer || tm.indexCount <= 0) continue;
    if (tm.color[3] < minCastAlpha) continue; // transparent → light through
    if (!anyVisible([tm.expressId], visibility)) continue;
    draws.push({
      kind: 'textured',
      vertexBuffer: tm.vertexBuffer,
      indexBuffer: tm.indexBuffer,
      indexCount: tm.indexCount,
      model: originModelMatrix(tm.origin),
    });
  }

  return draws;
}
