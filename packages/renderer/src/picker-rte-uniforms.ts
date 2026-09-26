/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Dynamic uniform writers for production RTE object picking. */

import { packPickClip, packPickUniforms } from './pick-uniforms.js';
import { packRteOrigin, type RelativeToEyeSnapshot } from './relative-to-eye.js';
import { packRteClipBox, rtePlaneDistance } from './rte-clip-space.js';
import type { Mesh, PickClipState } from './types.js';

export function writePickUniforms(
  device: GPUDevice,
  buffer: GPUBuffer,
  scratch: Float32Array,
  clipFlags: Uint32Array,
  viewProj: Float32Array,
  clip?: PickClipState | null,
): void {
  scratch.fill(0);
  scratch.set(viewProj, 0);
  scratch[16] = 1; scratch[21] = 1; scratch[26] = 1; scratch[31] = 1;
  packPickClip(clip, scratch, clipFlags, 32);
  device.queue.writeBuffer(buffer, 0, scratch);
}

/**
 * Write one flat mesh's pick uniforms into dynamic slot `slot`. Returns false,
 * writing nothing, for a mesh outside the snapshot's camera-relative envelope:
 * the pick pass draws every visible mesh unculled, and such a mesh cannot be
 * rasterised in this frame, so the caller must skip its draw (#6128).
 */
export function writeFlatPickUniform(
  device: GPUDevice,
  buffer: GPUBuffer,
  scratch: Float32Array,
  clipFlags: Uint32Array,
  mesh: Mesh,
  snapshot: RelativeToEyeSnapshot,
  clip: PickClipState | null | undefined,
  slot: number,
): boolean {
  scratch.fill(0);
  if (!snapshot.tryPackDrawableOrigin(
    mesh.rteOrigin ?? [mesh.transform.m[12], mesh.transform.m[13], mesh.transform.m[14]], scratch, 48,
  )) return false;
  scratch.set(snapshot.getViewProjection().m, 0);
  scratch.set(mesh.transform.m, 16);
  packPickClip(clip, scratch, clipFlags, 32);
  const camera = snapshot.getCameraWorld();
  packRteClipBox(clip?.clipBox, camera, scratch, 32);
  if (clip?.sectionPlane) scratch[43] = rtePlaneDistance(clip.sectionPlane.distance, clip.sectionPlane.normal, camera);
  device.queue.writeBuffer(buffer, slot * 256, scratch);
  return true;
}

export function writeInstancedPickUniforms(
  device: GPUDevice,
  buffer: GPUBuffer,
  scratch: Float32Array,
  clipFlags: Uint32Array,
  snapshot: RelativeToEyeSnapshot,
  clip?: PickClipState | null,
): void {
  packPickUniforms(snapshot.getViewProjection().m, clip, scratch, clipFlags);
  const camera = snapshot.getCameraWorld();
  packRteClipBox(clip?.clipBox, camera, scratch, 16);
  if (clip?.sectionPlane) scratch[27] = rtePlaneDistance(clip.sectionPlane.distance, clip.sectionPlane.normal, camera);
  packRteOrigin(camera, scratch, 32);
  scratch[35] = 0; scratch[39] = 0;
  device.queue.writeBuffer(buffer, 0, scratch);
}
