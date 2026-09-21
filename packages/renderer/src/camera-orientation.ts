/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CameraInternalState } from './camera-state.js';
import type { CameraAnimator } from './camera-animation.js';
import { areFiniteNumbers, isUsableDistance } from './camera-guards.js';
import { CAMERA_CONSTANTS } from './constants.js';

/** Absolute orientation and readouts share the camera's authored f64 pose. */
export class CameraOrientation {
  constructor(
    private readonly state: CameraInternalState,
    private readonly animator: CameraAnimator,
    private readonly updateMatrices: () => void,
  ) {}

  /**
   * Get distance from camera position to target.
   *
   * Deliberately **unsanitized**: it reports the pose as it actually is, so a
   * malformed one (a BCF viewpoint restored from a file reaches the public
   * setters unvalidated) yields NaN rather than a substituted number. This is
   * a measurement, not a control input: it is what `useBCF` reads back when
   * restoring a viewpoint and what the BCF overlay scales markers by. There is
   * no substitute that is right for every reader — a plausible-looking `1`
   * would place every restored target one unit from the eye — and returning a
   * number here would contradict `getPosition()`/`getTarget()`, which are raw,
   * leaving callers no way to tell that the pose is broken. Gesture code inside
   * this package guards with {@link isUsableDistance} instead; each gesture
   * needs a different fallback. Callers OUTSIDE the package cannot use that
   * predicate (it is package-internal) and are not all guarded — see #2466 for
   * the viewpoint-restore path (#2441).
   */
  getDistance(): number {
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    return Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  }

  /**
   * Get current camera rotation angles in degrees
   * Returns { azimuth, elevation } where:
   * - azimuth: horizontal rotation (0-360), 0 = front
   * - elevation: vertical rotation (-90 to 90), 0 = horizon
   */
  getRotation(): { azimuth: number; elevation: number } {
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    const distance = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    // `distance < 1e-6` alone is a magnitude test, not a finiteness one: the
    // comparison is false for NaN, so a malformed pose fell through the guard
    // that looked like it was catching it, and `Math.asin(Math.max(-1,
    // Math.min(1, NaN)))` is NaN — a NaN elevation that leaves the renderer
    // entirely, into the viewer's rotation readout and the measurement
    // handlers (#2441). Same neutral answer as the degenerate pose, which is
    // preserved verbatim.
    if (!isUsableDistance(distance, 1e-6)) return { azimuth: 0, elevation: 0 };

    // Elevation: angle from horizontal plane
    const elevation = Math.asin(Math.max(-1, Math.min(1, dir.y / distance))) * 180 / Math.PI;

    // Calculate azimuth smoothly using up vector
    // The up vector defines the "screen up" direction, which determines rotation
    const upX = this.state.camera.up.x;
    const upY = this.state.camera.up.y;
    const upZ = this.state.camera.up.z;

    // Project up vector onto horizontal plane (XZ plane)
    const upLen = Math.sqrt(upX * upX + upZ * upZ);

    let azimuth: number;
    if (upLen > 0.01) {
      // Use up vector projection for azimuth (smooth and consistent)
      azimuth = (Math.atan2(-upX, -upZ) * 180 / Math.PI + 360) % 360;

      // For bottom view, flip azimuth
      if (elevation < -80 && upY < 0) {
        azimuth = (azimuth + 180) % 360;
      }
    } else {
      // Fallback: use position-based azimuth when up vector is vertical
      azimuth = (Math.atan2(dir.x, dir.z) * 180 / Math.PI + 360) % 360;
    }

    return { azimuth, elevation };
  }

  /**
   * Place the camera at an ABSOLUTE orientation around its current target,
   * in the same angle convention {@link getRotation} reports — the exact
   * inverse of it, so `setRotation(a, e)` then `getRotation()` returns
   * `{ azimuth: a, elevation: e }` (modulo the normalisation and pole clamp
   * below).
   *
   * This is the only absolute-orientation entry point on the camera. Everything
   * else is relative (`orbit`, and the viewer's 90° rotate steppers built on it)
   * or names a direction rather than an angle (`setPresetView`), which is why a
   * host command that says "go to azimuth 120°, elevation 30°" had nothing to
   * call and silently did nothing (#2934).
   *
   * The orbit radius and the target are preserved — this rotates the camera on
   * its current sphere, it does not reframe. `up` is reset to world Y, matching
   * `orbit`, so the reported azimuth comes back through `getRotation`'s
   * position-based branch.
   *
   * @param azimuth Horizontal angle in degrees; normalised into [0, 360).
   * @param elevation Vertical angle in degrees, 0 = horizon. Clamped to just
   *   inside ±90° (the same `MIN_PHI` margin `orbit` uses) — the exact poles
   *   collapse `cross(forward, up)` and flip the model.
   */
  setRotation(azimuth: number, elevation: number): void {
    // Angles are an input class of their own, and both of them reach the
    // trigonometry below unguarded: a non-finite one writes a NaN position and
    // destroys an otherwise valid pose. Same rejection `orbit` applies to its
    // deltas — a rejected call changes nothing at all.
    if (!areFiniteNumbers(azimuth, elevation)) return;

    // An in-flight tween or leftover inertia writes position/target on the next
    // `update()` and would erase this pose a frame later — a host that sends
    // SET_VIEW (animated) and then SET_CAMERA would end up at the preset. An
    // absolute placement supersedes whatever motion is still running, so cancel
    // it; this also drops the preset-view rotation cycle, which is correct
    // after the camera has been reoriented out from under it.
    this.animator.reset();

    const target = this.state.camera.target;
    const dir = {
      x: this.state.camera.position.x - target.x,
      y: this.state.camera.position.y - target.y,
      z: this.state.camera.position.z - target.z,
    };
    const current = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    // A degenerate pose (position === target, or a non-finite one) has no orbit
    // radius to preserve. Any positive radius yields a well-formed view matrix
    // at the requested direction, which is strictly better than propagating the
    // degeneracy — and leaves the caller's angles observable, which is the
    // whole point of the command.
    const distance = isUsableDistance(current, 1e-6) ? current : 1;

    // The TARGET is the other unguarded input, and `isUsableDistance` above only
    // rescues the radius. `setTarget` accepts non-finite coordinates, and every
    // position component below is `target.<axis> + ...`, so one NaN there makes
    // the whole pose NaN -- and this method's contract is that it RECOVERS a
    // pose, so silently writing an unrecoverable one is worse than refusing.
    // Same rejection shape as the angle guard at the top: change nothing.
    if (!areFiniteNumbers(target.x, target.y, target.z)) return;

    const theta = ((((azimuth % 360) + 360) % 360) * Math.PI) / 180;
    const poleMargin = CAMERA_CONSTANTS.MIN_PHI;
    const phi = Math.max(
      poleMargin,
      Math.min(Math.PI - poleMargin, ((90 - elevation) * Math.PI) / 180),
    );
    const sinPhi = Math.sin(phi);

    this.state.camera.position = {
      x: target.x + distance * sinPhi * Math.sin(theta),
      y: target.y + distance * Math.cos(phi),
      z: target.z + distance * sinPhi * Math.cos(theta),
    };
    this.state.camera.up = { x: 0, y: 1, z: 0 };
    this.updateMatrices();
  }

}
