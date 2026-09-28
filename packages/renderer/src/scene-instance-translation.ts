/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mutation of one CPU-side instanced occurrence placement. */

import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';

export interface InstanceTranslationTarget {
  instanceData: ArrayBuffer;
  canonicalAnchors: Float64Array;
  canonicalMatrixTranslations?: Float32Array;
}

/**
 * Apply a world-frame delta to one occurrence: the f32 matrix translation in
 * the CPU record and the authoritative f64 anchor. The GPU delta stream is
 * derived from the anchor, so the caller invalidates it (#6393). Returns the
 * new matrix translation for the in-place GPU record write.
 */
export function translateInstanceRecord(
  target: InstanceTranslationTarget,
  byteOffset: number,
  delta: readonly [number, number, number],
): Float32Array {
  const dv = new DataView(target.instanceData);
  const translation = new Float32Array([
    dv.getFloat32(byteOffset + 48, true) + delta[0],
    dv.getFloat32(byteOffset + 52, true) + delta[1],
    dv.getFloat32(byteOffset + 56, true) + delta[2],
  ]);
  dv.setFloat32(byteOffset + 48, translation[0]!, true);
  dv.setFloat32(byteOffset + 52, translation[1]!, true);
  dv.setFloat32(byteOffset + 56, translation[2]!, true);
  const anchorOffset = (byteOffset / INSTANCE_STRIDE_BYTES) * 3;
  for (let axis = 0; axis < 3; axis++) target.canonicalAnchors[anchorOffset + axis] += delta[axis]!;
  target.canonicalMatrixTranslations?.set(translation, anchorOffset);
  return translation;
}
