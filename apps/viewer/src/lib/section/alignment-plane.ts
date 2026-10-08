/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { ifcToViewerAxes, viewerToIfcAxes, totalYupOffset } from '@/lib/geo/coordinate-frame';
import { planeBasis } from '@ifc-lite/renderer';
import type { CustomSectionPlane } from '@/store/types';
import { toRenderTranslation, type Translation } from '@/lib/model-placement/translation';
import { modelPointToWorkspacePoint, rotateWorkspacePoint, ZERO_ROTATION, type ModelRotation } from '@/lib/model-placement/rotation';
import type { AlignmentSectionBinding, AlignmentSectionSample } from './alignment-contract';

/** Rebase f64 first, then apply the live engineering-space model placement. */
export function alignmentSectionPlane(sample: AlignmentSectionSample, info: Pick<CoordinateInfo, 'originShift' | 'wasmRtcOffset'> | undefined,
  placement: Translation, binding: AlignmentSectionBinding, rotation: ModelRotation = ZERO_ROTATION): CustomSectionPlane {
  const point = ifcToViewerAxes({ x: sample.point[0], y: sample.point[1], z: sample.point[2] });
  const offset = totalYupOffset(info);
  const rebased = viewerToIfcAxes({ x: point.x - offset.x, y: point.y - offset.y, z: point.z - offset.z });
  const engineering: Translation = [rebased.x, rebased.y, rebased.z];
  const placed = toRenderTranslation(modelPointToWorkspacePoint(engineering, { translation: placement, rotation }));
  const pickedAt: [number, number, number] = [placed[0], placed[1], placed[2]];
  const turned = rotateWorkspacePoint(sample.tangent, { angle: rotation.angle, pivot: [0, 0, 0] });
  const direction = ifcToViewerAxes({ x: turned[0], y: turned[1], z: turned[2] });
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!pickedAt.every(Number.isFinite) || !Number.isFinite(length) || length < 1e-12) {
    throw new Error('Alignment station has no finite section frame');
  }
  const normal: [number, number, number] = [direction.x / length, direction.y / length, direction.z / length];
  const basis = planeBasis(normal);
  return { normal, pickedAt, distance: pickedAt.reduce((sum, value, index) => sum + value * normal[index], 0),
    tangent: basis.tangent, bitangent: basis.bitangent, alignment: binding };
}
