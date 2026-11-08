/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/renderer - WebGPU renderer.
 *
 * The full entry: everything `@ifc-lite/renderer/core` publishes, plus
 * point-cloud rendering and BIM ↔ scan deviation, whose factories this module
 * installs for every `Renderer` on import.
 */

import { installPointCloudSupport } from './point-cloud-support.js';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import { DeviationComputer } from './deviation/deviation-computer.js';
import { PointPicker } from './point-picker.js';
import { EdlPass } from './edl-pass.js';

installPointCloudSupport({
  createPointCloudRenderer: (device, colorFormat, depthFormat, sampleCount, startHandleId) =>
    new PointCloudRenderer(device, colorFormat, depthFormat, sampleCount, startHandleId),
  createDeviationComputer: () => new DeviationComputer(),
  createPointPicker: (device) => new PointPicker(device),
  createEdlPass: (device, sampleCount) => new EdlPass(device, sampleCount),
});

export * from './renderer.js';
export { PointCloudRenderer };
export { PointRenderPipeline } from './pointcloud/point-pipeline.js';
export { computeDeviationStatistics, computeDeviationStatisticsAsync, countWithinToleranceAsync, deviationHistogramAsync, summarizeDeviationAssetsAsync } from './deviation/deviation-statistics.js';
