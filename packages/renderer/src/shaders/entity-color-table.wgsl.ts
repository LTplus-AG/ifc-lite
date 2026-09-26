/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL half of the per-entity colour table (#6076; layout, anchor rule and
 * memory bound in `entity-color-table.ts`, whose `lookupEntityColor` and
 * `resolveLaneEntityId` are the CPU mirrors of the functions below).
 *
 * Inlined into main.wgsl.ts after the Uniforms struct and the colour-transfer
 * helpers, so it reads `uniforms.overrideParams` and reuses `srgbToLinear`,
 * `neutralCompress` and `linearToSrgb`. The table sits at group(1) binding 5,
 * beside the lighting environment, because it is scene-global.
 */
import { ENTITY_COLOR_EMPTY_KEY, ENTITY_COLOR_HEADER_WORDS, OVERRIDE_PARAM_EMPHASIZE, OVERRIDE_PARAM_PAINT } from '../entity-color-table.js';

export const entityColorTableWgsl = `
        @binding(5) @group(1) var<storage, read> entityColorTable: array<u32>;
        const ENTITY_COLOR_EMPTY: u32 = ${ENTITY_COLOR_EMPTY_KEY}u;
        const ENTITY_COLOR_HEADER: u32 = ${ENTITY_COLOR_HEADER_WORDS}u;
        const OVERRIDE_PAINT: u32 = ${OVERRIDE_PARAM_PAINT}u;
        const OVERRIDE_EMPHASIZE: u32 = ${OVERRIDE_PARAM_EMPHASIZE}u;

        fn entityColorSlotHash(key: u32) -> u32 {
          var h = key;
          h = h ^ (h >> 16u);
          h = h * 0x85ebca6bu;
          h = h ^ (h >> 13u);
          h = h * 0xc2b2ae35u;
          h = h ^ (h >> 16u);
          return h;
        }

        // Full scene id behind a 24-bit lane, given the draw's smallest id.
        fn resolveLaneEntityId(anchor: u32, lane: u32) -> u32 {
          return anchor + ((lane - anchor) & 0x00FFFFFFu);
        }

        // The override colour for this fragment's entity; alpha < 0 = none.
        fn entityOverrideColor(lane: u32) -> vec4<f32> {
          let none = vec4<f32>(0.0, 0.0, 0.0, -1.0);
          if ((uniforms.overrideParams.y & OVERRIDE_PAINT) == 0u || entityColorTable[2] == 0u) {
            return none;
          }
          let capacity = entityColorTable[0];
          let maxProbe = entityColorTable[1];
          let colorBase = entityColorTable[3];
          let id = resolveLaneEntityId(uniforms.overrideParams.x, lane);
          let mask = capacity - 1u;
          var slot = entityColorSlotHash(id) & mask;
          for (var i = 0u; i <= maxProbe && i < capacity; i = i + 1u) {
            let key = entityColorTable[ENTITY_COLOR_HEADER + slot];
            if (key == id) {
              let c = colorBase + slot * 4u;
              return vec4<f32>(
                bitcast<f32>(entityColorTable[c]),
                bitcast<f32>(entityColorTable[c + 1u]),
                bitcast<f32>(entityColorTable[c + 2u]),
                bitcast<f32>(entityColorTable[c + 3u])
              );
            }
            if (key == ENTITY_COLOR_EMPTY) {
              break;
            }
            slot = (slot + 1u) & mask;
          }
          return none;
        }

        // Composite an override over the fragment's own encoded colour exactly
        // as the retired equal-depth overlay pass blended it (src-alpha over
        // the base draw): the override albedo lit by the same irradiance, no
        // specular, the same roll-off and edge darkening, mixed by its alpha.
        // Emphasized overrides are unlit, faintly faceted and opaque (#1277).
        fn paintEntityOverride(base: vec4<f32>, ov: vec4<f32>, irradiance: vec3<f32>, N: vec3<f32>, edgeDarken: f32) -> vec4<f32> {
          let albedo = srgbToLinear(ov.rgb);
          var lit = albedo * irradiance;
          var a = ov.a;
          if ((uniforms.overrideParams.y & OVERRIDE_EMPHASIZE) != 0u) {
            lit = albedo * (0.85 + 0.15 * abs(dot(N, normalize(vec3<f32>(0.3, 1.0, 0.2)))));
            a = 1.0;
          }
          let encoded = linearToSrgb(clamp(neutralCompress(lit) * edgeDarken, vec3<f32>(0.0), vec3<f32>(1.0)));
          return vec4<f32>(mix(base.rgb, encoded, a), a + (1.0 - a) * base.a);
        }
`;
