/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * First-person (walk mode) navigation.
 *
 * An island: it shares the camera state object with the rest of the family and
 * nothing else. It reads no tween field and writes none, and the animator
 * never consulted `walkVelocity` — which is why the velocity lives here now,
 * next to the only code that spends it.
 */

import type { CameraInternalState } from './camera-state.js';
import { areFiniteNumbers, isUsableDistance } from './camera-guards.js';

export class FirstPersonNavigator {
  private isFirstPersonMode = false;
  private walkVelocity = { x: 0, z: 0 };

  constructor(
    private readonly state: CameraInternalState,
    private readonly updateMatrices: () => void,
  ) {}

  /**
   * Set first-person mode.
   *
   * Load-bearing, not bookkeeping: {@link move} refuses to walk while this is
   * off. The flag was write-only before the extraction — nothing ever read it,
   * so `moveFirstPerson` moved the camera whether or not walk mode had been
   * entered, and the only thing keeping that from being visible was the
   * viewer's *second*, independent check on `activeTool === 'walk'`. Two
   * unrelated gates for one decision means neither is load-bearing on its own,
   * and the renderer is published: an embedder driving `moveFirstPerson` from
   * its own key handler has only this one.
   *
   * Disabling also drops the accumulated walk velocity. It is smoothed in
   * place (`+= (target - current) * 0.15`), so a leftover would be spent on
   * the first frame after walk mode is re-entered — a visible lurch in
   * whatever direction the user happened to be walking when they left.
   */
  setEnabled(enabled: boolean): void {
    this.isFirstPersonMode = enabled;
    if (!enabled) this.stop();
  }

  /**
   * Drop the accumulated walk velocity, keeping the mode as it is.
   *
   * Called on model reset. The mode itself is deliberately *not* cleared:
   * it mirrors the viewer's active tool, which a model load does not change,
   * and clearing it here would leave walk mode silently dead until the user
   * toggled the tool off and back on again.
   */
  stop(): void {
    this.walkVelocity.x = 0;
    this.walkVelocity.z = 0;
  }

  /**
   * Walk on the horizontal XZ plane (Y-up coordinate system).
   * Forward/backward moves in the camera's horizontal facing direction.
   * Left/right strafes perpendicular. Y position stays fixed (walking on ground).
   * Speed scales with scene size. Movement uses smooth acceleration to avoid
   * abrupt jumps — velocity ramps up over successive frames.
   */
  move(forward: number, right: number, _up: number): void {
    // Mode gate, ahead of every other guard: walking is only a thing that
    // exists while walk mode is on. See {@link setEnabled}.
    if (!this.isFirstPersonMode) return;

    // Argument-side guard (#2473). `walkVelocity` is accumulated in place, so
    // a non-finite axis latches first-person movement dead for the session
    // exactly the way a non-finite pose did (#2441) — and it does not need an
    // exotic value: both `moveFirstPerson(NaN, 0, 0)` and
    // `moveFirstPerson(Infinity, 0, 0)` came back with a non-finite position
    // on a finite pose. `_up` is unused, so it is deliberately not tested.
    if (!areFiniteNumbers(forward, right)) return;

    // Camera forward direction projected onto XZ plane
    const dir = {
      x: this.state.camera.target.x - this.state.camera.position.x,
      z: this.state.camera.target.z - this.state.camera.position.z,
    };
    const horizLen = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    // Finiteness, not just magnitude: `NaN < 1e-10` is false, so a malformed
    // pose fell through here and `dir.x / horizLen` came back NaN. That does
    // not merely produce one bad step — `walkVelocity` is accumulated in place
    // (`+= (target - current) * 0.15`), so a single NaN frame latches it and
    // first-person movement stays dead for the rest of the session even after
    // the pose is corrected (#2441).
    if (!isUsableDistance(horizLen, 1e-10)) return;

    // Normalized horizontal forward and right vectors
    const fwdX = dir.x / horizLen;
    const fwdZ = dir.z / horizLen;
    const rightX = -fwdZ;
    const rightZ = fwdX;

    // Target velocity from input (forward/right can be -2..2 with sprint)
    const targetVelX = fwdX * forward + rightX * right;
    const targetVelZ = fwdZ * forward + rightZ * right;

    // Smooth acceleration: lerp current walk velocity toward target
    this.walkVelocity.x += (targetVelX - this.walkVelocity.x) * 0.15;
    this.walkVelocity.z += (targetVelZ - this.walkVelocity.z) * 0.15;

    // Speed proportional to scene size (use camera-target distance as proxy)
    const camDir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    const distance = Math.sqrt(camDir.x * camDir.x + camDir.y * camDir.y + camDir.z * camDir.z);
    // The horizontal guard above does not cover this one: `camDir` includes Y,
    // so a pose whose *only* bad coordinate is vertical reaches here with a
    // finite `horizLen` and a NaN `distance`. `Math.max` is NaN-transparent —
    // `Math.max(0.02, NaN)` is `NaN`, not the floor — so the clamp would
    // forward it into the offsets written back to position and target.
    if (!isUsableDistance(distance, 0)) return;
    const speed = Math.max(0.02, distance * 0.004);

    // Apply smoothed velocity
    const offsetX = this.walkVelocity.x * speed;
    const offsetZ = this.walkVelocity.z * speed;

    // Move both position and target by the same offset (preserves view direction)
    this.state.camera.position.x += offsetX;
    this.state.camera.position.z += offsetZ;
    this.state.camera.target.x += offsetX;
    this.state.camera.target.z += offsetZ;

    this.updateMatrices();
  }
}
