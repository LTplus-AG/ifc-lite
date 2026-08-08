/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BIM ↔ scan deviation as a composed collaborator (issue #2425).
 *
 * Owns the whole deviation concern's state — the `DeviationPipeline`
 * and the BVH-reuse fingerprint — so the `Renderer` holds one field
 * instead of two and `computeDeviations` becomes a delegation. Nothing
 * outside this file reads either piece of state: the render loop, the
 * diagnostics counters and the bounds tracker are all untouched by it,
 * which is what makes this seam separable at all.
 *
 * The collaborator borrows (never owns) the device, the point-cloud
 * renderer and the scene — they arrive per call in `DeviationComputeContext`.
 */

import { DeviationPipeline } from './deviation-pipeline.js';
import { buildTriangleBVH } from './triangle-bvh.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { WebGPUDevice } from '../device.js';
import type { Scene } from '../scene.js';
import type { PointCloudRenderer } from '../pointcloud/point-cloud-renderer.js';

/**
 * Build a deterministic fingerprint of the BVH input mesh set so
 * `Renderer.computeDeviations` can skip the rebuild when the source
 * geometry hasn't changed. Folds in expressId / modelIndex / position
 * + index lengths per mesh so two distinct mesh sets that happen to
 * share the same aggregate position-length total can't collide on the
 * same fingerprint and reuse a stale BVH.
 */
function computeBvhFingerprint(meshes: ReadonlyArray<MeshData>): string {
    const parts: string[] = [String(meshes.length)];
    for (const m of meshes) {
        const id = m.expressId ?? -1;
        const mi = m.modelIndex ?? -1;
        const posLen = m.positions?.length ?? 0;
        const idxLen = m.indices?.length ?? 0;
        parts.push(`${id}:${mi}:${posLen}:${idxLen}`);
    }
    return parts.join('|');
}

/**
 * Aggregate every triangle source the scene exposes — individual
 * meshes (created on demand by picking / highlights) AND batched
 * meshes (the streaming geometry path's compact GPU buffers).
 * Both formats arrive as `MeshData`; the BVH builder doesn't care
 * which source they came from.
 */
function collectAllSceneMeshes(scene: Scene): MeshData[] {
    // The Scene keeps every CPU-side MeshData regardless of which
    // ingest path produced it (STEP / IFCx / GLB). One iteration
    // covers individual + batched + multi-piece + multi-model.
    // `forEachMeshData` deduplicates by identity so a colour-merged
    // batch is only added once even if it's indexed under multiple
    // contributor expressIds.
    const out: MeshData[] = [];
    scene.forEachMeshData((md) => {
        if (md.positions && md.positions.length > 0) out.push(md);
    });
    return out;
}

/** Tuning knobs for a single `DeviationComputer.compute` run. */
export interface DeviationComputeOptions {
    /** Clip range applied during compute. 0 → no clip. Default 1m. */
    maxRange?: number;
    forceRebuild?: boolean;
}

/**
 * Everything the compute pass borrows from the `Renderer` for the
 * duration of one call. None of it is retained.
 */
export interface DeviationComputeContext {
    device: WebGPUDevice;
    scene: Scene;
    pointCloudRenderer: PointCloudRenderer | null;
    requestRender: () => void;
}

/** Metadata a completed deviation pass reports back to the UI. */
export interface DeviationComputeResult {
    bvhTriangles: number;
    bvhNodes: number;
    chunksProcessed: number;
    pointsProcessed: number;
    bounds: { min: [number, number, number]; max: [number, number, number] } | null;
    suggestedHalfRange: number;
}

/**
 * Owns the deviation compute pipeline and its BVH cache.
 *
 * Lifecycle mirrors the `Renderer`'s: `init()` on device creation,
 * `destroy()` before the device goes away.
 */
export class DeviationComputer {
    private pipeline: DeviationPipeline | null = null;
    /**
     * Cache of which mesh-set the BVH was built from. We rebuild on
     * `computeDeviations` only when the cached "fingerprint" misses,
     * so re-running deviation against the same model is a fast
     * dispatch — the BVH is multi-second on big BIMs and we don't
     * want to pay that on every slider drag.
     */
    private bvhFingerprint: string | null = null;

    /**
     * Create the compute pipeline for the BIM↔scan deviation heatmap.
     * Lazily owns the per-triangle BVH GPU buffers; idle until the
     * first `compute` call.
     */
    init(device: GPUDevice): void {
        this.pipeline = new DeviationPipeline(device);
    }

    /**
     * Compute BIM ↔ scan deviation for every loaded point cloud asset.
     *
     * Walks every triangle in the scene (individual + batched meshes,
     * regardless of which IFC ingest path produced them — STEP, IFCx,
     * GLB, or federated combinations), builds a per-triangle BVH on
     * the GPU, then runs a closest-point compute pass per chunk that
     * writes signed distance into each chunk's deviation buffer.
     *
     * Returns metadata so the UI can populate a histogram + auto-range:
     * the per-asset point count, the suggested ±range from the 95th
     * percentile, and the bbox the BVH was built from.
     *
     * Idempotent: re-running with the same mesh set reuses the GPU
     * BVH (the BVH build dominates wall time on big BIMs). Pass
     * `forceRebuild: true` to invalidate.
     */
    async compute(
        opts: DeviationComputeOptions,
        ctx: DeviationComputeContext,
    ): Promise<DeviationComputeResult> {
        if (!this.pipeline || !ctx.pointCloudRenderer) {
            throw new Error('Renderer not initialised — call init() first.');
        }
        const meshes = collectAllSceneMeshes(ctx.scene);
        // Fingerprint folds in per-mesh expressId / modelIndex /
        // positions length / triangle count, so two distinct meshes
        // that happen to share an aggregate position-length total
        // can't alias each other. A federation reload that swaps one
        // model for another with the same total triangle count would
        // otherwise reuse the previous BVH and report wrong distances.
        const fingerprint = computeBvhFingerprint(meshes);
        if (opts.forceRebuild || fingerprint !== this.bvhFingerprint) {
            const bvh = buildTriangleBVH(meshes);
            this.pipeline.uploadBvh(bvh);
            this.bvhFingerprint = fingerprint;
        }
        const stats = this.pipeline.getBvhStats();
        const maxRange = opts.maxRange ?? 1.0;

        // Encode every chunk into a single command submit so the GPU
        // can pipeline the dispatches without a CPU round-trip per
        // chunk. Histogram readback is a follow-up — for v1 we emit
        // the deviation buffers and let the splat shader visualise.
        const encoder = ctx.device.getDevice().createCommandEncoder({ label: 'pointcloud-deviation' });
        let chunksProcessed = 0;
        let pointsProcessed = 0;
        const nodes = ctx.pointCloudRenderer.getInternalNodes();
        for (const node of nodes) {
            for (const chunk of node.chunks) {
                const ok = this.pipeline.dispatch(encoder, {
                    positionsBuffer: chunk.vertexBuffer,
                    deviationsBuffer: chunk.deviationBuffer,
                    pointCount: chunk.pointCount,
                    maxRange,
                    // #1804: chunk positions are stored in the asset's
                    // decode-shifted local frame when IfcMapConversion
                    // alignment is active; the BVH triangles are world
                    // space, so the compute pass must apply the same
                    // per-asset matrix the splat shader renders with.
                    model: node.model,
                });
                if (ok) {
                    chunksProcessed++;
                    pointsProcessed += chunk.pointCount;
                }
            }
        }
        ctx.device.getDevice().queue.submit([encoder.finish()]);
        // Wait until the GPU finishes the dispatches before resolving.
        // Otherwise the caller's "compute done" callback fires before
        // the deviation buffers are actually populated.
        await ctx.device.getDevice().queue.onSubmittedWorkDone();
        // The GPU is done reading each chunk's params uniform — free them.
        this.pipeline.releaseTransientParams();
        ctx.requestRender();

        // Suggest a default half-range = max(0.01m, max-extent / 1000).
        // Tighter than the maxRange clip; gives the user a reasonable
        // starting slider position without a histogram readback.
        const bb = stats.bounds;
        const suggestedHalfRange = bb
            ? Math.max(0.01, Math.max(
                bb.max[0] - bb.min[0],
                bb.max[1] - bb.min[1],
                bb.max[2] - bb.min[2],
              ) / 1000)
            : 0.05;

        return {
            bvhTriangles: stats.triangleCount,
            bvhNodes: stats.nodeCount,
            chunksProcessed,
            pointsProcessed,
            bounds: stats.bounds,
            suggestedHalfRange,
        };
    }

    /**
     * Release the compute pipeline + cached BVH GPU buffers and forget
     * the fingerprint, so a re-`init()` on a fresh device rebuilds.
     */
    destroy(): void {
        this.pipeline?.destroy();
        this.pipeline = null;
        this.bvhFingerprint = null;
    }
}
