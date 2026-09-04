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

type Vec3 = readonly [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(dot(v, v));
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Slack left around the framed box, as a multiple of the fitted distance.
 *
 * The fit below puts the worst corner exactly on the frustum edge, which
 * reads as a crop in any viewer that letterboxes or draws a border.
 *
 * Exported so the tests can take the padding back out and assert the fit
 * underneath it is TIGHT. `cornersOutsideFrustum` is monotone in distance, so
 * without that the whole corner-fit suite would pass on a camera parked
 * arbitrarily far away.
 */
export const FRAMING_PADDING = 1.5;

/**
 * Floor on the FITTED distance for a box with no size, in model units.
 *
 * A point fits at every distance including zero, which would put the camera
 * inside the entity it is meant to be looking at. Floored before
 * {@link FRAMING_PADDING} applies, so the standoff such a box actually gets is
 * this times the padding.
 */
const MIN_FRAMED_DISTANCE = 0.1;

/**
 * The southeast-isometric camera basis, in viewer coordinates (Y-up).
 *
 * Fixed for every computed camera, so it is derived once here rather than per
 * call. The camera sits at `center + CAMERA_OFFSET * distance` and looks back
 * along `CAMERA_FORWARD`; `CAMERA_RIGHT` and `CAMERA_UP` are perpendicular to
 * that, which is why the standoff cancels out of a corner's sideways offsets
 * in the fit below and appears only in its depth.
 */
const CAMERA_OFFSET = normalize([0.6, 0.5, 0.6]);
const CAMERA_FORWARD: Vec3 = [-CAMERA_OFFSET[0], -CAMERA_OFFSET[1], -CAMERA_OFFSET[2]];
const CAMERA_RIGHT = normalize(cross(CAMERA_FORWARD, [0, 1, 0]));
const CAMERA_UP = cross(CAMERA_RIGHT, CAMERA_FORWARD);

/**
 * The smallest standoff along {@link CAMERA_OFFSET} that puts every corner of
 * `bounds` inside both half-angles, before padding.
 *
 * The distance used to come from the largest SIDE of the box, which is not
 * what the projection sees: down this isometric axis a box projects wider than
 * any of its sides, so a unit cube's worst corner sat at a vertical slope of
 * 0.837 against the tan(30 deg) = 0.577 limit at 16/9, and overran
 * horizontally at 9/16 (#3882). Only the corners answer the question, so all
 * eight are walked.
 *
 * A corner's sideways offsets `h` and `v` do not depend on the standoff, and
 * its depth is `dot(corner, CAMERA_FORWARD) + distance`. It is inside when
 * `h <= tanH * depth` and `v <= tanV * depth`; solving each for `distance` and
 * taking the largest satisfies all sixteen constraints at once, because
 * growing the distance only ever relaxes them.
 */
function fitCornersInFrustum(
  bounds: EntityBoundsInput,
  center: Vec3,
  tanH: number,
  tanV: number,
): number {
  let distance = 0;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const corner: Vec3 = [x - center[0], y - center[1], z - center[2]];
        const depthAtCenter = dot(corner, CAMERA_FORWARD);
        const h = Math.abs(dot(corner, CAMERA_RIGHT)) / tanH;
        const v = Math.abs(dot(corner, CAMERA_UP)) / tanV;
        distance = Math.max(distance, h - depthAtCenter, v - depthAtCenter);
      }
    }
  }
  return distance;
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
  const center: Vec3 = [
    (bounds.min.x + bounds.max.x) / 2,
    (bounds.min.y + bounds.max.y) / 2,
    (bounds.min.z + bounds.max.z) / 2,
  ];

  // `FieldOfView` is the VERTICAL angle in BCF, and the horizontal one follows
  // from the aspect ratio: tan(hHalf) = aspectRatio * tan(vHalf). Both bound
  // every corner below, so neither a portrait nor a landscape viewport crops
  // the box.
  const tanV = Math.tan((FIELD_OF_VIEW_DEGREES * Math.PI) / 360);
  const tanH = aspectRatio * tanV;

  const distance =
    Math.max(fitCornersInFrustum(bounds, center, tanH, tanV), MIN_FRAMED_DISTANCE) *
    FRAMING_PADDING;

  // Southeast-isometric position in viewer coords (Y-up).
  const camX = center[0] + CAMERA_OFFSET[0] * distance;
  const camY = center[1] + CAMERA_OFFSET[1] * distance;
  const camZ = center[2] + CAMERA_OFFSET[2] * distance;

  // Convert to BCF coords (Z-up)
  // Viewer (x, y, z) → BCF (x, -z, y). The camera sits on the +CAMERA_OFFSET
  // ray from the center, so it looks back along CAMERA_FORWARD exactly.
  return {
    cameraViewPoint: { x: camX, y: -camZ, z: camY },
    cameraDirection: {
      x: CAMERA_FORWARD[0],
      y: -CAMERA_FORWARD[2],
      z: CAMERA_FORWARD[1],
    },
    cameraUpVector: { x: 0, y: 0, z: 1 }, // BCF Z-up
    fieldOfView: FIELD_OF_VIEW_DEGREES,
    aspectRatio,
  };
}

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
