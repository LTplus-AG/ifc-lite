/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCED_VERTEX_BUFFERS } from './instanced-vertex-layout.js';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { INSTANCED_RTE_DELTA_STRIDE_BYTES } from './instanced-rte.js';
import { ShadowPass } from './shadow-pass.js';
import { shadowShaderSource } from './shaders/shadow.wgsl.js';
import { Picker } from './picker.js';
import type { WebGPUDevice } from './device.js';
import { mainShaderSource } from './shaders/main.wgsl.js';

/**
 * The instanced selection/hover mask pipeline (#5745) pairs `vs_instanced`
 * with the instanced mask fragment stage in one layout. #5390's first cut
 * put the depth texture in the mesh uniform's group, every mask pipeline
 * failed validation and every frame with a selection was dropped; the unit
 * suite did not notice. These pin the instanced layout, its vertex buffers
 * and its varyings against the shader text they must agree with.
 */

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

const structBody = (src: string, name: string) => new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\s*\\}`).exec(src)?.[1] ?? '';

/** `@location(n) [@interpolate(..)] name: type` fields of a WGSL struct body. */
function locations(body: string): Map<string, { location: number; interpolate: string | null; type: string }> {
  const out = new Map<string, { location: number; interpolate: string | null; type: string }>();
  for (const m of body.matchAll(/@location\((\d+)\)\s*(?:@interpolate\((\w+)\)\s*)?(\w+):\s*([\w<>]+)/g)) {
    out.set(m[3]!, { location: Number(m[1]), interpolate: m[2] ?? null, type: m[4]! });
  }
  return out;
}

const FORMAT_TYPE: Record<string, string> = { float32x3: 'vec3<f32>', float32x4: 'vec4<f32>', uint32: 'u32' };

describe('instanced mask vertex buffers match vs_instanced (#5745)', () => {
  const inputs = new Map([...locations(structBody(mainShaderSource, 'VertexInput')), ...locations(structBody(mainShaderSource, 'InstanceInput'))]);

  it('every shader input is fed by an attribute of its type, and no attribute feeds nothing', () => {
    const attrs = INSTANCED_VERTEX_BUFFERS.flatMap((b) => [...b.attributes]);
    const byLocation = new Map(attrs.map((a) => [a.shaderLocation, a]));
    assert.equal(byLocation.size, attrs.length, 'no shader location bound twice');
    for (const [name, field] of inputs) {
      const attr = byLocation.get(field.location);
      assert.ok(attr, `${name} @location(${field.location}) has an attribute`);
      assert.equal(FORMAT_TYPE[attr.format], field.type, `${name}: ${attr.format} must feed ${field.type}`);
    }
    assert.equal(attrs.length, inputs.size, 'every attribute reaches a shader input');
  });

  it('slots 1 and 2 step per instance, each over its whole record (#6393)', () => {
    const [vertex, instance, deltas] = INSTANCED_VERTEX_BUFFERS;
    assert.equal(INSTANCED_VERTEX_BUFFERS.length, 3);
    assert.notEqual(vertex!.stepMode, 'instance');
    const end = (b: GPUVertexBufferLayout) => Math.max(...[...b.attributes].map((a) => a.offset + (a.format === 'uint32' ? 4 : 16)));
    assert.equal(instance!.stepMode, 'instance');
    assert.equal(instance!.arrayStride, INSTANCE_STRIDE_BYTES, 'the static record the scene uploads');
    assert.equal(end(instance!), INSTANCE_STRIDE_BYTES, 'the flags lane ends the record');
    assert.equal(deltas!.stepMode, 'instance');
    assert.equal(deltas!.arrayStride, INSTANCED_RTE_DELTA_STRIDE_BYTES, 'the delta stream instanced-rte uploads');
    assert.equal(end(deltas!), INSTANCED_RTE_DELTA_STRIDE_BYTES);
  });
});

/**
 * #6393: the shadow depth pass and the picker used to carry their own copies
 * of the instance layout (the picker's with a different location map), so a
 * record change had to be made three times. They now build their instanced
 * pipelines over `INSTANCED_VERTEX_BUFFERS`; pin that, and that every input
 * their shaders declare is fed at its type (the layout may carry attributes a
 * shader ignores, which WebGPU allows).
 */
describe('every instanced pipeline reads the one shared layout (#6393)', () => {
  function recordingGpu() {
    const modules: string[] = [];
    const pipelines: { label?: string; code: string; vertex: GPUVertexState }[] = [];
    const gpu = new Proxy({} as Record<string | symbol, unknown>, {
      get(_t, prop) {
        switch (prop) {
          case 'limits': return { minUniformBufferOffsetAlignment: 256 };
          case 'queue': return { writeBuffer() {} };
          case 'createShaderModule': return (d: GPUShaderModuleDescriptor) => { modules.push(d.code); return { code: d.code }; };
          case 'createRenderPipeline': return (d: GPURenderPipelineDescriptor) => {
            pipelines.push({ label: d.label, code: (d.vertex.module as unknown as { code: string }).code, vertex: d.vertex });
            return { getBindGroupLayout: () => ({}) };
          };
          case 'createBuffer': return () => ({ destroy() {} });
          case 'createTexture': return () => ({ createView: () => ({}), destroy() {} });
          default: return () => ({});
        }
      },
    }) as unknown as GPUDevice;
    return { gpu, pipelines };
  }

  /** Every `@location` input of `entry`'s parameter structs, fed from the shared layout at its WGSL type. */
  function assertFedBySharedLayout(src: string, entry: string) {
    const params = new RegExp(`fn ${entry}\\(([^)]*)\\)`).exec(src)?.[1] ?? '';
    const structs = [...params.matchAll(/:\s*(\w+)/g)].map((m) => m[1]!);
    assert.ok(structs.length >= 2, `${entry} takes a vertex and an instance struct`);
    const attrs = new Map(INSTANCED_VERTEX_BUFFERS.flatMap((b) => [...b.attributes]).map((a) => [a.shaderLocation, a]));
    let fed = 0;
    for (const struct of structs) {
      for (const [name, field] of locations(structBody(src, struct))) {
        const attr = attrs.get(field.location);
        assert.ok(attr, `${entry}: ${name} @location(${field.location}) has an attribute`);
        assert.equal(FORMAT_TYPE[attr.format], field.type, `${entry}: ${name} expects ${field.type}, layout feeds ${attr.format}`);
        fed++;
      }
    }
    assert.ok(fed > 0);
  }

  it('the shadow depth pass', () => {
    (globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1 };
    const { gpu, pipelines } = recordingGpu();
    new ShadowPass(gpu, 512);
    const instanced = pipelines.find((p) => p.label === 'shadow-pipeline-vs_shadow_instanced');
    assert.equal(instanced?.vertex.buffers, INSTANCED_VERTEX_BUFFERS);
    assertFedBySharedLayout(shadowShaderSource, 'vs_shadow_instanced');
  });

  it('the picker', () => {
    (globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4, COPY_SRC: 1 };
    (globalThis as Record<string, unknown>).GPUBufferUsage = { ...(globalThis as { GPUBufferUsage?: object }).GPUBufferUsage, STORAGE: 128 };
    const { gpu, pipelines } = recordingGpu();
    new Picker({ getDevice: () => gpu } as unknown as WebGPUDevice, 4, 4);
    const instanced = pipelines.filter((p) => p.vertex.buffers === INSTANCED_VERTEX_BUFFERS);
    assert.equal(instanced.length, 1, 'the instanced pick pipeline uses the shared layout');
    assertFedBySharedLayout(instanced[0]!.code, 'vs_main');
  });
});
