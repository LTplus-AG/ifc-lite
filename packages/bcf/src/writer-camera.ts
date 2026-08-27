/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writing a viewpoint's camera.
 *
 * Split out of `writer.ts` because the camera is the one part of
 * `VisualizationInfo` whose SHAPE, CARDINALITY and ORDER all differ between
 * BCF 2.1 and BCF 3.0, and keeping the three rules in one place is what makes
 * them checkable against the `visinfo.xsd` copies under
 * `__fixtures__/schemas/`. The parity is
 * pinned by `schema-validation.test.ts` > "BCF camera cardinality and order",
 * which re-derives the rules from the vendored schemas before asserting them.
 */

import type { BCFViewpoint, BCFPerspectiveCamera, BCFOrthogonalCamera } from './types.js';

/**
 * Enforce each version's rule for how many cameras a viewpoint may carry.
 *
 * The two schemas differ, and the emitted ORDER matters in one of them:
 *
 * - v2_1/visinfo.xsd puts `OrthogonalCamera` and `PerspectiveCamera` in
 *   `VisualizationInfo`'s `xs:sequence`, both `minOccurs="0"`. Either, both or
 *   neither may appear -- but an `xs:sequence` fixes the order, and the
 *   schema declares the orthogonal camera FIRST. Emitting the perspective
 *   camera first made a two-camera 2.1 viewpoint schema-invalid
 *   ("Element 'OrthogonalCamera': This element is not expected"), which is
 *   why `writer.ts`'s `writeViewpointFiles` now writes orthogonal first for both
 *   versions -- the order is required by 2.1 and harmless under 3.0's choice.
 * - v3_0/visinfo.xsd replaced that pair with an `<xs:choice>` carrying no
 *   `minOccurs` and no `maxOccurs`, so both default to 1: EXACTLY ONE camera,
 *   and it is required. Two cameras and zero cameras are each invalid there.
 *
 * We refuse the 3.0 violations rather than guessing which camera the caller
 * meant, or inventing one for a viewpoint that has none -- same policy as
 * {@link requireAspectRatioElement} and the `Topic/@TopicType` checks in
 * `writer.ts`'s `writeMarkupFile`. Silently dropping one of two cameras would discard
 * a view the caller chose; silently emitting neither writes an archive that no
 * conforming BCF 3.0 reader has to accept.
 */
export function requireCameraChoice(viewpoint: BCFViewpoint, version: '2.1' | '3.0'): void {
  if (version !== '3.0') return;
  const count = (viewpoint.orthogonalCamera ? 1 : 0) + (viewpoint.perspectiveCamera ? 1 : 0);
  if (count === 1) return;
  throw new Error(
    `BCF 3.0 requires exactly one camera per viewpoint (viewpoint "${viewpoint.guid}" has ` +
      `${count === 0 ? 'none' : 'both an orthogonalCamera and a perspectiveCamera'}). ` +
      `visinfo.xsd declares OrthogonalCamera and PerspectiveCamera as an xs:choice, so ` +
      `set exactly one before writing a 3.0 file.`
  );
}

/**
 * Require a positive AspectRatio for a BCF 3.0 camera and return the element
 * to append.
 *
 * v3_0/visinfo.xsd adds `<AspectRatio>` (type `PositiveDouble`, i.e.
 * `xs:double` with `minExclusive value="0"`) as a REQUIRED, no-minOccurs
 * child of both `OrthogonalCamera` and `PerspectiveCamera`. 2.1 has no such
 * element. We refuse to invent a value (there is no safe default aspect
 * ratio) because that would assert a value the caller never chose; instead
 * we fail the write so the caller supplies one -- same policy as the
 * `Topic/@TopicType`/`Topic/@TopicStatus` checks in `writer.ts`'s `writeMarkupFile`.
 */
function requireAspectRatioElement(aspectRatio: number | undefined, viewpointGuid: string): string {
  if (aspectRatio === undefined || !(aspectRatio > 0)) {
    throw new Error(
      `BCF 3.0 requires a positive Camera/AspectRatio (viewpoint "${viewpointGuid}" has none). ` +
        `Set the camera's aspectRatio before writing a 3.0 file.`
    );
  }
  return `\n    <AspectRatio>${aspectRatio}</AspectRatio>`;
}

/**
 * Write perspective camera XML
 */
export function writePerspectiveCamera(
  camera: BCFPerspectiveCamera,
  version: '2.1' | '3.0',
  viewpointGuid: string,
): string {
  const aspectRatioElement = version === '3.0' ? requireAspectRatioElement(camera.aspectRatio, viewpointGuid) : '';
  return `\n  <PerspectiveCamera>
    <CameraViewPoint>
      <X>${camera.cameraViewPoint.x}</X>
      <Y>${camera.cameraViewPoint.y}</Y>
      <Z>${camera.cameraViewPoint.z}</Z>
    </CameraViewPoint>
    <CameraDirection>
      <X>${camera.cameraDirection.x}</X>
      <Y>${camera.cameraDirection.y}</Y>
      <Z>${camera.cameraDirection.z}</Z>
    </CameraDirection>
    <CameraUpVector>
      <X>${camera.cameraUpVector.x}</X>
      <Y>${camera.cameraUpVector.y}</Y>
      <Z>${camera.cameraUpVector.z}</Z>
    </CameraUpVector>
    <FieldOfView>${camera.fieldOfView}</FieldOfView>${aspectRatioElement}
  </PerspectiveCamera>`;
}

/**
 * Write orthogonal camera XML
 */
export function writeOrthogonalCamera(
  camera: BCFOrthogonalCamera,
  version: '2.1' | '3.0',
  viewpointGuid: string,
): string {
  const aspectRatioElement = version === '3.0' ? requireAspectRatioElement(camera.aspectRatio, viewpointGuid) : '';
  return `\n  <OrthogonalCamera>
    <CameraViewPoint>
      <X>${camera.cameraViewPoint.x}</X>
      <Y>${camera.cameraViewPoint.y}</Y>
      <Z>${camera.cameraViewPoint.z}</Z>
    </CameraViewPoint>
    <CameraDirection>
      <X>${camera.cameraDirection.x}</X>
      <Y>${camera.cameraDirection.y}</Y>
      <Z>${camera.cameraDirection.z}</Z>
    </CameraDirection>
    <CameraUpVector>
      <X>${camera.cameraUpVector.x}</X>
      <Y>${camera.cameraUpVector.y}</Y>
      <Z>${camera.cameraUpVector.z}</Z>
    </CameraUpVector>
    <ViewToWorldScale>${camera.viewToWorldScale}</ViewToWorldScale>${aspectRatioElement}
  </OrthogonalCamera>`;
}
