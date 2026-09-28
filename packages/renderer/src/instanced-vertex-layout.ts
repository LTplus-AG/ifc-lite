/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vertex buffers `main.wgsl.ts`'s `vs_instanced` reads: the template's
 * 28-byte vertex (slot 0, pos + normal + entityId; that per-vertex entityId is
 * unused, the per-instance one wins, but it keeps slot 0 identical to the flat
 * layout) and the per-occurrence record (slot 1, stepMode 'instance'): the
 * mat4 as four column vec4s, entityId, rgba, flags and the RTE anchor.
 *
 * One definition for every pipeline that draws instanced geometry (the main
 * opaque / transparent instanced pipelines in `pipeline.ts` and the
 * selection/hover mask, #5745), so a mask can never land somewhere the
 * occurrence was not drawn. `selection-mask-instanced-bindings.test.ts` pins
 * it against the shader's `InstanceInput`.
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
    arrayStride: 120, // V2: V1 record (88) + anchor high/low vec4s
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 3, offset: 0, format: 'float32x4' }, // instMat col0
      { shaderLocation: 4, offset: 16, format: 'float32x4' }, // col1
      { shaderLocation: 5, offset: 32, format: 'float32x4' }, // col2
      { shaderLocation: 6, offset: 48, format: 'float32x4' }, // col3
      { shaderLocation: 7, offset: 64, format: 'uint32' }, // entityId
      { shaderLocation: 8, offset: 68, format: 'float32x4' }, // rgba
      { shaderLocation: 9, offset: 84, format: 'uint32' }, // flags (bit 0 = selected, bit 1 = hidden)
      { shaderLocation: 10, offset: 88, format: 'float32x4' }, // anchor high
      { shaderLocation: 11, offset: 104, format: 'float32x4' }, // anchor low
    ],
  },
];
