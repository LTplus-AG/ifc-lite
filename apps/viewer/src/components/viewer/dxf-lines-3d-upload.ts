/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runGpuUpload } from './gpu-upload-guard.js';

/** The slice of `Renderer` the DXF 3D upload effect needs. */
export interface DxfLines3DUploadTarget {
  uploadDxfLines3D(vertices: Float32Array): void;
  clearDxfLines3D(): void;
}

/**
 * Upload the merged DXF-in-3D line buffer (issue #2043), containing any
 * `createBuffer`/`writeBuffer` throw from device loss or GPU memory
 * pressure (PR #2114 review) via `runGpuUpload` — same guard as the
 * geometry-streaming upload sites (`useGeometryStreaming.ts`).
 *
 * Extracted from the `Viewport.tsx` effect so the drop-on-failure branch is
 * unit-testable with a mock renderer: this function has no GPU dependency,
 * only `renderer.uploadDxfLines3D`/`clearDxfLines3D`. The actual buffer
 * upload itself is not covered here — that requires a real GPUDevice.
 *
 * An empty `vertices` array clears the overlay (nothing to upload). A
 * failed upload also clears it — drawing from a half-written buffer would
 * be worse than showing no DXF overlay for that frame.
 */
export function uploadDxfLines3DGuarded(
  renderer: DxfLines3DUploadTarget,
  vertices: Float32Array,
): void {
  if (vertices.length === 0) {
    renderer.clearDxfLines3D();
    return;
  }
  const uploaded = runGpuUpload('uploadDxfLines3D', () => {
    renderer.uploadDxfLines3D(vertices);
    return true;
  });
  if (!uploaded) {
    renderer.clearDxfLines3D();
  }
}
