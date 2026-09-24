/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two pipelines that draw the 3D section cap for
 * `Section2DOverlayRenderer`, which owns them (built here, owned there).
 *
 *  - `fill` paints the cap colour and hatch without writing depth, exactly
 *    as before.
 *  - `depth` replays the same triangles with colour writes masked off and
 *    depth writes on, straight after the fill. Without it the depth buffer
 *    under a cap still holds the clipped element's inside faces, which the
 *    screen-space passes that read depth after the scene pass (ambient
 *    occlusion, #5384) take for a deep narrow slot, darkening the cap.
 *    Colour-masked, the replay changes no pixel. It is a separate draw rather
 *    than a depth write on `fill` because base and layer cap polygons are
 *    coplanar and drawn in one call: with depth writes on `fill`, each layer
 *    polygon would stay visible over its base only where their depths tie
 *    bit-exactly.
 */

import { PIPELINE_CONSTANTS } from './constants.js';

export interface SectionCapPipelines {
  fill: GPURenderPipeline;
  depth: GPURenderPipeline;
}

export function createSectionCapPipelines(
  device: GPUDevice,
  layout: GPUPipelineLayout,
  module: GPUShaderModule,
  format: GPUTextureFormat,
  sampleCount: number,
): SectionCapPipelines {
  const vertex: GPUVertexState = {
    module,
    entryPoint: 'vs_main',
    buffers: [
      {
        arrayStride: 28, // 3 position + 4 color = 7 floats
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x4' },
        ],
      },
    ],
  };
  const primitive: GPUPrimitiveState = { topology: 'triangle-list', cullMode: 'none' };
  const depthStencil: GPUDepthStencilState = {
    format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
    depthWriteEnabled: false,
    // 'greater-equal' (reverse-Z): draw the cap fill when its depth is at
    // least as close as whatever the main opaque pass already wrote. The
    // cap polygons live exactly on the section plane, which coincides
    // with below-plane top faces — 'greater-equal' lets them tie cleanly
    // there. Where nearer model geometry (e.g. a wall in front of the
    // cut, viewed at an angle) wrote a closer depth, the cap fails the
    // test and is occluded — the user no longer sees cap hatch painted
    // through model elements that ought to be in front of it.
    depthCompare: 'greater-equal',
  };
  const multisample: GPUMultisampleState = { count: sampleCount };
  // The main render pass has two colour attachments (main colour + picker
  // objectId). Pipelines used inside that pass must declare matching
  // targets — the objectId slot writes nothing so the pass's picking IDs
  // underneath are preserved.
  const objectIdTarget: GPUColorTargetState = { format: 'rgba8unorm', writeMask: 0 };

  const fill = device.createRenderPipeline({
    layout,
    vertex,
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
        objectIdTarget,
      ],
    },
    primitive,
    depthStencil,
    multisample,
  });
  const depth = device.createRenderPipeline({
    layout,
    vertex,
    fragment: { module, entryPoint: 'fs_main', targets: [{ format, writeMask: 0 }, objectIdTarget] },
    primitive,
    depthStencil: { ...depthStencil, depthWriteEnabled: true },
    multisample,
  });
  return { fill, depth };
}
