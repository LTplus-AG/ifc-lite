/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Frame Selection has to leave every corner of the box it was handed on
 * screen, for the direction the camera is actually pointing (#3892).
 *
 * `fitDistanceFor` used to fit the box's LARGEST SIDE into the half-angles,
 * which answers a different question than the projection asks. Two ways that
 * came apart, both of them live on the viewer's Frame Selection path:
 *
 *  1. **Depth.** The near half of the box is closer than its centre, so it
 *     projects bigger than the side-based rule accounts for. Even head-on and
 *     axis-aligned, a cube needs `half / tan + half`, not `half / tan`.
 *  2. **Obliqueness.** The direction comes from the live pose and is
 *     essentially never axis-aligned, and down a diagonal a box projects wider
 *     than any single side of it.
 *
 * Orthographic mode gets its own suite at the bottom. There the standoff sets
 * no scale at all — `orthoSize` does — so only the obliqueness half applies,
 * and it applies to a different formula.
 *
 * The oracle is deliberately not the fit's own arithmetic: it builds a
 * view-projection matrix from the pose the fit returned and pushes all eight
 * corners through it. A corner is on screen when `|clip.x| <= clip.w` and
 * `|clip.y| <= clip.w`. `MathUtils.perspective` rather than the renderer's
 * `perspectiveReverseZ`: they differ only in the depth row, and the clip x, y
 * and w these assertions read are identical between them.
 *
 * `worstClipRatio` also gives the anti-mutation half. The inside-check is
 * monotone in distance, so it passes on a camera parked arbitrarily far away;
 * the padding is a plain multiple of the fitted distance, so scaling the pose
 * back by it must land the worst corner exactly ON the frustum edge.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { Vec3, Camera as CameraType, Mat4 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import {
  frameBoundsTarget,
  zoomExtentTarget,
  type FramingBounds,
  type FramingTarget,
} from './camera-framing.js';
import { CAMERA_CONSTANTS } from './constants.js';
import { presetViewTarget } from './camera-preset-view.js';
import { MathUtils } from './math.js';

const FOV = Math.PI / 4;
const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** `presetViewTarget` pads like Zoom Extents does. */
const PRESET_PADDING = CAMERA_CONSTANTS.ZOOM_EXTENT_PADDING;

/**
 * A camera state at this pose.
 *
 * The view matrix is filled in with the one the renderer would build so the
 * state is internally consistent, but since #3892 none of the fits read it:
 * they take their basis from `position` / `target` / `up` through `viewBasis`.
 */
function makeState(
  aspect: number,
  position: Vec3,
  target: Vec3,
  mode: 'perspective' | 'orthographic' = 'perspective',
): CameraInternalState {
  const camera: CameraType = {
    position,
    target,
    up: { ...UP },
    fov: FOV,
    aspect,
    near: 0.1,
    far: 100000,
  };
  const identity: Mat4 = { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  return {
    camera,
    viewMatrix: MathUtils.lookAt(position, target, camera.up),
    projMatrix: identity,
    viewProjMatrix: identity,
    projectionMode: mode,
    orthoSize: 50,
    sceneBounds: null,
    orbitAnchorBounds: null,
  };
}

/** `m * (v, 1)`, column-major, as `MathUtils.multiply` and `lookAt` store it. */
function transform(m: Float32Array, v: Vec3): { x: number; y: number; w: number } {
  return {
    x: m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12],
    y: m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13],
    w: m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15],
  };
}

/** Enumerated here rather than shared with the fit, so the oracle cannot inherit its blind spot. */
function cornersOf(bounds: FramingBounds): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) out.push({ x, y, z });
    }
  }
  return out;
}

/**
 * How far the worst corner of `bounds` reaches towards the edge of the frame,
 * as a fraction of the half-frame it is measured against. `<= 1` is on screen.
 */
function worstClipRatio(
  pose: FramingTarget,
  bounds: FramingBounds,
  projection: Mat4,
  up: Vec3 = UP,
): number {
  const viewProj = MathUtils.multiply(projection, MathUtils.lookAt(pose.position, pose.target, up));
  let worst = 0;
  for (const corner of cornersOf(bounds)) {
    const clip = transform(viewProj.m, corner);
    assert.ok(clip.w > 0, `corner ${JSON.stringify(corner)} is behind the camera (w = ${clip.w})`);
    worst = Math.max(worst, Math.abs(clip.x) / clip.w, Math.abs(clip.y) / clip.w);
  }
  return worst;
}

function perspectiveAt(aspect: number): Mat4 {
  return MathUtils.perspective(FOV, aspect, 0.1, 100000);
}

/** The frame `orthoSize` describes: half-height `size`, half-width `size * aspect`. */
function orthographicAt(size: number, aspect: number): Mat4 {
  return MathUtils.orthographicReverseZ(-size * aspect, size * aspect, -size, size, 0.1, 100000);
}

/** The same pose with its standoff divided by `padding`. */
function unpadded(pose: FramingTarget, padding: number): FramingTarget {
  return {
    ...pose,
    position: {
      x: pose.target.x + (pose.position.x - pose.target.x) / padding,
      y: pose.target.y + (pose.position.y - pose.target.y) / padding,
      z: pose.target.z + (pose.position.z - pose.target.z) / padding,
    },
  };
}

function boxAt(center: Vec3, size: Vec3): FramingBounds {
  return {
    min: { x: center.x - size.x / 2, y: center.y - size.y / 2, z: center.z - size.z / 2 },
    max: { x: center.x + size.x / 2, y: center.y + size.y / 2, z: center.z + size.z / 2 },
  };
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** Centre of the one box that does not sit on the origin. */
const OFF_CENTRE: Vec3 = { x: 120, y: -30, z: 55 };

/** A unit cube, an elongated slab — the shape the issue names — and one away from the origin. */
const BOXES: ReadonlyArray<readonly [string, Vec3, FramingBounds]> = [
  ['unit cube', ORIGIN, boxAt(ORIGIN, { x: 1, y: 1, z: 1 })],
  ['elongated slab', ORIGIN, boxAt(ORIGIN, { x: 40, y: 3, z: 8 })],
  ['off-centre slab', OFF_CENTRE, boxAt(OFF_CENTRE, { x: 24, y: 2, z: 2 })],
];

/**
 * Offsets whose view direction is oblique to every box axis, which is what the
 * live pose almost always is: the camera has been orbited.
 */
const OBLIQUE_OFFSETS: ReadonlyArray<readonly [string, Vec3]> = [
  ['south-east isometric', { x: 60, y: 50, z: 60 }],
  ['shallow diagonal', { x: 130, y: 17, z: -71 }],
  ['steep diagonal', { x: -23, y: 140, z: 41 }],
];

const ASPECTS: ReadonlyArray<readonly [string, number]> = [
  ['16:9', 16 / 9],
  ['1:1', 1],
  ['9:16', 9 / 16],
];

/** The two fits that inherit the pose's direction, with the padding each uses. */
const POSE_FITS = [
  ['frameBounds', frameBoundsTarget, CAMERA_CONSTANTS.FRAME_PADDING_MULTIPLIER],
  ['zoomExtent', zoomExtentTarget, CAMERA_CONSTANTS.ZOOM_EXTENT_PADDING],
] as const;

function posedAt(center: Vec3, offset: Vec3): Vec3 {
  return { x: center.x + offset.x, y: center.y + offset.y, z: center.z + offset.z };
}

describe('Frame Selection keeps every box corner on screen (#3892)', () => {
  for (const [boxLabel, center, bounds] of BOXES) {
    for (const [dirLabel, offset] of OBLIQUE_OFFSETS) {
      for (const [aspectLabel, aspect] of ASPECTS) {
        for (const [fitLabel, pick] of POSE_FITS) {
          it(`${fitLabel}: ${boxLabel}, ${dirLabel}, ${aspectLabel}`, () => {
            const state = makeState(aspect, posedAt(center, offset), center);
            const fit = pick(state, bounds.min, bounds.max);
            assert.ok(fit, 'the box is usable and must produce a fit');
            const ratio = worstClipRatio(fit, bounds, perspectiveAt(aspect));
            assert.ok(ratio <= 1, `worst corner reaches ${ratio.toFixed(4)} of the half-frame; > 1 is cropped`);
          });
        }
      }
    }
  }

  it('a head-on preset view keeps the near face on screen too', () => {
    // Not an oblique direction at all: the depth half of the defect on its
    // own. The near face of a cube is `half` closer than the centre the
    // side-based rule measured from.
    for (const [, aspect] of ASPECTS) {
      for (const view of ['front', 'back', 'left', 'right', 'top', 'bottom'] as const) {
        const bounds = boxAt(ORIGIN, { x: 20, y: 20, z: 20 });
        const state = makeState(aspect, { x: 0, y: 0, z: 100 }, ORIGIN);
        const fit = presetViewTarget(state, view, bounds, 0);
        const ratio = worstClipRatio(fit, bounds, perspectiveAt(aspect), fit.up);
        assert.ok(ratio <= 1, `${view} @ ${aspect}: worst corner reaches ${ratio.toFixed(4)}`);
      }
    }
  });
});

describe('the corner fit is tight under its padding (#3892)', () => {
  // Without this the suite above would pass on a camera parked arbitrarily far
  // away, since the inside-check only ever relaxes with distance.
  for (const [boxLabel, center, bounds] of BOXES) {
    for (const [fitLabel, pick, padding] of POSE_FITS) {
      it(`${fitLabel} puts the worst corner on the edge once padding is removed: ${boxLabel}`, () => {
        const position = posedAt(center, { x: 130, y: 17, z: -71 });
        for (const [, aspect] of ASPECTS) {
          const fit = pick(makeState(aspect, position, center), bounds.min, bounds.max);
          assert.ok(fit, 'fit expected');
          const ratio = worstClipRatio(unpadded(fit, padding), bounds, perspectiveAt(aspect));
          assert.ok(
            Math.abs(ratio - 1) < 1e-4,
            `@ aspect ${aspect}: unpadded worst corner reaches ${ratio.toFixed(6)}, expected 1`,
          );
        }
      });
    }
  }

  it('presetViewTarget is tight too', () => {
    const bounds = boxAt(ORIGIN, { x: 40, y: 6, z: 12 });
    for (const [, aspect] of ASPECTS) {
      const state = makeState(aspect, { x: 0, y: 0, z: 100 }, ORIGIN);
      const fit = presetViewTarget(state, 'front', bounds, 0);
      const ratio = worstClipRatio(unpadded(fit, PRESET_PADDING), bounds, perspectiveAt(aspect), fit.up);
      assert.ok(
        Math.abs(ratio - 1) < 1e-4,
        `@ aspect ${aspect}: unpadded worst corner reaches ${ratio.toFixed(6)}, expected 1`,
      );
    }
  });
});

describe('orthographic framing keeps every box corner on screen (#3892)', () => {
  // `orthoSize` is the whole framing in orthographic mode — the standoff sets
  // no scale — so the corner fit has to reach it as well. There is no depth
  // term to answer here, an orthographic projection does not foreshorten, but
  // the obliqueness one lands in full: down a south-east isometric direction a
  // 20-unit cube reaches 15.9 units above the centre line, against the 10 the
  // largest-side rule allowed.
  for (const [boxLabel, center, bounds] of BOXES) {
    for (const [dirLabel, offset] of OBLIQUE_OFFSETS) {
      for (const [aspectLabel, aspect] of ASPECTS) {
        for (const [fitLabel, pick] of POSE_FITS) {
          it(`${fitLabel}: ${boxLabel}, ${dirLabel}, ${aspectLabel}`, () => {
            const state = makeState(aspect, posedAt(center, offset), center, 'orthographic');
            const fit = pick(state, bounds.min, bounds.max);
            assert.ok(fit, 'the box is usable and must produce a fit');
            assert.ok(fit.orthoSize !== undefined, 'orthographic mode must report an orthoSize');
            const ratio = worstClipRatio(fit, bounds, orthographicAt(fit.orthoSize, aspect));
            assert.ok(ratio <= 1, `worst corner reaches ${ratio.toFixed(4)} of the half-frame; > 1 is cropped`);
          });
        }
      }
    }
  }

  it('the orthographic fit is tight under its padding', () => {
    // Same guard as the perspective one: `orthoSize` grows the frame, so the
    // check above passes on any value large enough. Divide the padding back
    // out and the worst corner must sit exactly on the edge.
    const center = OFF_CENTRE;
    const bounds = boxAt(center, { x: 24, y: 2, z: 2 });
    for (const [, aspect] of ASPECTS) {
      for (const [fitLabel, pick, padding] of POSE_FITS) {
        const state = makeState(aspect, posedAt(center, { x: 130, y: 17, z: -71 }), center, 'orthographic');
        const fit = pick(state, bounds.min, bounds.max);
        assert.ok(fit?.orthoSize !== undefined, 'orthoSize expected');
        const ratio = worstClipRatio(fit, bounds, orthographicAt(fit.orthoSize / padding, aspect));
        assert.ok(
          Math.abs(ratio - 1) < 1e-4,
          `${fitLabel} @ aspect ${aspect}: unpadded worst corner reaches ${ratio.toFixed(6)}, expected 1`,
        );
      }
    }
  });

  it('a degenerate box still gets a usable orthoSize floor', () => {
    // The floor the largest-side rule carried and the corner walk must keep: a
    // box with no size fits at every scale including zero, which would leave
    // the viewer at infinite zoom. Reached with a degenerate POSE as well,
    // which is what sends a point-sized box past `zoomExtent`'s
    // keep-the-current-offset branch and into the fit.
    const point: Vec3 = { x: 5, y: 5, z: 5 };
    const state = makeState(16 / 9, point, point, 'orthographic');
    const fit = zoomExtentTarget(state, point, point);
    assert.ok(fit, 'a degenerate box is valid and must still produce a fit');
    assert.ok((fit.orthoSize ?? 0) > 0, `orthoSize must stay positive, was ${fit.orthoSize}`);
  });
});

describe('Frame Selection points the camera where the pose points (#3892)', () => {
  // The fit read the view matrix as `-(m[8], m[9], m[10])`, which is the world
  // Z axis expressed in CAMERA coordinates, not the camera's world-space
  // backward axis (that is `(m[2], m[6], m[10])`). It is unit length, so no
  // finiteness or magnitude guard could notice, and it agreed with the pose
  // only for a symmetric rotation. Frame Selection therefore jumped to a
  // mirrored direction on the very poses the corner fit is about.
  it('keeps the current view direction for an oblique pose', () => {
    const bounds = boxAt(ORIGIN, { x: 10, y: 10, z: 10 });
    const offset: Vec3 = { x: 60, y: 50, z: 60 };
    const state = makeState(16 / 9, offset, ORIGIN);
    const fit = frameBoundsTarget(state, bounds.min, bounds.max);
    assert.ok(fit, 'fit expected');
    const len = Math.sqrt(offset.x ** 2 + offset.y ** 2 + offset.z ** 2);
    const fitLen = Math.sqrt(fit.position.x ** 2 + fit.position.y ** 2 + fit.position.z ** 2);
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(
        Math.abs(fit.position[axis] / fitLen - offset[axis] / len) < 1e-6,
        `position.${axis} is ${fit.position[axis]}, off the pose's own direction`,
      );
    }
  });
});
