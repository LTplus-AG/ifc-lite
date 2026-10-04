/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PointCloudNode } from '../pointcloud/point-cloud-node.js';
import {
    summarizeDeviationAssets,
    type DeviationAssetRange,
    type DeviationDistances,
    type DeviationStatistics,
} from './deviation-statistics.js';

/** One scan asset's measured signed distances in metres. */
export interface DeviationAssetStats {
    expressId: number;
    modelIndex: number;
    pointsProcessed: number;
    finitePoints: number;
    minimumDeviation: number | null;
    maximumDeviation: number | null;
    meanDeviation: number | null;
    /** Full summary: |d| percentiles, RMS, σ (#6872). */
    statistics: DeviationStatistics;
}

/**
 * Read every computed point's signed distance back from the GPU, on demand.
 * The normal compute and render path does no readback.
 *
 * The result is ONE `Float32Array` (4 bytes per computed point, the size of
 * the GPU deviation buffers themselves) with each scan asset as a contiguous
 * range, so per-asset and whole-run statistics share it without a second
 * copy. One staging buffer is alive at a time, so VRAM grows by one chunk.
 */
export async function readDeviationDistances(
    device: GPUDevice,
    nodes: Iterable<PointCloudNode>,
    wasComputed: (buffer: GPUBuffer) => boolean,
): Promise<DeviationDistances> {
    const assets: DeviationAssetRange[] = [];
    const plan: Array<PointCloudNode['chunks']> = [];
    let total = 0;
    for (const node of nodes) {
        const chunks = node.chunks.filter((chunk) => chunk.pointCount > 0 && wasComputed(chunk.deviationBuffer));
        const count = chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0);
        if (count === 0) continue;
        assets.push({ expressId: node.meta.expressId, modelIndex: node.meta.modelIndex ?? 0, offset: total, count });
        plan.push(chunks);
        total += count;
    }
    const values = new Float32Array(total);
    let cursor = 0;
    for (const chunks of plan) {
        for (const chunk of chunks) {
            const size = chunk.pointCount * Float32Array.BYTES_PER_ELEMENT;
            const staging = device.createBuffer({
                size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            let mapped = false;
            try {
                const encoder = device.createCommandEncoder({ label: 'deviation-readback' });
                encoder.copyBufferToBuffer(chunk.deviationBuffer, 0, staging, 0, size);
                device.queue.submit([encoder.finish()]);
                await staging.mapAsync(GPUMapMode.READ);
                mapped = true;
                values.set(new Float32Array(staging.getMappedRange(), 0, chunk.pointCount), cursor);
                cursor += chunk.pointCount;
            } finally {
                try {
                    if (mapped) staging.unmap();
                } finally {
                    staging.destroy();
                }
            }
        }
    }
    return { values, assets };
}

/** Per-scan-asset statistics over {@link readDeviationDistances}. */
export async function readDeviationAssetStats(
    device: GPUDevice,
    nodes: Iterable<PointCloudNode>,
    wasComputed: (buffer: GPUBuffer) => boolean,
): Promise<DeviationAssetStats[]> {
    const distances = await readDeviationDistances(device, nodes, wasComputed);
    return summarizeDeviationAssets(distances).map(({ expressId, modelIndex, statistics }) => ({
        expressId,
        modelIndex,
        pointsProcessed: statistics.count,
        finitePoints: statistics.validCount,
        minimumDeviation: statistics.min,
        maximumDeviation: statistics.max,
        meanDeviation: statistics.mean,
        statistics,
    }));
}
