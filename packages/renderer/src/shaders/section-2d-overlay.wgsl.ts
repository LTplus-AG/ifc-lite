/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL shaders for the section 2D overlay (cut-cap fills + overlay lines).
 *
 * Two pipelines share this file because they deliberately share ONE 160-byte
 * uniform LAYOUT: the fill shader reads `viewProj … params2` (the first 144 B)
 * and the line shader reads `viewProj`, `planeOffset` and the appended
 * `lineColor` at byte offset 144. They share the layout, not the storage — each
 * draw site gets its own record in one buffer, addressed by a dynamic
 * bind-group offset; see {@link SECTION_2D_UNIFORM_SLOT_INDEX}.
 * The two `struct Uniforms` declarations below
 * must therefore stay field-for-field compatible, and every TypeScript writer
 * must address the buffer through `SECTION_2D_UNIFORM_SLOTS` rather than a
 * hand-written index. `section-2d-uniform-layout.test.ts` parses both structs
 * out of these sources and fails if either drifts from the slot table.
 */

/**
 * Float32 indices of each field in the shared uniform buffer.
 *
 * WGSL std140-style layout: `mat4x4<f32>` is 64 B (16 floats) and each
 * `vec4<f32>` is 16 B (4 floats), all naturally aligned, so the offsets are a
 * simple running sum. These are FLOAT offsets — multiply by 4 for the byte
 * offsets quoted in the shader comments.
 */
export const SECTION_2D_UNIFORM_SLOTS = {
  /** mat4x4<f32> — floats 0..15 (bytes 0..63) */
  viewProj: 0,
  /** vec4<f32> — floats 16..19 (bytes 64..79) */
  planeOffset: 16,
  /** vec4<f32> — floats 20..23 (bytes 80..95) */
  capFillColor: 20,
  /** vec4<f32> — floats 24..27 (bytes 96..111) */
  capStrokeColor: 24,
  /** vec4<f32> x=patternId, y=spacingPx, z=angleRad, w=widthPx — floats 28..31 */
  params: 28,
  /** vec4<f32> x=secondaryAngleRad, y,z,w reserved — floats 32..35 */
  params2: 32,
  /** vec4<f32> overlay / section-cut line colour — floats 36..39 (bytes 144..159) */
  lineColor: 36,
} as const;

/** Total float count of one uniform record (40 floats = 160 bytes). */
export const SECTION_2D_UNIFORM_FLOATS = 40;

/** Total byte size of one uniform record. */
export const SECTION_2D_UNIFORM_BYTES = SECTION_2D_UNIFORM_FLOATS * 4;

/**
 * One uniform slot per draw site.
 *
 * The overlay renderer issues up to six draws into a **single** render pass —
 * the section cut cap plus five world-space line families — and every one of
 * them needs a different `lineColor` (and, for the cap, a different
 * `planeOffset` and the whole cap-style tail). With one record shared between
 * them the last `queue.writeBuffer` before submit is what the GPU sees for all
 * six: `writeBuffer` is a *queue* operation, so it is applied before the
 * command buffer that references it executes, no matter where in the encoding
 * it was issued. Every earlier draw therefore rendered with the last draw's
 * uniforms — most visibly, the clash box's colour bleeding onto the annotation,
 * alignment, grid and DXF overlays, and the cap losing its fill colour and
 * hatch to the zeroed tail the line draws write.
 *
 * Each site owning a fixed slot, addressed with a dynamic bind-group offset,
 * is what makes the six draws independent while keeping the buffer, the layout
 * and the bind group under the single owner issue #2456 insisted on. A slot per
 * site (rather than a bump allocator) needs no per-frame reset hook: each site
 * draws at most once per pass.
 */
export const SECTION_2D_UNIFORM_SLOT_INDEX = {
  /** The section cut cap: fill + outline, which share one record by design. */
  sectionCut: 0,
  annotation: 1,
  alignment: 2,
  grid: 3,
  dxf: 4,
  clashBox: 5,
} as const;

/** How many uniform records the shared buffer holds. */
export const SECTION_2D_UNIFORM_SLOT_COUNT = 6;

/**
 * Byte stride between uniform slots for `device`.
 *
 * A dynamic offset must be a multiple of `minUniformBufferOffsetAlignment`,
 * which a device reports for itself (256 is the guaranteed-supported default,
 * but a device may allow less). Round the 160-byte record up to that alignment
 * rather than assuming either number.
 */
export function sectionUniformSlotStride(device: GPUDevice): number {
  const alignment = device.limits?.minUniformBufferOffsetAlignment ?? 256;
  const safe = Number.isFinite(alignment) && alignment > 0 ? alignment : 256;
  return Math.ceil(SECTION_2D_UNIFORM_BYTES / safe) * safe;
}

/**
 * Fill shader for the cut cap.
 *
 * Applies the user-defined cap style (fill colour + screen-space hatch) on top
 * of the EXACT 2D section polygons produced by SectionCutter. Per-vertex colour
 * DRIVES the fill when a polygon opts in (alpha >= 0): a material-layer
 * wall/slab fills each layer with its own IfcMaterial colour, matching the 3D
 * build-up. Polygons that pass the sentinel alpha -1 fall back to the uniform
 * cap style, so single-material cuts read as one architectural section exactly
 * as before. Hatch + stroke apply over either base.
 */
export const SECTION_2D_CAP_FILL_WGSL = /* wgsl */ `
        struct Uniforms {
          viewProj:       mat4x4<f32>,
          planeOffset:    vec4<f32>,    // Small offset to render slightly in front of section plane
          capFillColor:   vec4<f32>,
          capStrokeColor: vec4<f32>,
          // x=patternId, y=spacingPx, z=angleRad, w=widthPx
          params:         vec4<f32>,
          // x=secondaryAngleRad, y,z,w reserved
          params2:        vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) color:    vec4<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0)       color:    vec4<f32>,
        }

        @vertex
        fn vs_main(input: VertexInput) -> VertexOutput {
          var output: VertexOutput;
          let offsetPos = input.position + uniforms.planeOffset.xyz;
          output.position = uniforms.viewProj * vec4<f32>(offsetPos, 1.0);
          output.color = input.color;
          return output;
        }

        // Screen-space hatch pattern helpers (ported from section-cap.wgsl).
        fn lineMask(u: f32, s: f32, w: f32) -> f32 {
          let f = fract(u / s) * s;
          let d = min(f, s - f);
          return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, d);
        }
        fn rotate(p: vec2<f32>, a: f32) -> vec2<f32> {
          let c = cos(a);
          let s = sin(a);
          return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
        }
        fn hatchIntensity(fragCoord: vec2<f32>, patternId: u32, spacing: f32, angle: f32, width: f32, angle2: f32) -> f32 {
          let p = fragCoord;
          if (patternId == 0u) { return 0.0; }          // solid
          if (patternId == 1u) {                         // diagonal
            let r = rotate(p, angle);
            return lineMask(r.x, spacing, width);
          }
          if (patternId == 2u) {                         // cross-hatch
            let r  = rotate(p, angle);
            let r2 = rotate(p, angle2);
            return max(lineMask(r.x, spacing, width), lineMask(r2.x, spacing, width));
          }
          if (patternId == 3u) { return lineMask(p.y, spacing, width); }    // horizontal
          if (patternId == 4u) { return lineMask(p.x, spacing, width); }    // vertical
          if (patternId == 5u) {
            // Concrete (ISO 128-50): clean regular dot grid. The previous
            // version layered dashes on top which looked noisy and broken.
            // Dots sit at every grid intersection; radius scales with
            // stroke width so the user's width slider works consistently.
            let gx = p.x - round(p.x / spacing) * spacing;
            let gy = p.y - round(p.y / spacing) * spacing;
            let d = sqrt(gx * gx + gy * gy);
            let radius = max(1.0, width * 1.2);
            return 1.0 - smoothstep(radius, radius + 1.0, d);
          }
          if (patternId == 6u) {                         // brick
            let bandH = spacing;
            let band = floor(p.y / bandH);
            // Signed parity. p is @builtin(position) today, so it is a
            // framebuffer coordinate and never negative — but u32() of a
            // negative float is an out-of-range conversion in WGSL, and the
            // moment this hatch is fed anything but fragCoord (a world- or
            // drawing-space variant) the running bond would break across
            // y = 0 in a backend-dependent way. i32(-1) & 1 is 1, so the
            // parity alternates correctly in both directions.
            let offset = select(0.0, bandH, (i32(band) & 1) == 1);
            let horiz = lineMask(p.y, bandH, width);
            let vertPos = p.x + offset * 0.5;
            let vert = step(fract(vertPos / (bandH * 2.0)), 0.02);
            return max(horiz, vert);
          }
          if (patternId == 7u) {                         // insulation
            let y = spacing * 0.5 * sin(p.x * 6.2831853 / spacing) + p.y;
            return lineMask(y, spacing, width);
          }
          return 0.0;
        }

        struct FragOut {
          @location(0) color:    vec4<f32>,
          @location(1) objectId: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragOut {
          let patternId = u32(uniforms.params.x + 0.5);
          let spacing   = max(2.0, uniforms.params.y);
          let angle     = uniforms.params.z;
          let width     = max(1.0, uniforms.params.w);
          let angle2    = uniforms.params2.x;

          let h = hatchIntensity(input.position.xy, patternId, spacing, angle, width, angle2);
          // Per-polygon colour (a material-layer slab fills with its own
          // IfcMaterial RGBA) overrides the uniform cap fill when present.
          // Polygons without a colour carry the sentinel alpha -1 and fall back
          // to the user's cap style, byte-identically. Hatch + stroke apply over
          // whichever base is chosen, so the architectural hatch still works.
          let useVertex = input.color.a >= 0.0;
          let baseFill = select(uniforms.capFillColor, input.color, useVertex);
          let rgb = mix(baseFill.rgb, uniforms.capStrokeColor.rgb, h * uniforms.capStrokeColor.a);
          let a   = max(baseFill.a, h * uniforms.capStrokeColor.a);

          var out: FragOut;
          out.color    = vec4<f32>(rgb, a);
          out.objectId = vec4<f32>(0.0, 0.0, 0.0, 0.0);
          return out;
        }
      `;

/**
 * Line shader for the section-cut outline and the standalone world-space line
 * overlays (annotation / alignment / grid / DXF / clash box).
 */
export const SECTION_2D_OVERLAY_LINE_WGSL = /* wgsl */ `
        // Mirrors the fill shader's uniform layout so both pipelines can share
        // one buffer; the line shader only reads viewProj, planeOffset and the
        // appended lineColor (byte offset 144). capFillColor/… are unused here but
        // declared for correct field offsets.
        struct Uniforms {
          viewProj: mat4x4<f32>,
          planeOffset: vec4<f32>,
          capFillColor: vec4<f32>,
          capStrokeColor: vec4<f32>,
          params: vec4<f32>,
          params2: vec4<f32>,
          lineColor: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) position: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
        }

        @vertex
        fn vs_main(input: VertexInput) -> VertexOutput {
          var output: VertexOutput;
          let offsetPos = input.position + uniforms.planeOffset.xyz;
          let clip = uniforms.viewProj * vec4<f32>(offsetPos, 1.0);
          // Reverse-Z decal nudge for lines coplanar with model faces
          // (issue #812). WebGPU forbids depthStencil.depthBias on non-
          // triangle topologies, so we do the equivalent in clip space:
          // adding a small positive multiple of clip.w raises NDC z by a
          // constant after the w-divide, which under reverse-Z means
          // "slightly closer" — enough to beat MSAA jitter on annotation
          // lines that ride exactly on a wall/floor.
          output.position = vec4<f32>(clip.x, clip.y, clip.z + 5e-5 * clip.w, clip.w);
          return output;
        }

        struct FragOutLine {
          @location(0) color:    vec4<f32>,
          @location(1) objectId: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragOutLine {
          var out: FragOutLine;
          out.color    = uniforms.lineColor;  // consumer-themeable (defaults black)
          out.objectId = vec4<f32>(0.0, 0.0, 0.0, 0.0);
          return out;
        }
      `;
