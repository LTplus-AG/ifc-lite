/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seam that keeps point-cloud rendering and BIM ↔ scan deviation out of
 * `@ifc-lite/renderer/core`. The `Renderer`, its `Picker` and its post-pass
 * chain construct their point-cloud collaborators through the installed
 * factories instead of importing their classes, so a bundle that never imports
 * the package root never contains the point pipelines, their shaders, the
 * per-asset spatial index, the point picker, eye-dome lighting or the
 * deviation compute pipeline. The root entry (`index.ts`) installs them on
 * import, so `import { Renderer } from '@ifc-lite/renderer'` keeps every
 * point-cloud API it always had.
 */

import type { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import type { DeviationComputer } from './deviation/deviation-computer.js';
import type { WebGPUDevice } from './device.js';
import type { EdlPass } from './edl-pass.js';
import type { PointPicker } from './point-picker.js';

export interface PointCloudSupport {
  createPointCloudRenderer(
    device: GPUDevice,
    colorFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
    sampleCount: number,
    startHandleId: number,
  ): PointCloudRenderer;
  createDeviationComputer(): DeviationComputer;
  /** GPU id-buffer picking of point splats (`Picker`, only with point nodes). */
  createPointPicker(device: WebGPUDevice): PointPicker;
  /** Eye-dome lighting (`PostPassChain`, only while point clouds are loaded). */
  createEdlPass(device: WebGPUDevice, sampleCount: number): EdlPass;
}

let installed: PointCloudSupport | null = null;

/** Called once by the root entry; later calls replace the factories. */
export function installPointCloudSupport(support: PointCloudSupport): void {
  installed = support;
}

export function pointCloudSupport(): PointCloudSupport | null {
  return installed;
}

/** Thrown by the point-cloud and deviation APIs of a core-only Renderer. */
export function pointCloudsUnavailableError(): Error {
  return new Error(
    'Point clouds and scan deviation are not included in @ifc-lite/renderer/core. '
    + "Import Renderer from '@ifc-lite/renderer' to use them.",
  );
}
