/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main rendering shader for IFC geometry.
 * Features: linear-space lighting of sRGB-authored colours with a GGX
 * specular term (specular.wgsl.ts), section plane clipping, selection
 * highlight, glass, hue-preserving highlight roll-off, screen-space edge
 * enhancement.
 */
import { MESH_FLAG_RTE_DRAWABLE } from '../mesh-rte-uniforms.js';
import { colorTransferWgsl } from './color-transfer.wgsl.js';
import { mainRteWgsl, mainShadowWgsl } from './main-rte-shadow.wgsl.js';
import { relativeToEyeWgsl } from './relative-to-eye.wgsl.js';
import { specularWgsl } from './specular.wgsl.js';
import { entityColorTableWgsl } from './entity-color-table.wgsl.js';

/**
 * Translucent surfaces draw at this fraction of their alpha, so interiors
 * read through windows and X-Ray ghosts stay faint. A viewer choice that
 * predates #5386, not optics.
 */
const TRANSLUCENT_OPACITY_SCALE = 0.7;

/**
 * Converts the environment's light intensities to linear irradiance.
 *
 * The intensity scale predates the linear pipeline (#5381), which lights in
 * linear rather than lighting sRGB values and brightening them with a 2.2
 * gamma; one factor maps it instead of restating every preset. The default
 * rig delivers 0.6464 (luma) to a sun-facing horizontal surface and the
 * default exposure is 0.85, so this factor puts that surface at unit
 * irradiance by luma. The default sky tint leaves the channels within about
 * 2% of that, and colours brighter than the highlight roll-off's 0.76
 * threshold compress (see color-transfer.wgsl.ts), so mid-tones render
 * within about 2% of authored and pure white lands near 241/255. Every
 * preset and user exposure is scaled by the same factor, so their relative
 * brightness holds.
 * `light-rig.test.ts` re-derives it from the default rig.
 */
const IRRADIANCE_CALIBRATION = 1.82;

export const mainShaderSource = `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          model: mat4x4<f32>,
          baseColor: vec4<f32>,
          metallicRoughness: vec2<f32>, // x = metallic, y = roughness (mesh-material.ts)
          transmission: vec2<f32>,      // x = 1: authored translucent, drawn as glass; y = pad
          sectionPlane: vec4<f32>,      // xyz = plane normal, w = plane distance
          flags: vec4<u32>,             // x = isSelected, y = section/clip bits, z = edgeEnabled, w = edgeIntensityMilli
          clipBoxMin: vec4<f32>,        // xyz = clip-box min corner (world), w = pad
          clipBoxMax: vec4<f32>,        // xyz = clip-box max corner (world), w = pad
          quantParams: vec4<f32>, // local min xyz, lattice step w
          rteViewProj: mat4x4<f32>, // appended frame; bit 16 selects it
          drawableDeltaHigh: vec4<f32>,
          drawableDeltaLow: vec4<f32>,
          rteCameraHigh: vec4<f32>,
          rteCameraLow: vec4<f32>,
          overrideParams: vec4<u32>, // x = draw's id anchor, y = OVERRIDE_* bits (entity-color-table.ts, #6076)
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        const RTE_DRAWABLE_FLAG: u32 = ${MESH_FLAG_RTE_DRAWABLE}u;
        ${relativeToEyeWgsl}
        ${mainRteWgsl}
        // Shared group(1) lighting; packing matches packEnvironmentUniforms().
        struct Environment {
          sunDirection: vec3<f32>,      // unit vector TOWARD the sun
          sunIntensity: f32,
          sunColor: vec3<f32>,
          ambientIntensity: f32,
          skyColor: vec3<f32>,          // hemisphere-ambient sky tint
          exposure: f32,
          groundColor: vec3<f32>,       // hemisphere-ambient ground tint
          fillIntensity: f32,
          rimIntensity: f32,
          sunSoftness: f32,
          _pad1: f32,
          _pad2: f32,
        }
        @binding(0) @group(1) var<uniform> env: Environment;
        // Selection highlight tint (#5484), set by Renderer.setOverlayTheme via
        // updateSelectionColor — written only on theme change, never per frame.
        // TRUE LINEAR-LIGHT RGB: re-lit by lightTerm below exactly like the WGSL
        // constant it replaces, then ACES-tonemapped + gamma-encoded on output.
        @binding(4) @group(1) var<uniform> selectionColor: vec4<f32>;
        const IRRADIANCE_CALIBRATION: f32 = ${IRRADIANCE_CALIBRATION};
        const TRANSLUCENT_OPACITY_SCALE: f32 = ${TRANSLUCENT_OPACITY_SCALE};
        ${colorTransferWgsl}
        ${specularWgsl}
        ${entityColorTableWgsl}

        ${mainShadowWgsl}

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
          @location(2) entityId: u32,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) worldPos: vec3<f32>,
          @location(1) normal: vec3<f32>,
          @location(2) @interpolate(flat) entityId: u32,
          @location(3) viewPos: vec3<f32>,  // For edge detection
          // Per-draw albedo carried from the vertex stage so the fragment shader
          // is shared by the flat path (vs_main writes uniforms.baseColor — the
          // per-batch colour) AND the instanced path
          // (vs_instanced writes the per-occurrence colour from the instance
          // buffer). For the flat path this is identical to reading
          // uniforms.baseColor directly (the value is constant across the draw).
          @location(4) color: vec4<f32>,
          // Per-occurrence selection flag for the instanced path (bit 0 = selected).
          // vs_main writes 0 (the flat path selects via uniforms.flags.x instead);
          // vs_instanced writes the per-instance flag from the instance buffer, so a
          // single selected occurrence highlights without re-drawing.
          @location(5) @interpolate(flat) instSelected: u32,
          // Camera-relative position for fragment operations that compare
          // geometry to section/crop boundaries or take derivatives. This is
          // intentionally separate from worldPos: shadow maps still consume
          // their established world-space light matrix until their depth pass
          // is migrated as one transaction.
          @location(6) eyePos: vec3<f32>,
        }

        // Per-instance vertex-buffer inputs (slot 1, stepMode 'instance') used by
        // vs_instanced. The mat4 arrives as four COLUMN vec4s (WGSL mat4x4 is
        // column-major), matching composeInstanceMatrix's column-major output +
        // the pipeline's slot-1 attribute offsets (0/16/32/48).
        //
        // Location namespaces: vertex-INPUT @location (this struct + VertexInput)
        // and inter-stage @location (VertexOutput) are INDEPENDENT in WGSL, so
        // InstanceInput.m1 @location(4) does NOT collide with VertexOutput.color
        // @location(4) — exactly as VertexInput.entityId and VertexOutput.entityId
        // already BOTH use @location(2). Within the INPUT namespace the per-vertex
        // inputs (0..2) and per-instance inputs (3..8) stay distinct.
        struct InstanceInput {
          @location(3) m0: vec4<f32>,
          @location(4) m1: vec4<f32>,
          @location(5) m2: vec4<f32>,
          @location(6) m3: vec4<f32>,
          @location(7) instEntityId: u32,
          @location(8) instColor: vec4<f32>,
          @location(9) instSelected: u32,
          @location(10) anchorHigh: vec4<f32>,
          @location(11) anchorLow: vec4<f32>,
        }

        // 12-byte quantized vertex (issue #1682 phase 6): uint16x4 (lattice
        // position xyz + packed octahedral normal in w as (u8x << 8 | u8y))
        // followed by the u32 entityId lane. Dequantization is BIT-EXACT for
        // the 2^-10 lattice: quantMin and q*step are both (integer)·2^-10,
        // so coincident points across batches stay coincident (the shared-
        // origin z-fight guarantee survives quantization).
        struct QuantizedVertexInput {
          @location(0) q: vec4<u32>,     // uint16x4: x, y, z, packedOct
          @location(2) entityId: u32,
        }

        fn octDecodeN(packed: u32) -> vec3<f32> {
          let ox = (f32((packed >> 8u) & 255u) / 255.0) * 2.0 - 1.0;
          let oy = (f32(packed & 255u) / 255.0) * 2.0 - 1.0;
          var n = vec3<f32>(ox, oy, 1.0 - abs(ox) - abs(oy));
          if (n.z < 0.0) {
            let tx = (1.0 - abs(oy)) * select(-1.0, 1.0, ox >= 0.0);
            let ty = (1.0 - abs(ox)) * select(-1.0, 1.0, oy >= 0.0);
            n = vec3<f32>(tx, ty, n.z);
          }
          return normalize(n);
        }

        // Shared flat-path vertex shading — vs_main and vs_main_quantized
        // differ ONLY in how position/normal are sourced.
        fn shadeFlatVertex(localPos: vec3<f32>, localNormal: vec3<f32>, entityId: u32) -> VertexOutput {
          var output: VertexOutput;
          let worldPos = uniforms.model * vec4<f32>(localPos, 1.0);
          let eyePos = rtePosition(localPos).xyz;
          let rte = (uniforms.flags.x & RTE_DRAWABLE_FLAG) != 0u;
          output.position = select(uniforms.viewProj * worldPos, uniforms.rteViewProj * vec4<f32>(eyePos, 1.0), rte);
          // Anti z-fighting depth nudge — see vs_main's comment.
          let colorSalt = (entityId >> 24u) * 2654435761u;
          let zHash = (((entityId & 0x00FFFFFFu) ^ colorSalt) * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize((uniforms.model * vec4<f32>(localNormal, 0.0)).xyz);
          output.entityId = entityId;
          output.color = uniforms.baseColor;
          output.instSelected = 0u;
          output.eyePos = eyePos;
          output.viewPos = select((uniforms.viewProj * worldPos).xyz, (uniforms.rteViewProj * vec4<f32>(eyePos, 1.0)).xyz, rte);
          return output;
        }

        @vertex
        fn vs_main_quantized(input: QuantizedVertexInput) -> VertexOutput {
          let p = uniforms.quantParams.xyz
            + vec3<f32>(f32(input.q.x), f32(input.q.y), f32(input.q.z)) * uniforms.quantParams.w;
          return shadeFlatVertex(p, octDecodeN(input.q.w), input.entityId);
        }

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let worldPos = uniforms.model * vec4<f32>(input.position, 1.0);
          let eyePos = rtePosition(input.position).xyz;
          let rte = (uniforms.flags.x & RTE_DRAWABLE_FLAG) != 0u;
          output.position = select(uniforms.viewProj * worldPos, uniforms.rteViewProj * vec4<f32>(eyePos, 1.0), rte);
          // Anti z-fighting: deterministic depth nudge.
          // Knuth multiplicative hash spreads sequential IDs across 0-255 so
          // coplanar faces from different entities always get distinct depths.
          // Material-layer walls slice into one closed solid per layer, all
          // sharing the PARENT wall's expressId, so adjacent layers' coincident
          // interface caps would get the same entity nudge and z-fight into a
          // flickering comb ("see inside the wall"). To separate them we fold in
          // an 8-bit MATERIAL-COLOUR salt that mergeGeometry/interleaveTextured
          // baked into the HIGH 8 bits of the entityId lane (low 24 = picking id,
          // masked off by encodeId24). Crucially the salt comes from the mesh's
          // OWN colour, NOT the per-draw baseColor uniform — so every redraw of
          // the same geometry with a different draw colour (the selection
          // highlight's greater-equal pass) computes the SAME nudge as its
          // batch. At 1e-6 per step the max world-space offset is <3mm at 10m.
          let colorSalt = (input.entityId >> 24u) * 2654435761u;
          let zHash = (((input.entityId & 0x00FFFFFFu) ^ colorSalt) * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize((uniforms.model * vec4<f32>(input.normal, 0.0)).xyz);
          output.entityId = input.entityId;
          output.color = uniforms.baseColor;
          output.instSelected = 0u;  // flat path selects via uniforms.flags.x
          output.eyePos = eyePos;
          // Store view-space position for edge detection
          output.viewPos = select((uniforms.viewProj * worldPos).xyz, (uniforms.rteViewProj * vec4<f32>(eyePos, 1.0)).xyz, rte);
          return output;
        }

        // Instanced vertex entry — one template's geometry drawn once per
        // occurrence. The per-instance mat4 already folds SWAP * rel_k * T(origin)
        // (composed CPU-side, see instanced-render.ts), so it maps the template's
        // LOCAL vertex straight to WebGL Y-up world space — no uniforms.model.
        // rel_k and SWAP are rigid (no scale), so the same matrix transforms
        // normals. entityId + colour come per-occurrence from the instance buffer.
        @vertex
        fn vs_instanced(input: VertexInput, inst: InstanceInput) -> VertexOutput {
          var output: VertexOutput;
          let instMat = mat4x4<f32>(inst.m0, inst.m1, inst.m2, inst.m3);
          let worldPos = instMat * vec4<f32>(input.position, 1.0);
          let linearLocal = (instMat * vec4<f32>(input.position, 0.0)).xyz;
          let eyePos = rteInstancePosition(linearLocal, inst.anchorHigh.xyz, inst.anchorLow.xyz).xyz;
          output.position = uniforms.rteViewProj * vec4<f32>(eyePos, 1.0);
          // Same per-entity depth nudge as vs_main. No colour salt here: the
          // instanced path never redraws an occurrence with a second draw
          // colour, so the raw picking id is enough to separate coplanar entities.
          let zHash = ((inst.instEntityId & 0x00FFFFFFu) * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize((instMat * vec4<f32>(input.normal, 0.0)).xyz);
          output.entityId = inst.instEntityId;
          output.color = inst.instColor;
          output.instSelected = inst.instSelected;
          output.eyePos = eyePos;
          output.viewPos = (uniforms.rteViewProj * vec4<f32>(eyePos, 1.0)).xyz;
          return output;
        }

        fn encodeId24(id: u32) -> vec4<f32> {
          let r = f32((id >> 16u) & 255u) / 255.0;
          let g = f32((id >> 8u) & 255u) / 255.0;
          let b = f32(id & 255u) / 255.0;
          return vec4<f32>(r, g, b, 1.0);
        }

        struct FragmentOutput {
          @location(0) color: vec4<f32>,
          @location(1) objectIdEncoded: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragmentOutput {
          // The flat/quantized/textured mesh paths submit this in one
          // camera-relative frame. Do all camera-local fragment arithmetic in
          // that frame; otherwise the RTE vertex precision is thrown away at
          // section/crop/derivative ingress. Instanced geometry is not yet
          // anchored, so its worldPos remains the authoritative input.
          let fragmentPos = select(input.worldPos, input.eyePos, (uniforms.flags.x & RTE_DRAWABLE_FLAG) != 0u);
          // Per-instance hide/isolate: bit 1 of the instance flags lane marks a hidden
          // occurrence. Discard it so it neither draws nor writes depth (and the pick
          // pass applies the same discard, so it isn't pickable). vs_main writes
          // instSelected=0u for flat geometry, so this never affects the flat path.
          if ((input.instSelected & 2u) != 0u) {
            discard;
          }
          // Per-instance opacity routing (instanced passes only — flags.x bit 2). The
          // opaque instanced pass draws fully-opaque (or selected) occurrences; the
          // transparent instanced sub-pass (bit 3, alpha-blended) draws the rest. Discard
          // the occurrences belonging to the OTHER pass so each is drawn exactly once.
          // Lens-ghost / x-ray / compare write a low per-instance alpha into input.color.a.
          if ((uniforms.flags.x & 4u) != 0u) {
            let occOpaque = input.color.a >= 0.99 || (input.instSelected & 1u) != 0u;
            let transparentPass = (uniforms.flags.x & 8u) != 0u;
            if (transparentPass) {
              if (occOpaque) { discard; }
            } else {
              if (!occOpaque) { discard; }
            }
          }
          // Section plane clipping - discard fragments ABOVE the plane.
          // flags.y packs two bits: bit 0 = enabled, bit 1 = flipped.
          let sectionEnabled = (uniforms.flags.y & 1u) == 1u;
          if (sectionEnabled) {
            let planeNormal = uniforms.sectionPlane.xyz;
            let planeDistance = uniforms.sectionPlane.w;
            let flipped = (uniforms.flags.y & 2u) == 2u;
            let side = select(1.0, -1.0, flipped);
            let distToPlane = (dot(fragmentPos, planeNormal) - planeDistance) * side;
            if (distToPlane > 0.0) {
              discard;
            }
          }
          // Clip box (section / crop box): discard fragments OUTSIDE the AABB.
          // flags.y bit 2 = clip-box enabled.
          if ((uniforms.flags.y & 4u) != 0u) {
            let p = fragmentPos;
            if (any(p < uniforms.clipBoxMin.xyz) || any(p > uniforms.clipBoxMax.xyz)) {
              discard;
            }
          }

          // Compute normal via derivative-based flat shading.
          //
          // Industry-standard solution for BIM/CAD viewers — what
          // Three.js (material.flatShading = true), Autodesk Forge,
          // Speckle, and xeokit all do for opaque surfaces. Rationale:
          //
          //   * BIM geometry is overwhelmingly flat surfaces (walls,
          //     slabs, roofs, beams), and CSG operations (opening
          //     subtraction, layer slicing) emit those surfaces as
          //     dense strips of coplanar triangles. Per-vertex normal
          //     averaging gives a SLIGHTLY-different normal at each
          //     vertex due to f32 noise from boolean output; the
          //     boundary between strips then reads as a visible darker/
          //     brighter scar line — the horizontal striations on
          //     walls, stripes on roofs, visible triangulation reports
          //     across every CSG kernel we have tried (legacy BSP,
          //     Manifold).
          //   * cross(dpdx, dpdy) of world position evaluates to the
          //     EXACT face normal in the fragment shader. Every
          //     fragment on a flat face — across an arbitrarily-fine
          //     triangulation — gets the IDENTICAL normal, so coplanar
          //     splits become invisible by construction. No CPU-side
          //     welding, smooth-grouping, or coplanar-face merging
          //     fixes the symptom as cleanly.
          //
          // Trade-off: genuinely curved surfaces (cylinder tessellations,
          // BSpline approximations) shade with visible facets. For BIM
          // that's acceptable — curved surfaces are < 5 % of typical
          // model triangle count and the faceting matches CAD-tool
          // (Revit, ArchiCAD) on-screen behaviour at default quality.
          //
          // We still fall back to the vertex normal when derivatives
          // are unavailable (extreme polygon degeneracy where dpdx /
          // dpdy collapse to zero — practically never on real geometry).
          let faceN = cross(dpdx(fragmentPos), dpdy(fragmentPos));
          let fLen2 = dot(faceN, faceN);
          var N: vec3<f32>;
          if (fLen2 > 1e-10) {
            N = faceN * inverseSqrt(fLen2);
          } else {
            // Degenerate derivative — fall back to the vertex normal
            // if it's populated, else +Y.
            N = input.normal;
            let nLen2 = dot(N, N);
            if (nLen2 > 1e-6) {
              N = N * inverseSqrt(nLen2);
            } else {
              N = vec3<f32>(0.0, 1.0, 0.0);
            }
          }

          // Stabilize the SIGN of the derivative face normal with the vertex
          // normal. The screen-space cross product gives the exact face
          // normal DIRECTION for coplanar strips (the scar-line fix), but at
          // grazing angles its SIGN becomes numerically unstable per quad —
          // hemisphere/rim lighting then band-flips across large regions of
          // flat walls/slabs (diagonal lighter/darker bands). The interpolated
          // vertex normal is quad-noise-free, so use it only to orient N.
          // Guard: skip when the vertex normal is missing or nearly
          // perpendicular to the face normal (unreliable witness).
          let vN = input.normal;
          let alignDot = dot(N, vN);
          if (alignDot * alignDot > 0.03 * dot(vN, vN)) {
            N = N * sign(alignDot);
          }

          // Lighting environment — sun/hemisphere/exposure come from the
          // global env uniform. The fill follows the sun (it bounces in from
          // the opposite side); the rim stays fixed in world space as a
          // stylistic shaping light.
          let sunLight = env.sunDirection;
          // Horizontal mirror of the sun, lifted slightly. An overhead sun
          // leaves (0, 0.25, 0), which normalizes to straight up.
          let fillLight = normalize(vec3<f32>(-sunLight.x, 0.25, -sunLight.z));
          let rimLight = normalize(vec3<f32>(0.0, 0.2, -1.0));  // Rim light for edge definition

          // Hemisphere ambient. This, not the sun, keeps faces turned away
          // from the sun readable (I-beam webs and flange undersides, #5382).
          let hemisphereFactor = N.y * 0.5 + 0.5;
          let ambient = mix(env.groundColor, env.skyColor, hemisphereFactor) * env.ambientIntensity;

          // One-sided sun, so a building has a lit side and a shaded side.
          // sunSoftness is the diffuse wrap (env uniform): 0 = crisp
          // terminator (hard shadows), larger = softer wrap-around (overcast).
          let NdotL = dot(N, sunLight);
          let wrap = env.sunSoftness;
          let diffuseSun = max((NdotL + wrap) / (1.0 + wrap), 0.0) * env.sunIntensity;

          // Fill light, one-sided like the sun.
          let NdotFill = max(dot(N, fillLight), 0.0);
          let diffuseFill = NdotFill * env.fillIntensity;

          // Rim light for edge definition
          let NdotRim = max(dot(N, rimLight), 0.0);
          let rim = pow(NdotRim, 4.0) * env.rimIntensity;

          // The authored colour is display-referred sRGB; light it in linear.
          // (textured.wgsl.ts anchors on the first line to multiply in the texel.)
          var baseColor = input.color.rgb;
          baseColor = srgbToLinear(baseColor);

          // Combine all lighting. Only the DIRECT sun term is occluded by cast
          // shadows (#2670); ambient/fill/rim are indirect and stay unshadowed.
          // Exposure scales the light, so the selection shade below and every
          // later stage see one exposed irradiance.
          let sunShadow = sunShadowFactor(input.eyePos, N, input.position.xy);
          let lightTerm = ambient + env.sunColor * (diffuseSun * sunShadow) + vec3<f32>(diffuseFill + rim);
          let irradiance = lightTerm * (env.exposure * IRRADIANCE_CALIBRATION);
          var color = baseColor * irradiance;

          // flags.x bit 0 (value 1) = isSelected → selection highlight, forced opaque.
          // Selected via the per-draw flag (flat path) OR the per-occurrence flag
          // (instanced path — vs_instanced reads it from the instance buffer).
          let isSelected = ((uniforms.flags.x & 1u) == 1u) || ((input.instSelected & 1u) == 1u);

          // Selection highlight — a blue albedo RE-LIT by the scene lighting.
          //
          // We override the material albedo with selection-blue and re-light
          // it with the SAME lightTerm used for unselected surfaces, then
          // skip the view-dependent (specular) term below. Two requirements
          // are in tension and this satisfies both:
          //
          //   * No base-material bleed-through. The old fresnel-glow mix left
          //     ~80 % of the lit object colour visible at face centres (the
          //     green-site / red-roof wash-out). Here the base colour never
          //     enters the result — only lightTerm (geometry/light, colour-
          //     independent) modulates the constant blue albedo.
          //   * Facet/crease structure must survive. A single FLAT colour
          //     (the previous fix) collapsed every face to the same blue, so
          //     internal edges — which read as the per-face shading STEP, not
          //     just the faint screen-space edge line — disappeared on
          //     selection. Re-lighting keeps that per-face brightness step, so
          //     creases read on the highlight exactly as they do unselected.
          //
          // The luminance of the exposed irradiance is used as a multiplicative
          // gain (which preserves the per-face brightness RATIOS, so creases
          // read as strongly as on the unselected surface). The calibration
          // puts a sunlit face at 1.0, i.e. full selection-blue, and the
          // floor/ceiling clamp keeps shadowed faces only dimmed and bright
          // scenes from washing out.
          if (isSelected) {
            let shadeLum = dot(irradiance, vec3<f32>(0.299, 0.587, 0.114));
            let shade = clamp(shadeLum, 0.45, 1.2);
            // selectionColor is already linear-light (set by Renderer.setOverlayTheme
            // from the app theme, #5484) — no srgbToLinear here, unlike the constant
            // it replaces.
            color = selectionColor.rgb * shade;
          }

          // Force alpha to 1.0 for selected objects so the highlight is fully
          // opaque (the selection pipeline has no alpha blending).
          var finalAlpha = select(input.color.a, 1.0, isSelected);

          // Specular (#5386; specular.wgsl.ts), after the diffuse above. Not
          // on the selection highlight (it would wash the blue out); a colour
          // override is composited without it (paintEntityOverride below). The
          // sun lobe is scaled exactly like the diffuse sun term, and both
          // terms like irradiance, so a preset's highlights and diffuse move together.
          if (!isSelected) {
            // Glass is an authored translucent material (mesh-material.ts
            // also gives it its smooth roughness). An X-Ray or compare fade
            // only lowers the alpha and stays a fade. Instanced occurrences
            // are never authored translucent: prepareInstancedRender routes
            // those to the flat path, so the per-pass lane is ignored there.
            let instancedPass = (uniforms.flags.x & 4u) != 0u;
            let translucent = finalAlpha < 0.99;
            let glass = translucent && uniforms.transmission.x > 0.5 && !instancedPass;
            let metallic = clamp(uniforms.metallicRoughness.x, 0.0, 1.0);
            let spec = surfaceSpecular(
              N,
              normalize(-input.eyePos),
              baseColor,
              metallic,
              uniforms.metallicRoughness.y,
              env.sunColor * (env.sunIntensity * sunShadow),
            );
            // What the lobe reflects is not there to diffuse; a metal has no
            // diffuse at all.
            let diffuse = color * (1.0 - spec.reflectance) * (1.0 - metallic);
            let reflected = spec.light * (env.exposure * IRRADIANCE_CALIBRATION);
            if (translucent) {
              finalAlpha = finalAlpha * TRANSLUCENT_OPACITY_SCALE;
            }
            if (glass) {
              // The transparent pipelines blend straight alpha:
              // out = c * a + behind * (1 - a). A pane passes what is behind
              // it except what its body absorbs and its surface reflects, and
              // its reflection is not dimmed by the body's opacity, so solve
              // for (c, a). The reflectance rising at grazing angles is what
              // makes glass more opaque there; a bright sun glint raises the
              // alpha further so it is not clipped to the body's opacity.
              let body = finalAlpha;
              let reflectance = dot(spec.reflectance, vec3<f32>(0.299, 0.587, 0.114));
              let premultiplied = diffuse * body + reflected;
              let peak = max(premultiplied.r, max(premultiplied.g, premultiplied.b));
              finalAlpha = clamp(max(body + reflectance * (1.0 - body), peak), 0.0, 1.0);
              color = premultiplied / max(finalAlpha, 0.0001);
            } else {
              color = diffuse + reflected;
            }
          }

          // Hue-preserving highlight roll-off (color-transfer.wgsl.ts). No
          // contrast curve and no saturation boost: an authored colour lit at
          // unit irradiance leaves here unchanged unless it is brighter than
          // the roll-off threshold.
          color = neutralCompress(color);

          // Subtle edge enhancement using screen-space derivatives.
          //
          // Use the SHADED normal (face normal from dpdx/dpdy above)
          // for the normal-gradient term, not the interpolated vertex
          // normal — otherwise we get spurious dark stripes on flat
          // surfaces whose vertex normals carry numerical noise from
          // CSG output (the visible scar-line symptom would just
          // resurface here even after the lit-normal fix). With the
          // face normal, coplanar adjacent triangles agree exactly →
          // zero normal gradient → no false edge; only the genuine
          // creases between perpendicular faces produce a real
          // gradient and get the intended outline.
          let depthGradient = length(vec2<f32>(
            dpdx(input.viewPos.z),
            dpdy(input.viewPos.z)
          ));
          let normalGradient = length(vec2<f32>(
            length(dpdx(N)),
            length(dpdy(N))
          ));

          var edgeDarken = 1.0;
          if (uniforms.flags.z == 1u) {
            // Threshold filters subtle normal discontinuities at internal
            // triangle edges between coplanar entities in the same batch.
            let edgeFactor = smoothstep(0.02, 0.12, depthGradient * 10.0 + normalGradient * 5.0);
            let edgeIntensity = f32(uniforms.flags.w) / 1000.0;
            let edgeDarkenStrength = clamp(0.25 * edgeIntensity, 0.0, 0.85);
            edgeDarken = mix(1.0, 1.0 - edgeDarkenStrength, edgeFactor);
            color *= edgeDarken;
          }

          color = linearToSrgb(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)));

          var out: FragmentOutput;
          out.color = vec4<f32>(color, finalAlpha);
          // Colour override from the per-entity table (#6076): only draws the
          // renderer marks (overrideParams.y), i.e. depth-writing opaque ones.
          let entityOverride = entityOverrideColor(input.entityId);
          if (entityOverride.a >= 0.0 && !isSelected) {
            out.color = paintEntityOverride(out.color, entityOverride, irradiance, N, edgeDarken);
          }
          out.objectIdEncoded = encodeId24(input.entityId);
          return out;
        }
      `;
