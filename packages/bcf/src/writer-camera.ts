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
import { xsdDouble, xsdPointElement } from './numeric.js';

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
 * Require a FINITE, positive AspectRatio for a BCF 3.0 camera and return the
 * element to append.
 *
 * v3_0/visinfo.xsd adds `<AspectRatio>` (type `PositiveDouble`, i.e.
 * `xs:double` with `minExclusive value="0"`) as a REQUIRED, no-minOccurs
 * child of both `OrthogonalCamera` and `PerspectiveCamera`. 2.1 has no such
 * element. We refuse to invent a value (there is no safe default aspect
 * ratio) because that would assert a value the caller never chose; instead
 * we fail the write so the caller supplies one -- same policy as the
 * `Topic/@TopicType`/`Topic/@TopicStatus` checks in `writer.ts`'s `writeMarkupFile`.
 *
 * BOTH halves of `PositiveDouble` are checked here, and the positivity test
 * alone did not cover them: `Infinity > 0` is `true`, so `Infinity` walked
 * past this guard and was emitted as `<AspectRatio>Infinity</AspectRatio>`,
 * which xmllint rejects with "'Infinity' is not a valid value of the atomic
 * type 'PositiveDouble'". `xsdDouble` is what makes the `xs:double` half of
 * the claim true; the `> 0` below is the `minExclusive` facet.
 */
function requireAspectRatioElement(aspectRatio: number | undefined, viewpointGuid: string): string {
  const where = `viewpoint "${viewpointGuid}"`;
  if (aspectRatio === undefined || !(aspectRatio > 0)) {
    throw new Error(
      `BCF 3.0 requires a positive Camera/AspectRatio (${where} has ` +
        `${aspectRatio === undefined ? 'none' : aspectRatio}). ` +
        `Set the camera's aspectRatio before writing a 3.0 file.`
    );
  }
  return `\n    <AspectRatio>${xsdDouble(aspectRatio, 'Camera/AspectRatio', where)}</AspectRatio>`;
}

/**
 * Require a FINITE FieldOfView within BCF 3.0's `(0, 180)` exclusive facet and
 * return the text `xsdDouble` will accept for it.
 *
 * v3_0/visinfo.xsd's `FieldOfView` simpleType is `xs:double` with
 * `minExclusive value="0"` and `maxExclusive value="180"`. `xsdDouble` alone
 * only rejects non-finite values (Infinity/-Infinity/NaN); it says nothing
 * about a finite value that is merely out of range, so `0`, a negative number,
 * or `180` and above walked straight through it and were emitted as-is --
 * schema-invalid the same way an unset `AspectRatio` was before
 * {@link requireAspectRatioElement} started refusing it. 2.1's own
 * `FieldOfView` facet (`[45, 60]` inclusive) is deliberately NOT enforced
 * here: its own schema annotation says "This limitation will be dropped in
 * the next release and viewers should expect values outside this range in
 * current implementations", so treating it as a hard constraint would reject
 * legitimate 2.1 input the schema authors themselves disclaim.
 */
function requireFieldOfViewElement(fieldOfView: number, viewpointGuid: string): string {
  const where = `viewpoint "${viewpointGuid}"`;
  if (!(fieldOfView > 0 && fieldOfView < 180)) {
    throw new Error(
      `BCF 3.0 requires PerspectiveCamera/FieldOfView in (0, 180) exclusive (${where} has ` +
        `${fieldOfView}). visinfo.xsd's FieldOfView simpleType declares minExclusive="0" and ` +
        `maxExclusive="180"; set a value inside that range before writing a 3.0 file.`
    );
  }
  return xsdDouble(fieldOfView, 'PerspectiveCamera/FieldOfView', where);
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
  const where = `viewpoint "${viewpointGuid}"`;
  const fieldOfView =
    version === '3.0'
      ? requireFieldOfViewElement(camera.fieldOfView, viewpointGuid)
      : xsdDouble(camera.fieldOfView, 'PerspectiveCamera/FieldOfView', where);
  return `\n  <PerspectiveCamera>${cameraVectors(camera, where)}
    <FieldOfView>${fieldOfView}</FieldOfView>${aspectRatioElement}
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
  const where = `viewpoint "${viewpointGuid}"`;
  return `\n  <OrthogonalCamera>${cameraVectors(camera, where)}
    <ViewToWorldScale>${xsdDouble(camera.viewToWorldScale, 'OrthogonalCamera/ViewToWorldScale', where)}</ViewToWorldScale>${aspectRatioElement}
  </OrthogonalCamera>`;
}

/**
 * The three vectors both camera types open with, in the order both schemas'
 * `xs:sequence` declares them.
 *
 * Identical in `OrthogonalCamera` and `PerspectiveCamera` and in 2.1 and 3.0 --
 * the cameras differ only in the single element that follows (`ViewToWorldScale`
 * vs `FieldOfView`). Writing them once is what makes "every camera coordinate
 * is checked" a property of the code rather than of six copied templates.
 */
function cameraVectors(
  camera: BCFPerspectiveCamera | BCFOrthogonalCamera,
  where: string
): string {
  return (
    xsdPointElement('CameraViewPoint', camera.cameraViewPoint, '    ', where) +
    xsdPointElement('CameraDirection', camera.cameraDirection, '    ', where) +
    xsdPointElement('CameraUpVector', camera.cameraUpVector, '    ', where)
  );
}
