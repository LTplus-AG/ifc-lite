/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PointCloudNode } from '../pointcloud/point-cloud-node.js';

/** One scan asset's measured signed distances in metres. */
export interface DeviationAssetStats {
    expressId: number;
    modelIndex: number;
    pointsProcessed: number;
    finitePoints: number;
    minimumDeviation: number | null;
    maximumDeviation: number | null;
    meanDeviation: number | null;
}

/**
 * Read signed distances only for an explicit export. One staging buffer is
 * alive at a time, so a large scan never needs a second full copy in RAM or
 * VRAM. The normal deviation compute and render path does no readback.
 */
export async function readDeviationAssetStats(
    device: GPUDevice,
    nodes: Iterable<PointCloudNode>,
    wasComputed: (buffer: GPUBuffer) => boolean,
): Promise<DeviationAssetStats[]> {
    const results: DeviationAssetStats[] = [];
    for (const node of nodes) {
        let count = 0;
        let finiteCount = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const chunk of node.chunks) {
            if (!wasComputed(chunk.deviationBuffer) || chunk.pointCount === 0) continue;
            const size = chunk.pointCount * Float32Array.BYTES_PER_ELEMENT;
            const staging = device.createBuffer({
                size,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            });
            let mapped = false;
            try {
                const encoder = device.createCommandEncoder({ label: 'deviation-csv-readback' });
                encoder.copyBufferToBuffer(chunk.deviationBuffer, 0, staging, 0, size);
                device.queue.submit([encoder.finish()]);
                await staging.mapAsync(GPUMapMode.READ);
                mapped = true;
                const values = new Float32Array(staging.getMappedRange());
                count += values.length;
                for (const value of values) {
                    if (!Number.isFinite(value)) continue;
                    finiteCount++;
                    sum += value;
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                }
            } finally {
                try {
                    if (mapped) staging.unmap();
                } finally {
                    staging.destroy();
                }
            }
        }
        if (count === 0) continue;
        results.push({
            expressId: node.meta.expressId,
            modelIndex: node.meta.modelIndex ?? 0,
            pointsProcessed: count,
            finitePoints: finiteCount,
            minimumDeviation: finiteCount > 0 ? min : null,
            maximumDeviation: finiteCount > 0 ? max : null,
            meanDeviation: finiteCount > 0 ? sum / finiteCount : null,
        });
    }
    return results;
}
