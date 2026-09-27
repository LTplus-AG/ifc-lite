/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CPU/WGSL uniform ABI of the relative-to-eye contract: the exact byte
 * layout `relative-to-eye.ts` packs, and the reflection that fails loudly if
 * `shaders/relative-to-eye.wgsl.ts` drifts from it.
 */

import { relativeToEyeWgsl } from './shaders/relative-to-eye.wgsl.js';

interface UniformFieldLayout {
  name: string;
  type: 'mat4x4<f32>' | 'vec4<f32>';
  byteOffset: number;
  byteSize: number;
}

/** Exact byte layout shared by the CPU writer and the WGSL RTE structs. */
export const RTE_UNIFORM_LAYOUT = {
  frame: [
    { name: 'viewProj', type: 'mat4x4<f32>', byteOffset: 0, byteSize: 64 },
  ] as const satisfies readonly UniformFieldLayout[],
  drawable: [
    { name: 'drawableDeltaHigh', type: 'vec4<f32>', byteOffset: 0, byteSize: 16 },
    { name: 'drawableDeltaLow', type: 'vec4<f32>', byteOffset: 16, byteSize: 16 },
  ] as const satisfies readonly UniformFieldLayout[],
} as const;

/**
 * Reflect the deliberately small RTE WGSL ABI. The production source has no
 * nested structs or arrays here, so accepting either would conceal inserted
 * padding. Unsupported syntax is a contract failure, not a parser fallback.
 */
export function reflectRteUniformStruct(
  source: string,
  structName: 'RteFrameUniform' | 'RteDrawableUniform',
): UniformFieldLayout[] {
  const match = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`).exec(source);
  if (!match) throw new Error(`RTE WGSL struct ${structName} is missing.`);
  const fields: UniformFieldLayout[] = [];
  let byteOffset = 0;
  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const field = /^(\w+)\s*:\s*(mat4x4<f32>|vec4<f32>)\s*,?$/.exec(line);
    if (!field) throw new Error(`Unsupported RTE WGSL field: ${line}`);
    const name = field[1];
    const type = field[2];
    if (!name || (type !== 'mat4x4<f32>' && type !== 'vec4<f32>')) {
      throw new Error(`Invalid RTE WGSL field: ${line}`);
    }
    const byteSize = type === 'mat4x4<f32>' ? 64 : 16;
    byteOffset = Math.ceil(byteOffset / 16) * 16;
    fields.push({ name, type, byteOffset, byteSize });
    byteOffset += byteSize;
  }
  return fields;
}

/** Fail loudly if source edits drift from the CPU writer's exact ABI. */
export function assertRteUniformAbi(source = relativeToEyeWgsl): void {
  for (const [structName, expected] of [
    ['RteFrameUniform', RTE_UNIFORM_LAYOUT.frame],
    ['RteDrawableUniform', RTE_UNIFORM_LAYOUT.drawable],
  ] as const) {
    const actual = reflectRteUniformStruct(source, structName);
    if (actual.length !== expected.length || actual.some((field, index) => {
      const want = expected[index];
      return field.name !== want.name || field.type !== want.type
        || field.byteOffset !== want.byteOffset || field.byteSize !== want.byteSize;
    })) {
      throw new Error(`RTE WGSL ${structName} does not match the CPU uniform ABI.`);
    }
  }
  // Layout reflection alone cannot prove floating-point association. This is
  // an executable shader-source invariant, separate from ABI reflection.
  if (!source.includes('(local + highDelta) + lowDelta')
    || source.includes('local + (highDelta + lowDelta)')) {
    throw new Error('RTE WGSL must evaluate (local + highDelta) + lowDelta.');
  }
}
