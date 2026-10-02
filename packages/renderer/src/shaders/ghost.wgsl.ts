/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fragment shading for X-Ray context ghosts (`ghostExceptIds`), derived from
 * main.wgsl.ts the way textured.wgsl.ts is. A ghost keeps the main shader's
 * discards, flat face normal and diffuse light rig, so it reads as the same
 * surface faded, and returns before the specular term, cast shadows, the
 * selection tint and the entity colour override. At the default ghost alpha
 * none of those show, but blended geometry gets no hidden-surface removal, so
 * every ghosted layer under a pixel paid for them.
 */
import { mainShaderSource } from './main.wgsl.js';

function indexOfOnce(src: string, find: string, label: string): number {
  const idx = src.indexOf(find);
  if (idx === -1) {
    throw new Error(`ghost.wgsl: anchor "${label}" not found — main.wgsl.ts changed; update the ghost-shader derivation.`);
  }
  if (src.indexOf(find, idx + find.length) !== -1) {
    throw new Error(`ghost.wgsl: anchor "${label}" is not unique — tighten the derivation.`);
  }
  return idx;
}

const GHOST_TAIL =
  '          var color = baseColor * irradiance;\n' +
  '          var ghost: FragmentOutput;\n' +
  '          ghost.color = vec4<f32>(\n' +
  '            linearToSrgb(clamp(neutralCompress(color), vec3<f32>(0.0), vec3<f32>(1.0))),\n' +
  '            input.color.a * TRANSLUCENT_OPACITY_SCALE,\n' +
  '          );\n' +
  '          ghost.objectIdEncoded = encodeId24(input.entityId);\n' +
  '          return ghost;\n';

function deriveGhostShader(src: string): string {
  const shadow = 'let sunShadow = sunShadowFactor(input.eyePos, N, input.position.xy);';
  const shadowAt = indexOfOnce(src, shadow, 'sun shadow');
  const s = src.slice(0, shadowAt) + 'let sunShadow = 1.0;' + src.slice(shadowAt + shadow.length);
  // Cut fs_main from the diffuse colour to its closing brace, so no dead code
  // is left for the compiler to warn about. fs_main must be the last function.
  const tailStart = indexOfOnce(s, '          var color = baseColor * irradiance;\n', 'diffuse colour');
  const tailEnd = s.lastIndexOf('\n        }');
  if (tailEnd < tailStart || s.slice(tailStart, tailEnd).includes('\n        fn ')) {
    throw new Error('ghost.wgsl: fs_main is no longer the last function in main.wgsl.ts; update the ghost-shader derivation.');
  }
  return s.slice(0, tailStart) + GHOST_TAIL + s.slice(tailEnd + 1);
}

export const ghostShaderSource = deriveGhostShader(mainShaderSource);
