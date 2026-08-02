/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Textured variant of the main PBR shader (issue #961).
 *
 * Derived from `mainShaderSource` by targeted, anchored transforms rather than a
 * copy, so the lighting / section-clip / flat-normal / object-id-picking /
 * z-fight logic stays single-source in `main.wgsl.ts` and can't drift. Each
 * transform asserts its anchor exists — if `main.wgsl.ts` is edited in a way
 * that moves an anchor, the build fails loudly here instead of silently
 * shipping a stale textured shader.
 *
 * Additions over the base shader:
 *  - a `uv` vertex attribute (@location 3) threaded through to the fragment;
 *  - an albedo `texture_2d` + `sampler` at group(0) bindings 1 & 2;
 *  - the surface albedo becomes `texture(uv) * baseColor` — `baseColor` stays
 *    the authored `IfcColourRgb` (white in the annex-E fixtures), so a white
 *    tint passes the texture through unchanged while a coloured surface style
 *    still tints it.
 */
import { mainShaderSource } from './main.wgsl.js';

function replaceOnce(src: string, find: string, repl: string, label: string): string {
  const idx = src.indexOf(find);
  if (idx === -1) {
    throw new Error(
      `textured.wgsl: anchor "${label}" not found — main.wgsl.ts changed; update the textured-shader derivation.`,
    );
  }
  if (src.indexOf(find, idx + find.length) !== -1) {
    throw new Error(`textured.wgsl: anchor "${label}" is not unique — tighten the derivation.`);
  }
  return src.slice(0, idx) + repl + src.slice(idx + find.length);
}

function deriveTexturedShader(): string {
  let s = mainShaderSource;

  // 1. Albedo texture + sampler bindings (same group(0) as the uniform).
  s = replaceOnce(
    s,
    '@binding(0) @group(0) var<uniform> uniforms: Uniforms;',
    '@binding(0) @group(0) var<uniform> uniforms: Uniforms;\n' +
      '        @binding(1) @group(0) var albedoTex: texture_2d<f32>;\n' +
      '        @binding(2) @group(0) var albedoSampler: sampler;',
    'uniform binding',
  );

  // 2. UV vertex attribute on VertexInput. Placed at @location(10), NOT 3-9:
  //    main.wgsl also declares vs_instanced + InstanceInput at vertex-input
  //    @location 3..9 (mat4 3-6, entityId 7, colour 8, selected flag 9), which
  //    this derived module still contains (unused by the textured pipeline). A uv
  //    in 3..9 would collide with InstanceInput in vs_instanced's input interface
  //    = a shader-creation error. @10 is clear of both the per-vertex inputs
  //    (0..2) and the per-instance inputs (3..9). The textured pipeline's slot-0
  //    uv attribute uses shaderLocation 10 to match.
  s = replaceOnce(
    s,
    '          @location(2) entityId: u32,\n        }\n\n        struct VertexOutput {',
    '          @location(2) entityId: u32,\n          @location(10) uv: vec2<f32>,\n        }\n\n        struct VertexOutput {',
    'VertexInput uv',
  );

  // 3. UV interpolant on VertexOutput (after the @location(5) instSelected varying).
  s = replaceOnce(
    s,
    '          @location(5) @interpolate(flat) instSelected: u32,\n        }',
    '          @location(5) @interpolate(flat) instSelected: u32,\n          @location(6) uv: vec2<f32>,\n        }',
    'VertexOutput uv',
  );

  // 4. Pass UV through the vertex shader.
  s = replaceOnce(
    s,
    '          output.entityId = input.entityId;',
    '          output.entityId = input.entityId;\n          output.uv = input.uv;',
    'vs_main uv passthrough',
  );

  // 5. Sample the texture; multiply by the authored tint (white = passthrough).
  //    Honour the texel alpha as a cutout (alpha-keyed textures) by discarding
  //    fully-transparent texels — the textured pipeline is opaque/depth-writing,
  //    so without this RGBA textures with transparent regions would render
  //    fully opaque. (Partial translucency would need a transparent textured
  //    pipeline — out of scope for the cutout case.)
  // main.wgsl now reads the per-draw albedo from the `input.color` varying
  // (vs_main writes uniforms.baseColor into it). For textured meshes input.color
  // == uniforms.baseColor (drawn via vs_main, never instanced), so multiplying
  // the texel by input.color keeps the authored-tint semantics.
  s = replaceOnce(
    s,
    'var baseColor = input.color.rgb;',
    'let albedoTexel = textureSample(albedoTex, albedoSampler, input.uv);\n' +
      '          if (albedoTexel.a < 0.004) { discard; }\n' +
      '          var baseColor = albedoTexel.rgb * input.color.rgb;',
    'albedo sample',
  );

  return s;
}

export const texturedShaderSource = deriveTexturedShader();
