/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL twin of `depth-reconstruct.ts`: view-space position and normal from
 * the scene's reverse-Z depth buffer, shared by the screen-space passes so
 * each one reconstructs geometry the same way.
 *
 * `dp` is `[m10, m11, m14, m15]` and `xy` is `[m0, m5, m12, m13]` of the
 * camera projection (see `depthReconstructParams`).
 */

/**
 * Declares `depthTex` at `@group(group) @binding(binding)` and `loadDepth(ip)`,
 * which clamps the coordinate to the texture and reads sample 0 when the
 * attachment is multisampled.
 *
 * `group` must match the index of the bind-group layout that carries the
 * depth texture in the caller's pipeline layout. The full-screen passes (AO,
 * edges) own group 0; the selection mask draws mesh geometry, so group 0 is
 * the mesh uniform and the depth texture sits in group 1 (#5390).
 */
export function depthTextureWgsl(binding: number, multisampled: boolean, group = 0): string {
  const type = multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d';
  return `
        @group(${group}) @binding(${binding}) var depthTex: ${type};

        fn loadDepth(ip: vec2<i32>) -> f32 {
          let dims = vec2<i32>(textureDimensions(depthTex));
          return textureLoad(depthTex, clamp(ip, vec2<i32>(0), dims - 1), 0);
        }
`;
}

export const depthReconstructWgsl = `
        // Reverse-Z clears to 0, so anything at or below this is background.
        const BACKGROUND_DEPTH: f32 = 1e-7;

        fn viewZFromDepth(d: f32, dp: vec4<f32>) -> f32 {
          return (dp.z - d * dp.w) / (d * dp.y - dp.x);
        }

        fn clipWFromViewZ(z: f32, dp: vec4<f32>) -> f32 {
          return dp.y * z + dp.w;
        }

        // Pixel centre to NDC (y up), for a buffer whose texel size is invDims.
        fn ndcFromPixel(ip: vec2<i32>, invDims: vec2<f32>) -> vec2<f32> {
          let uv = (vec2<f32>(ip) + 0.5) * invDims;
          return vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
        }

        fn viewPositionFromDepth(ndc: vec2<f32>, d: f32, dp: vec4<f32>, xy: vec4<f32>) -> vec3<f32> {
          let z = viewZFromDepth(d, dp);
          let w = clipWFromViewZ(z, dp);
          return vec3<f32>((ndc.x * w - xy.z) / xy.x, (ndc.y * w - xy.w) / xy.y, z);
        }

        // Normal facing the camera, from a position and its four pixel
        // neighbours. On each axis it takes the neighbour with the smaller
        // depth step, so a pixel on a silhouette or a crease uses the side
        // on its own surface instead of averaging across the edge.
        fn normalFromNeighbours(
          p: vec3<f32>, right: vec3<f32>, left: vec3<f32>, down: vec3<f32>, up: vec3<f32>,
        ) -> vec3<f32> {
          let dxR = right - p;
          let dxL = p - left;
          let dx = select(dxR, dxL, abs(dxL.z) < abs(dxR.z));
          let dyD = down - p;
          let dyU = p - up;
          let dy = select(dyD, dyU, abs(dyU.z) < abs(dyD.z));
          // Pixel +x is view +x and pixel +y is view -y, so dy x dx faces +z.
          return normalize(cross(dy, dx));
        }
`;
