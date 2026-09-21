/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Mutation of one CPU-side instanced occurrence placement. */

import {
  INSTANCE_ANCHOR_HIGH_OFFSET,
  INSTANCE_ANCHOR_LOW_OFFSET,
  INSTANCE_STRIDE_BYTES,
} from './instanced-render.js';

export interface InstanceTranslationTarget {
  instanceData: ArrayBuffer;
  canonicalAnchors?: Float64Array;
  canonicalMatrixTranslations?: Float32Array;
}

export interface InstanceTranslationResult {
  translation: Float32Array;
  /** Legacy records retain static split anchors; V2 lanes are submission data. */
  legacyAnchors?: Float32Array;
}

/**
 * Apply a world-frame delta without turning V2's camera-relative GPU lanes
 * into a durable source origin. The f64 sidecar remains authoritative for the
 * next RTE submission; only pre-V2 records receive a compatibility anchor.
 */
export function translateInstanceRecord(
  target: InstanceTranslationTarget,
  byteOffset: number,
  delta: readonly [number, number, number],
): InstanceTranslationResult {
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
  if (target.canonicalAnchors) {
    for (let axis = 0; axis < 3; axis++) {
      target.canonicalAnchors[anchorOffset + axis] += delta[axis]!;
      // CPU records remain the durable source of truth for bounds, recovery,
      // and materialisation. Only the GPU copy of these lanes is overwritten
      // with a drawable-minus-camera delta at submission time.
      const value = target.canonicalAnchors[anchorOffset + axis]!;
      const high = Math.fround(value);
      dv.setFloat32(byteOffset + INSTANCE_ANCHOR_HIGH_OFFSET + axis * 4, high, true);
      dv.setFloat32(
        byteOffset + INSTANCE_ANCHOR_LOW_OFFSET + axis * 4,
        Math.fround(value - high),
        true,
      );
    }
  }
  if (target.canonicalMatrixTranslations) {
    target.canonicalMatrixTranslations.set(translation, anchorOffset);
  }
  if (target.canonicalAnchors) return { translation };

  const legacyAnchors = new Float32Array(8);
  for (let axis = 0; axis < 3; axis++) {
    const value = translation[axis]!;
    const high = Math.fround(value);
    legacyAnchors[axis] = high;
    legacyAnchors[axis + 4] = Math.fround(value - high);
    dv.setFloat32(byteOffset + INSTANCE_ANCHOR_HIGH_OFFSET + axis * 4, high, true);
    dv.setFloat32(byteOffset + INSTANCE_ANCHOR_LOW_OFFSET + axis * 4, legacyAnchors[axis + 4]!, true);
  }
  return { translation, legacyAnchors };
}
