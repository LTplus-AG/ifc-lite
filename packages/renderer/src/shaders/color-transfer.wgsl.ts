/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour transfer shared by every shader that lights or tone-maps: the
 * geometry fragment stage (`main.wgsl.ts`, and the textured variant derived
 * from it) and the procedural sky (`sky.wgsl.ts`). One home, so the model and
 * the sky cannot drift onto different "film stocks".
 *
 * The contract:
 *
 *  - Authored colours (IfcColourRgb, IFC5 / glTF base colours, overlay tints,
 *    texture texels) are display-referred sRGB. `srgbToLinear` decodes them
 *    before they are multiplied by light, because light adds and multiplies
 *    linearly and sRGB values do not.
 *  - `neutralCompress` rolls off highlights only. Anything whose brightest
 *    channel is below 0.76 (about 227/255 once encoded) passes through
 *    untouched, so a colour up to that brightness, lit at unit neutral
 *    irradiance, renders as authored; brighter colours roll off with their
 *    hue preserved (pure white lands at 0.88, about 241/255, leaving
 *    headroom for sunlit highlights). It is the Khronos PBR Neutral operator
 *    without its toe: the toe subtracts up to 0.04 to cancel a specular F0
 *    offset, and this renderer has no specular term, so keeping it would only
 *    crush dark materials.
 *  - `linearToSrgb` is the exact piecewise encode. The canvas is configured
 *    with a non-sRGB format, so the shader must encode.
 */
export const colorTransferWgsl = `
        fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
          let lo = c / 12.92;
          let hi = pow((max(c, vec3<f32>(0.0)) + 0.055) / 1.055, vec3<f32>(2.4));
          return select(hi, lo, c <= vec3<f32>(0.04045));
        }

        fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
          let lo = c * 12.92;
          let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
          return select(hi, lo, c <= vec3<f32>(0.0031308));
        }

        fn neutralCompress(cIn: vec3<f32>) -> vec3<f32> {
          let startCompression = 0.76;
          let desaturation = 0.15;
          let c = max(cIn, vec3<f32>(0.0));
          let peak = max(c.r, max(c.g, c.b));
          if (peak < startCompression) { return c; }
          let d = 1.0 - startCompression;
          let newPeak = 1.0 - d * d / (peak + d - startCompression);
          let g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
          return mix(c * (newPeak / peak), vec3<f32>(newPeak), g);
        }
`;
