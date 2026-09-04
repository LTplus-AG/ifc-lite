/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera half of the IDS to BCF reporter.
 *
 * Split out of `ids-reporter.ts` because BCF 3.0's camera rules are a policy
 * of their own: `v3_0/visinfo.xsd` declares `OrthogonalCamera` and
 * `PerspectiveCamera` as an `xs:choice` with the default `minOccurs`/
 * `maxOccurs` of 1 (exactly one camera per viewpoint, required), and makes
 * `<AspectRatio>` a required child of both. The reporter builds its own
 * viewpoints rather than going through `createViewpoint`, so nothing else in
 * this package enforced either rule for it -- both violations surfaced only
 * from `writeBCF`, whole archives at a time, with no way back to the export
 * option that caused them (#3849).
 */

import type { BCFPerspectiveCamera, BCFProject } from './types.js';

/** Bounds for an entity, used for camera computation (viewer Y-up coords) */
export interface EntityBoundsInput {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Aspect ratio a computed camera gets when the caller names none.
 *
 * There is no viewport behind an IDS report -- the camera is derived from
 * entity bounds, headlessly, and may never have been on screen. 16/9 is the
 * convention for "no viewport existed": it is what the BCF sample files and
 * the common desktop viewports use, and a viewer restoring the viewpoint
 * re-frames to its own aspect anyway. This is the one place in the package
 * that invents an aspect ratio, and it does so because a computed camera has
 * no captured value to preserve; `writer-camera.ts` still refuses to invent
 * one for a camera the CALLER supplied.
 */
export const DEFAULT_ASPECT_RATIO = 16 / 9;

/**
 * Vertical field of view of every computed camera, in degrees.
 *
 * Inside BCF 3.0's `(0, 180)` exclusive facet and BCF 2.1's `[45, 60]` one, so
 * one value is writable under both.
 */
const FIELD_OF_VIEW_DEGREES = 60;

/** How {@link DEFAULT_ASPECT_RATIO} reads in an error message. */
const DEFAULT_ASPECT_RATIO_TEXT = '16/9';

/**
 * Refuse an `aspectRatio` export option that no camera could carry.
 *
 * `visinfo.xsd` types `AspectRatio` as `PositiveDouble` -- `xs:double` with
 * `minExclusive value="0"` -- so `0`, a negative number, `NaN` and `Infinity`
 * are all invalid, and `writer-camera.ts` already rejects them. It can only
 * name the viewpoint GUID it was writing, though: a value this package
 * generated, for whichever topic came first, traceable to nothing the caller
 * typed. Checking the option where the caller set it is the difference
 * between "fix this argument" and "bisect your report".
 *
 * Checked for BOTH versions even though 2.1 emits no `AspectRatio`: the value
 * is still wrong, it still lands on every camera in the project, and
 * `readBCF` + re-export is how a 2.1 project becomes a 3.0 one.
 */
export function requireAspectRatioOption(aspectRatio: number): number {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new Error(
      `createBCFFromIDSReport's aspectRatio option must be a finite number ` +
        `greater than 0 (got ${aspectRatio}). BCF 3.0's visinfo.xsd types ` +
        `AspectRatio as PositiveDouble, so this value could not be written; ` +
        `omit the option to use the ${DEFAULT_ASPECT_RATIO_TEXT} default.`,
    );
  }
  return aspectRatio;
}

/**
 * Compute a BCF perspective camera from entity bounds.
 *
 * Bounds are in viewer coordinates (Y-up).
 * BCF uses Z-up, so we convert:
 *   BCF.x = Viewer.x
 *   BCF.y = -Viewer.z
 *   BCF.z = Viewer.y
 *
 * Camera is placed at a southeast-isometric angle from the entity center,
 * at a distance that frames the entity's bounding box with padding.
 *
 * @param aspectRatio - viewport ratio (width / height) written to
 *   `AspectRatio` under BCF 3.0. 2.1 has no such element and the writer emits
 *   none there, so one value serves both versions.
 */
export function computeCameraFromBounds(
  bounds: EntityBoundsInput,
  aspectRatio: number = DEFAULT_ASPECT_RATIO,
): BCFPerspectiveCamera {
  // Center in viewer coords (Y-up)
  const cx = (bounds.min.x + bounds.max.x) / 2;
  const cy = (bounds.min.y + bounds.max.y) / 2;
  const cz = (bounds.min.z + bounds.max.z) / 2;

  // Max extent for framing distance
  const sx = bounds.max.x - bounds.min.x;
  const sy = bounds.max.y - bounds.min.y;
  const sz = bounds.max.z - bounds.min.z;
  const maxSize = Math.max(sx, sy, sz, 0.1); // Floor to avoid zero

  // Camera distance: fit maxSize into the 60deg FOV with 1.5x padding.
  //
  // `FieldOfView` is the VERTICAL angle in BCF, and the horizontal one follows
  // from the aspect ratio: tan(hHalf) = aspectRatio * tan(vHalf). Framing off
  // the vertical angle alone therefore held only while the viewport was at
  // least as wide as it is tall; at a portrait ratio the horizontal angle is
  // the NARROWER of the two, and a wide entity was cropped by exactly the
  // factor the ratio understated (at 9/16, by 16/9). Dividing by the narrower
  // half-angle frames the box in whichever direction is tighter, and is inert
  // at every ratio >= 1 -- including the 16/9 default -- because the vertical
  // angle is the narrower one there.
  const vHalf = (FIELD_OF_VIEW_DEGREES * Math.PI) / 360;
  const hHalf = Math.atan(aspectRatio * Math.tan(vHalf));
  const distance = (maxSize / 2) / Math.tan(Math.min(vHalf, hHalf)) * 1.5;

  // Southeast-isometric offset in viewer coords (Y-up):
  // camera position = center + normalized(0.6, 0.5, 0.6) * distance
  const offsetLen = Math.sqrt(0.6 * 0.6 + 0.5 * 0.5 + 0.6 * 0.6);
  const ox = (0.6 / offsetLen) * distance;
  const oy = (0.5 / offsetLen) * distance;
  const oz = (0.6 / offsetLen) * distance;

  const camX = cx + ox;
  const camY = cy + oy;
  const camZ = cz + oz;

  // Direction: from camera to center (viewer coords)
  const dx = cx - camX;
  const dy = cy - camY;
  const dz = cz - camZ;
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Convert to BCF coords (Z-up)
  // Viewer (x, y, z) → BCF (x, -z, y)
  return {
    cameraViewPoint: { x: camX, y: -camZ, z: camY },
    cameraDirection: {
      x: dx / dLen,
      y: -dz / dLen,
      z: dy / dLen,
    },
    cameraUpVector: { x: 0, y: 0, z: 1 }, // BCF Z-up
    fieldOfView: FIELD_OF_VIEW_DEGREES,
    aspectRatio,
  };
}

/**
 * The box containing every bound given, or `undefined` when none were.
 *
 * CONTRACT: the caller must pass a box for EVERY entity the viewpoint frames.
 * A union over a subset is not a smaller mistake than no camera at all -- it
 * is a camera that looks convincing and leaves the uncovered entities off
 * screen, with nothing in the file saying so. `buildTopicsPerSpecification`
 * therefore passes `undefined` unless it has bounds for all of them, which
 * makes {@link requireCamerasForVersion} refuse the 3.0 export by name rather
 * than write a partial frame.
 *
 * Per-specification grouping puts many entities in ONE viewpoint, so no single
 * entity's box is the right frame for it. Framing the union is what lets that
 * grouping produce a 3.0-writable camera at all -- otherwise `entityBounds`
 * would be an option that fixes per-entity and per-requirement exports while
 * leaving the third grouping permanently unwritable, and the refusal below
 * would be naming a remedy that does not work for it.
 */
/**
 * The union of the boxes for EVERY key given, or `undefined` if any key has
 * none.
 *
 * All-or-nothing for the reason {@link unionBounds} documents: the
 * per-specification viewpoint frames a whole group of entities, and a union
 * over the subset that happened to have bounds is a camera that leaves the
 * rest off screen while looking entirely plausible. `undefined` leaves the
 * viewpoint camera-less, which {@link requireCamerasForVersion} turns into a
 * 3.0 refusal naming the topic and the missing option (#3849).
 */
export function unionBoundsForEveryKey(
  keys: readonly string[],
  entityBounds: Map<string, EntityBoundsInput> | undefined,
): EntityBoundsInput | undefined {
  const boxes: EntityBoundsInput[] = [];
  for (const key of keys) {
    const box = entityBounds?.get(key);
    if (!box) return undefined;
    boxes.push(box);
  }
  return unionBounds(boxes);
}

function unionBounds(
  boxes: readonly EntityBoundsInput[],
): EntityBoundsInput | undefined {
  if (boxes.length === 0) return undefined;
  const min = { ...boxes[0].min };
  const max = { ...boxes[0].max };
  for (const box of boxes.slice(1)) {
    min.x = Math.min(min.x, box.min.x);
    min.y = Math.min(min.y, box.min.y);
    min.z = Math.min(min.z, box.min.z);
    max.x = Math.max(max.x, box.max.x);
    max.y = Math.max(max.y, box.max.y);
    max.z = Math.max(max.z, box.max.z);
  }
  return { min, max };
}

/**
 * Refuse a 3.0 project whose viewpoints have no camera, naming the topic.
 *
 * The reporter can only give a viewpoint a camera when the caller supplied
 * bounds for the entities in it. Without them there is nothing to compute
 * from, and inventing a framing would assert a view of the model nobody has
 * -- the same policy `writer-camera.ts` applies to a missing `AspectRatio`.
 * So we refuse; the only question is WHERE.
 *
 * Here, rather than in `writeBCF`, because the caller's mistake is an export
 * OPTION (`version: '3.0'` with no `entityBounds`), and `writeBCF` can only
 * report the viewpoint GUID of whichever topic it reached first -- a GUID this
 * function generated moments earlier, which appears in nothing the caller
 * wrote. Naming the topic, and the option that fixes it, is the difference
 * between an error the caller can act on and one they have to bisect.
 */
export function requireCamerasForVersion(project: BCFProject): void {
  if (project.version !== '3.0') return;
  for (const topic of project.topics.values()) {
    for (const viewpoint of topic.viewpoints) {
      if (viewpoint.perspectiveCamera || viewpoint.orthogonalCamera) continue;
      throw new Error(
        `BCF 3.0 requires exactly one camera per viewpoint, and topic ` +
          `"${topic.title}" (${topic.guid}) has a viewpoint with none. ` +
          `createBCFFromIDSReport computes a camera only from entityBounds, ` +
          `so pass entityBounds covering every reported entity ` +
          `(keyed "modelId:expressId"), or export version "2.1" and set an ` +
          `explicit camera on each viewpoint before writing 3.0.`,
      );
    }
  }
}
