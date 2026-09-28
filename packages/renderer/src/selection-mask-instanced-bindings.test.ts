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
import { InstancedSelectionMask } from './selection-mask-pipelines.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import {
  SELECTION_MASK_DEPTH_GROUP,
  SELECTION_MASK_HOVER_GROUP,
  selectionMaskFragmentSource,
} from './shaders/selection-mask.wgsl.js';

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

describe('instanced mask bind groups (#5745)', () => {
  it('keeps the hover uniform out of the mesh-uniform and depth groups', () => {
    assert.notEqual(SELECTION_MASK_HOVER_GROUP, 0);
    assert.notEqual(SELECTION_MASK_HOVER_GROUP, SELECTION_MASK_DEPTH_GROUP);
    assert.match(mainShaderSource, /@binding\(0\) @group\(0\) var<uniform> uniforms: Uniforms;/, 'vs_instanced reads the mesh uniform at group 0');
  });

  for (const multisampled of [false, true]) {
    const src = selectionMaskFragmentSource(multisampled, true);
    it(`declares depthTex and maskHover at the documented groups (${multisampled ? 'MSAA' : 'single-sample'})`, () => {
      const depth = /@group\((\d+)\) @binding\((\d+)\) var depthTex: (texture_depth(?:_multisampled)?_2d);/.exec(src);
      assert.ok(depth);
      assert.deepEqual([Number(depth[1]), Number(depth[2])], [SELECTION_MASK_DEPTH_GROUP, 0]);
      assert.equal(depth[3], multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d');
      const hover = /@group\((\d+)\) @binding\((\d+)\) var<uniform> maskHover: vec4<u32>;/.exec(src);
      assert.ok(hover, 'expected the maskHover uniform');
      assert.deepEqual([Number(hover[1]), Number(hover[2])], [SELECTION_MASK_HOVER_GROUP, 0]);
    });
  }

  it('the non-instanced variant declares no hover uniform (its layout has two groups)', () => {
    assert.doesNotMatch(selectionMaskFragmentSource(true), /maskHover/);
  });

  it('builds its pipeline layout in the order the shader declares', () => {
    const layouts: GPUBindGroupLayoutDescriptor[] = [];
    const pipelines: GPURenderPipelineDescriptor[] = [];
    const gpu = {
      createBindGroupLayout: (d: GPUBindGroupLayoutDescriptor) => { layouts.push(d); return d; },
      createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => d,
      createShaderModule: (d: GPUShaderModuleDescriptor) => d,
      createRenderPipeline: (d: GPURenderPipelineDescriptor) => { pipelines.push(d); return d; },
      createBuffer: (d: GPUBufferDescriptor) => ({ ...d, destroy() {} }),
      createBindGroup: (d: GPUBindGroupDescriptor) => d,
    } as unknown as GPUDevice;
    const mesh = { tag: 'mesh' } as unknown as GPUBindGroupLayout;
    const depth = { tag: 'depth' } as unknown as GPUBindGroupLayout;
    new InstancedSelectionMask(gpu, mesh, depth, true);

    assert.equal(pipelines.length, 3);
    for (const p of pipelines) {
      const groups = (p.layout as unknown as GPUPipelineLayoutDescriptor).bindGroupLayouts;
      assert.equal(groups.length, 3);
      assert.equal(groups[0], mesh, 'group 0: the mesh uniform vs_instanced reads');
      assert.equal(groups[SELECTION_MASK_DEPTH_GROUP], depth);
      const hover = groups[SELECTION_MASK_HOVER_GROUP] as unknown as GPUBindGroupLayoutDescriptor;
      assert.deepEqual([...hover.entries].map((e) => [e.binding, e.visibility, e.buffer?.type]), [[0, GPUShaderStage.FRAGMENT, 'uniform']]);
      assert.equal(p.vertex.entryPoint, 'vs_instanced');
      assert.equal(p.vertex.buffers, INSTANCED_VERTEX_BUFFERS, 'the exact layout the main instanced draw uses');
      assert.match((p.fragment!.module as unknown as GPUShaderModuleDescriptor).code, /var<uniform> maskHover/);
    }
  });
});

describe('instanced mask varyings and filters (#5745)', () => {
  const vertexOutput = locations(structBody(mainShaderSource, 'VertexOutput'));

  for (const multisampled of [false, true]) {
    const src = selectionMaskFragmentSource(multisampled, true);
    const maskInput = locations(structBody(src, 'MaskInput'));

    it(`reads every varying at vs_instanced's location and interpolation (${multisampled ? 'MSAA' : 'single-sample'})`, () => {
      for (const name of ['worldPos', 'eyePos', 'entityId', 'instSelected']) {
        const emitted = vertexOutput.get(name);
        assert.ok(emitted, `VertexOutput emits ${name}`);
        assert.deepEqual(maskInput.get(name), emitted, `${name} must match VertexOutput exactly`);
      }
    });

    it(`every entry point filters its occurrences, cuts, and takes fwidth first (${multisampled ? 'MSAA' : 'single-sample'})`, () => {
      const entries: [string, string][] = [
        ['fs_mask_selected_visible', 'isSelectedOccurrence'],
        ['fs_mask_hover_visible', 'isHoveredOccurrence'],
        ['fs_mask_selected_all', 'isSelectedOccurrence'],
      ];
      for (const [entry, filter] of entries) {
        const body = new RegExp(`fn ${entry}\\(input: MaskInput\\)[^{]*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';
        assert.match(body, new RegExp(`!${filter}\\(input\\)`), `${entry} keeps only its occurrences`);
        assert.match(body, /isCut\(input\)/, `${entry} honours the section plane / clip box`);
        if (entry.endsWith('_visible')) {
          assert.equal(body.trim().split('\n')[0]!.trim(), 'let depthSlope = fwidth(input.fragPos.z);');
        }
      }
    });
  }

  it('selected means flag bit 0 set and hidden bit 1 clear; hovered means the id and not hidden', () => {
    const src = selectionMaskFragmentSource(false, true);
    assert.match(src, /fn isSelectedOccurrence\(input: MaskInput\) -> bool \{ return \(input\.instSelected & 3u\) == 1u; \}/);
    assert.match(src, /return \(input\.instSelected & 2u\) == 0u && input\.entityId == maskHover\.x;/);
  });
});
