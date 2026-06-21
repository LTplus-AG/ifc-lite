/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main PBR rendering shader for IFC geometry.
 * Features: PBR lighting, section plane clipping, selection highlight,
 * glass fresnel, ACES tone mapping, screen-space edge enhancement.
 */
export const mainShaderSource = `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          model: mat4x4<f32>,
          baseColor: vec4<f32>,
          metallicRoughness: vec2<f32>, // x = metallic, y = roughness
          _padding1: vec2<f32>,
          sectionPlane: vec4<f32>,      // xyz = plane normal, w = plane distance
          flags: vec4<u32>,             // x = isSelected, y = sectionEnabled, z = edgeEnabled, w = edgeIntensityMilli
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        // Global lighting environment — one buffer shared by every mesh in
        // the pass (bound once per frame at group(1)). Field packing must
        // match packEnvironmentUniforms() in environment.ts.
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
          _pad0: f32,
          _pad1: f32,
          _pad2: f32,
        }
        @binding(0) @group(1) var<uniform> env: Environment;

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
          // per-batch / overlay-override colour) AND the instanced path
          // (vs_instanced writes the per-occurrence colour from the instance
          // buffer). For the flat path this is identical to reading
          // uniforms.baseColor directly (the value is constant across the draw).
          @location(4) color: vec4<f32>,
          // Per-occurrence selection flag for the instanced path (bit 0 = selected).
          // vs_main writes 0 (the flat path selects via uniforms.flags.x instead);
          // vs_instanced writes the per-instance flag from the instance buffer, so a
          // single selected occurrence highlights without re-drawing.
          @location(5) @interpolate(flat) instSelected: u32,
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
        }

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let worldPos = uniforms.model * vec4<f32>(input.position, 1.0);
          output.position = uniforms.viewProj * worldPos;
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
          // OWN colour, NOT the per-draw baseColor uniform — so the base opaque
          // pass and the lens/IDS/compare/4D OVERLAY pass (which redraws the same
          // geometry with a DIFFERENT draw colour) compute the SAME nudge, and
          // the overlay pipeline's depthCompare:'equal' matches instead of
          // rejecting every fragment. At 1e-6 per step the max world-space offset
          // is <3mm at 10m — invisible.
          let colorSalt = (input.entityId >> 24u) * 2654435761u;
          let zHash = (((input.entityId & 0x00FFFFFFu) ^ colorSalt) * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize((uniforms.model * vec4<f32>(input.normal, 0.0)).xyz);
          output.entityId = input.entityId;
          output.color = uniforms.baseColor;
          output.instSelected = 0u;  // flat path selects via uniforms.flags.x
          // Store view-space position for edge detection
          output.viewPos = (uniforms.viewProj * worldPos).xyz;
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
          output.position = uniforms.viewProj * worldPos;
          // Same per-entity depth nudge as vs_main. No colour salt here: the
          // instanced path has no base-vs-overlay coincident redraw (yet), so the
          // raw picking id is enough to separate coplanar entities.
          let zHash = ((inst.instEntityId & 0x00FFFFFFu) * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize((instMat * vec4<f32>(input.normal, 0.0)).xyz);
          output.entityId = inst.instEntityId;
          output.color = inst.instColor;
          output.instSelected = inst.instSelected;
          output.viewPos = (uniforms.viewProj * worldPos).xyz;
          return output;
        }

        // PBR helper functions
        fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
          return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
        }

        fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
          let a = roughness * roughness;
          let a2 = a * a;
          let NdotH2 = NdotH * NdotH;
          let num = a2;
          let denomBase = (NdotH2 * (a2 - 1.0) + 1.0);
          let denom = 3.14159265 * denomBase * denomBase;
          return num / max(denom, 0.0000001);
        }

        fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
          let r = (roughness + 1.0);
          let k = (r * r) / 8.0;
          let num = NdotV;
          let denom = NdotV * (1.0 - k) + k;
          return num / max(denom, 0.0000001);
        }

        fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
          let ggx2 = geometrySchlickGGX(NdotV, roughness);
          let ggx1 = geometrySchlickGGX(NdotL, roughness);
          return ggx1 * ggx2;
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
            let distToPlane = (dot(input.worldPos, planeNormal) - planeDistance) * side;
            if (distToPlane > 0.0) {
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
          let faceN = cross(dpdx(input.worldPos), dpdy(input.worldPos));
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
          // global env uniform (defaults reproduce the historic hardcoded
          // values); fill + rim directions stay fixed in view-agnostic
          // world space as stylistic shaping lights.
          let sunLight = env.sunDirection;
          let fillLight = normalize(vec3<f32>(-0.5, 0.3, -0.3));  // Fill light
          let rimLight = normalize(vec3<f32>(0.0, 0.2, -1.0));  // Rim light for edge definition

          // Hemisphere ambient
          let hemisphereFactor = N.y * 0.5 + 0.5;
          let ambient = mix(env.groundColor, env.skyColor, hemisphereFactor) * env.ambientIntensity;

          // Two-sided sun light so inner faces (I-beam channels) stay visible
          let NdotL = abs(dot(N, sunLight));
          let wrap = 0.3;
          let diffuseSun = max((NdotL + wrap) / (1.0 + wrap), 0.0) * env.sunIntensity;

          // Fill light - two-sided
          let NdotFill = abs(dot(N, fillLight));
          let diffuseFill = NdotFill * env.fillIntensity;

          // Rim light for edge definition
          let NdotRim = max(dot(N, rimLight), 0.0);
          let rim = pow(NdotRim, 4.0) * env.rimIntensity;

          var baseColor = input.color.rgb;

          // Detect if the color is close to white/gray (low saturation)
          let baseGray = dot(baseColor, vec3<f32>(0.299, 0.587, 0.114));
          let baseSaturation = length(baseColor - vec3<f32>(baseGray)) / max(baseGray, 0.001);
          let isWhiteish = 1.0 - smoothstep(0.0, 0.3, baseSaturation);

          // Darken whites/grays more to reduce washed-out appearance
          baseColor = mix(baseColor, baseColor * 0.7, isWhiteish * 0.4);

          // Combine all lighting. Keep the lighting term separate so the
          // selection highlight can reuse it (re-light a blue albedo) without
          // the base material colour bleeding through.
          let lightTerm = ambient + env.sunColor * diffuseSun + vec3<f32>(diffuseFill + rim);
          var color = baseColor * lightTerm;

          // flags.x is a bitfield:
          //   bit 0 (value 1) = isSelected  → selection-highlight + force opaque
          //   bit 1 (value 2) = isOverlay   → color-override pass; preserve
          //                                    baseColor.a (overlay pipeline has
          //                                    src-alpha blending) AND skip the
          //                                    glass-fresnel branch so low-alpha
          //                                    ghost tints don't pick up the
          //                                    near-white reflection tint meant
          //                                    for real glass materials.
          // Selected via the per-draw flag (flat path) OR the per-occurrence flag
          // (instanced path — vs_instanced reads it from the instance buffer).
          let isSelected = ((uniforms.flags.x & 1u) == 1u) || ((input.instSelected & 1u) == 1u);
          let isOverlay = (uniforms.flags.x & 2u) == 2u;

          // Selection highlight — a blue albedo RE-LIT by the scene lighting.
          //
          // We override the material albedo with selection-blue and re-light
          // it with the SAME lightTerm used for unselected surfaces, then
          // discard the view-dependent (fresnel) term below. Two requirements
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
          // The luminance of lightTerm is remapped by a multiplicative gain
          // (which preserves the per-face brightness RATIOS, so creases read
          // as strongly as on the unselected surface) calibrated so a sunlit
          // face hits full selection-blue, with a floor/ceiling clamp so
          // shadowed faces only dim and bright scenes never wash out.
          if (isSelected) {
            let shadeLum = dot(lightTerm, vec3<f32>(0.299, 0.587, 0.114));
            let shade = clamp(shadeLum * 1.55, 0.45, 1.2);
            color = vec3<f32>(0.3, 0.6, 1.0) * shade;
          }

          // Beautiful fresnel effect for transparent materials (glass)
          // Skip when selected — the glass shine and desaturation wash out the
          // blue highlight, making it appear white instead of blue.
          // Also force alpha to 1.0 for selected objects so the highlight is
          // fully opaque (the selection pipeline has no alpha blending).
          var finalAlpha = select(input.color.a, 1.0, isSelected);
          if (finalAlpha < 0.99 && !isSelected && !isOverlay) {
            // Calculate view direction for fresnel
            let V = normalize(-input.worldPos);
            let NdotV = max(dot(N, V), 0.0);

            // Enhanced fresnel effect - stronger at edges (grazing angles)
            // Using Schlick's approximation for realistic glass reflection
            let fresnelPower = 1.5; // Higher = softer edge reflections
            let fresnel = pow(1.0 - NdotV, fresnelPower);

            // Glass reflection tint (sky/environment reflection at edges)
            let reflectionTint = vec3<f32>(0.92, 0.96, 1.0);  // Cool sky reflection
            let reflectionStrength = fresnel * 0.6;  // Strong edge reflections

            // Mix in reflection tint at edges
            color = mix(color, color * reflectionTint, reflectionStrength);

            // Add realistic glass shine - brighter at edges where light reflects
            let glassShine = fresnel * 0.12;
            color += glassShine;

            // Slight desaturation at edges (glass reflects environment, not just color)
            let edgeDesaturation = fresnel * 0.25;
            let gray = dot(color, vec3<f32>(0.299, 0.587, 0.114));
            color = mix(color, vec3<f32>(gray), edgeDesaturation);

            // Make glass more transparent (reduce opacity by 30%)
            finalAlpha = finalAlpha * 0.7;
          }

          // Exposure adjustment (historic default 0.85 darkens overall)
          color *= env.exposure;

          // Contrast enhancement
          color = (color - 0.5) * 1.15 + 0.5;
          color = max(color, vec3<f32>(0.0));

          // Saturation boost - stronger for colored surfaces, less for whites
          let gray = dot(color, vec3<f32>(0.299, 0.587, 0.114));
          // More saturation for colored surfaces. isWhiteish is derived from
          // the base material colour, so for a SELECTED object it would leak a
          // material dependence into the highlight (breaking the no-bleed-
          // through contract). The selection blue is a fully-saturated colour,
          // so force the colored-surface boost (1.4) when selected — keeping
          // the highlight identical regardless of the underlying material.
          let satBoost = select(mix(1.4, 1.1, isWhiteish), 1.4, isSelected);
          color = mix(vec3<f32>(gray), color, satBoost);

          // ACES filmic tone mapping
          let a = 2.51;
          let b = 0.03;
          let c = 2.43;
          let d = 0.59;
          let e = 0.14;
          color = clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));

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

          if (uniforms.flags.z == 1u) {
            // Threshold filters subtle normal discontinuities at internal
            // triangle edges between coplanar entities in the same batch.
            let edgeFactor = smoothstep(0.02, 0.12, depthGradient * 10.0 + normalGradient * 5.0);
            let edgeIntensity = f32(uniforms.flags.w) / 1000.0;
            let edgeDarkenStrength = clamp(0.25 * edgeIntensity, 0.0, 0.85);
            let edgeDarken = mix(1.0, 1.0 - edgeDarkenStrength, edgeFactor);
            color *= edgeDarken;
          }

          // Gamma correction
          color = pow(color, vec3<f32>(1.0 / 2.2));

          var out: FragmentOutput;
          out.color = vec4<f32>(color, finalAlpha);
          out.objectIdEncoded = encodeId24(input.entityId);
          return out;
        }
      `;
