/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { INSTANCED_RTE_DELTA_STRIDE_BYTES } from './instanced-rte.js';

/**
 * Vertex buffers every instanced pipeline reads:
 *
 * - slot 0: the template's 28-byte vertex (pos + normal + entityId; that
 *   per-vertex entityId is unused, the per-instance one wins, but it keeps
 *   slot 0 identical to the flat layout);
 * - slot 1 (stepMode 'instance'): the static per-occurrence record, the mat4
 *   as four column vec4s, entityId, rgba and flags (`INSTANCE_STRIDE_BYTES`);
 * - slot 2 (stepMode 'instance'): the per-template camera-relative delta
 *   stream (`instanced-rte.ts`), the split drawable-minus-camera high/low
 *   vec4s, rewritten in ONE upload per template when the camera moves (#6393).
 *
 * One definition for every pipeline that draws instanced geometry: the main
 * opaque / transparent instanced pipelines in `pipeline.ts`, the
 * selection/hover mask (#5745), the shadow depth pass and the picker. A
 * pipeline whose shader reads only some of these locations (the shadow and
 * pick shaders skip normal, colour, ...) still uses this layout: WebGPU
 * permits layout attributes the shader does not consume, and sharing it means
 * a mask, a shadow or a pick can never read a record the colour pass laid out
 * differently. `selection-mask-instanced-bindings.test.ts` pins it against
 * every shader's `InstanceInput`.
 */
export const INSTANCED_VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 28,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
      { shaderLocation: 1, offset: 12, format: 'float32x3' }, // normal
      { shaderLocation: 2, offset: 24, format: 'uint32' }, // entityId (unused here)
    ],
  },
  {
    arrayStride: INSTANCE_STRIDE_BYTES,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 3, offset: 0, format: 'float32x4' }, // instMat col0
      { shaderLocation: 4, offset: 16, format: 'float32x4' }, // col1
      { shaderLocation: 5, offset: 32, format: 'float32x4' }, // col2
      { shaderLocation: 6, offset: 48, format: 'float32x4' }, // col3
      { shaderLocation: 7, offset: 64, format: 'uint32' }, // entityId
      { shaderLocation: 8, offset: 68, format: 'float32x4' }, // rgba
      { shaderLocation: 9, offset: 84, format: 'uint32' }, // flags (bit 0 = selected, bit 1 = hidden)
    ],
  },
  {
    arrayStride: INSTANCED_RTE_DELTA_STRIDE_BYTES,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 10, offset: 0, format: 'float32x4' }, // drawable - camera, high
      { shaderLocation: 11, offset: 16, format: 'float32x4' }, // drawable - camera, low
    ],
  },
];

/** Vertex-buffer slot of the per-template RTE delta stream (slot 2 above). */
export const INSTANCED_RTE_DELTA_SLOT = 2;
