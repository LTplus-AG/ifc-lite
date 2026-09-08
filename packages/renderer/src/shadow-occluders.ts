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

import type { BatchedMesh, Mesh } from './types.js';
import type { InstancedTemplateGPU, TexturedMesh } from './scene.js';
import type { ShadowOccluderDraw } from './shadow-pass.js';
import { isEntityVisible } from './entity-visibility.js';

/** The draw lists a `Scene` exposes, as the collector needs them. */
export interface ShadowOccluderSources {
  batches: readonly BatchedMesh[];
  instanced: readonly InstancedTemplateGPU[];
  textured: readonly TexturedMesh[];
  /**
   * Individual meshes (the `Renderer.addMesh()` / no-batch fallback path).
   * Optional — the batched viewer never populates it. Hydrated meshes (lazy
   * selection-highlight copies that duplicate batch geometry) are skipped so
   * they don't double-cast.
   */
  meshes?: readonly Mesh[];
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
 * How a shared batch stands under the current hide/isolate state (#2670, Phase
 * 2b), so the renderer can feed the shadow collector the SAME visible subset the
 * colour pass draws:
 * - `all` — no filtering, or every element visible → cast the batch's own buffers.
 * - `none` — every element hidden/excluded → the batch does not cast at all.
 * - `partial` — a mix → cast only `visibleIds` (via the colour pass's cached
 *   partial sub-batch), so an individually-hidden element stops casting instead
 *   of throwing a phantom shadow.
 *
 * Uses {@link isEntityVisible}, so the empty-isolate-hides-everything and
 * hiding-wins-over-isolation rules match every other visibility surface exactly.
 */
export type BatchVisibilityClass =
  | { kind: 'all' }
  | { kind: 'none' }
  | { kind: 'partial'; visibleIds: Set<number> };

export function classifyBatchVisibility(
  expressIds: readonly number[],
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): BatchVisibilityClass {
  // No active filter → the whole batch is visible (fast path, no Set built).
  if ((hiddenIds == null || hiddenIds.size === 0) && isolatedIds == null) {
    return { kind: 'all' };
  }
  const visibleIds = new Set<number>();
  for (const id of expressIds) {
    if (isEntityVisible(id, hiddenIds, isolatedIds)) visibleIds.add(id);
  }
  if (visibleIds.size === 0) return { kind: 'none' };
  if (visibleIds.size === expressIds.length) return { kind: 'all' };
  return { kind: 'partial', visibleIds };
}

/**
 * Collect every occluder draw for the shadow depth pass.
 *
 * A batch casts if it is GPU-resident, opaque enough (material alpha >=
 * `minCastAlpha` — transparent glass lets light through, see
 * {@link ShadowOccluderOptions.minCastAlpha}) and has at least one visible
 * element. Per-element hide/isolate within a shared batch is applied UPSTREAM:
 * the renderer feeds this collector the same visible subset it draws (a
 * fully-hidden batch is dropped, a partially-hidden one arrives as its visible
 * sub-batch), so `sources.batches` is already visibility-correct. Instanced
 * templates carry a per-occurrence HIDDEN flag the depth shader discards on, so
 * a hidden/isolated occurrence stops casting. Textured meshes are filtered per
 * element like the main textured sub-pass.
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

  // Individual meshes (Renderer.addMesh() / no-batch fallback). Same 28-byte
  // flat vertex layout as a batch, so kind 'flat'; the mesh's full transform is
  // the model matrix. Skip hydrated meshes (selection-highlight copies that
  // duplicate batch geometry — they would double-cast).
  for (const mesh of sources.meshes ?? []) {
    if (mesh.hydrated) continue;
    if (!mesh.vertexBuffer || !mesh.indexBuffer || mesh.indexCount <= 0) continue;
    if (mesh.color[3] < minCastAlpha) continue; // transparent → light through
    if (!anyVisible([mesh.expressId], visibility)) continue;
    draws.push({
      kind: 'flat',
      vertexBuffer: mesh.vertexBuffer,
      indexBuffer: mesh.indexBuffer,
      indexCount: mesh.indexCount,
      model: mesh.transform.m,
    });
  }

  return draws;
}
