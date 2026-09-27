/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ABI and ingress helpers for the main mesh shader's RTE fields (#5049).
 *
 * The mesh uniform deliberately remains one contiguous block because batches
 * own their bind groups.  Keeping the offsets and flag bits here prevents the
 * CPU writers, WGSL and picker-adjacent render paths from growing independent
 * interpretations of the appended RTE lanes.
 */

import type { ClipBox } from './types.js';
import { packRteOrigin, type RelativeToEyeFrame } from './relative-to-eye.js';
import { packRteClipBox, rtePlaneDistance } from './rte-clip-space.js';

export const MESH_UNIFORM_FLOATS = 96;
export const MESH_UNIFORM_BYTES = MESH_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT;

export const MESH_UNIFORM_OFFSET = {
  viewProj: 0,
  model: 16,
  baseColor: 32,
  metallicRoughness: 36,
  sectionPlane: 40,
  flags: 44,
  clipBoxMin: 48,
  quantParams: 56,
  rteViewProj: 60,
  drawableDelta: 76,
  rteCameraOrigin: 84,
  /** vec4<u32>: per-draw colour-table anchor + mode bits (entity-color-table.ts, #6076). */
  overrideParams: 92,
} as const;

/** flags.x: vertex and fragment values are camera-relative RTE coordinates. */
export const MESH_FLAG_RTE_DRAWABLE = 1 << 16;

/** Byte offset of flags.x, suitable for `queue.writeBuffer`. */
export const MESH_FLAGS_BYTE_OFFSET = MESH_UNIFORM_OFFSET.flags * Float32Array.BYTES_PER_ELEMENT;

export interface MeshSectionPlane {
  normal: readonly [number, number, number];
  distance: number;
  enabled: boolean;
}

/**
 * Replace world-space clipping inputs with the one camera-relative frame used
 * by the mesh vertex shader.  Plane normals are translations-invariant; only
 * `d` changes: dot(world, n) - d == dot(world-eye, n) - (d-dot(eye,n)).
 *
 * The conversion happens in f64 before the final uniform f32 write.  At a
 * 5,000 km source offset this is the difference between a stable centimetre
 * cut/crop boundary and an entire several-decimetre quantisation cell.
 */
export function packRteFragmentSpace(
  frame: RelativeToEyeFrame,
  section: MeshSectionPlane | null | undefined,
  clipBox: ClipBox | null | undefined,
  out: Float32Array,
): void {
  if (out.length < MESH_UNIFORM_FLOATS) {
    throw new RangeError(`Mesh RTE uniform needs ${MESH_UNIFORM_FLOATS} floats.`);
  }
  const eye = frame.getCameraWorld();
  const sectionOffset = MESH_UNIFORM_OFFSET.sectionPlane;
  if (section?.enabled) {
    const [nx, ny, nz] = section.normal;
    out[sectionOffset] = nx;
    out[sectionOffset + 1] = ny;
    out[sectionOffset + 2] = nz;
    out[sectionOffset + 3] = rtePlaneDistance(section.distance, section.normal, eye);
  } else {
    out.fill(0, sectionOffset, sectionOffset + 4);
  }

  const clipOffset = MESH_UNIFORM_OFFSET.clipBoxMin;
  packRteClipBox(clipBox, eye, out, clipOffset);
}

/** Pack the shared camera high/low lanes used by V2 instance anchors. */
export function packRteCameraOrigin(frame: RelativeToEyeFrame, out: Float32Array): void {
  if (out.length < MESH_UNIFORM_FLOATS) {
    throw new RangeError(`Mesh RTE uniform needs ${MESH_UNIFORM_FLOATS} floats.`);
  }
  packRteOrigin(frame.getCameraWorld(), out, MESH_UNIFORM_OFFSET.rteCameraOrigin);
}
