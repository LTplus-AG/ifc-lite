/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PointCloudAlignmentTransform } from './pointCloudAlignment';

/** Change the decode origin without changing alignment: A(p-old) becomes
 * A(p-new) + A(new-old). Keep the translation in f64 until the renderer
 * composes the user's correction; a badly aligned scan can be kilometres away. */
export function rebasePointCloudDecodeOrigin(
  transform: PointCloudAlignmentTransform, origin: readonly [number, number, number],
): PointCloudAlignmentTransform {
  const old = transform.decodeOriginOffset;
  const delta = [origin[0] - old[0], origin[2] - old[2], -(origin[1] - old[1])];
  const alignedMatrix = new Float64Array(transform.alignedMatrix);
  for (let row = 0; row < 3; row++) {
    alignedMatrix[12 + row] += alignedMatrix[row] * delta[0] + alignedMatrix[4 + row] * delta[1] + alignedMatrix[8 + row] * delta[2];
  }
  return { ...transform, decodeOriginOffset: [...origin], alignedMatrix,
    unalignedMatrix: nativePointCloudOriginMatrix(origin) };
}

export function nativePointCloudOriginMatrix(origin: readonly [number, number, number]): Float64Array {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, origin[0], origin[2], -origin[1], 1]);
}
