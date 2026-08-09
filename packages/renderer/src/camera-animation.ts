/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera animation system handling tweened transitions and inertia/momentum,
 * plus the thin wrappers that apply a pose picked by `camera-framing.ts`.
 * Extracted from Camera class using composition pattern.
 *
 * The tween's own failure story is the NaN *latch*: `velocity` accumulates in
 * place and the loop spends a channel only while `Math.abs(v) > minVelocity`,
 * which is false for NaN forever, so one non-finite gesture delta kills that
 * channel for the session rather than for a frame (#2441/#2473). Framing's
 * failure story is a different input class entirely and lives in
 * `camera-framing.ts` with the guards that reject it.
 */

import type { Vec3 } from './types.js';
import { areFiniteNumbers, usableOrthoSize } from './camera-guards.js';
import type { CameraInternalState } from './camera-state.js';
import type { CameraControls } from './camera-controls.js';
import type { CameraProjection } from './camera-projection.js';
import {
  frameBoundsTarget,
  framePointTarget,
  presetViewTarget,
  resolvePresetBounds,
  zoomExtentTarget,
  type FramingBounds,
} from './camera-framing.js';

/**
 * Manages camera animations: tweened transitions between positions,
 * inertia/momentum after user interaction, and preset view switching
 * with rotation cycling.
 */
export class CameraAnimator {
  // Inertia system
  private velocity = { orbit: { x: 0, y: 0 }, pan: { x: 0, y: 0 }, zoom: 0 };
  private damping = 0.92; // Inertia factor (0-1), higher = more damping
  private minVelocity = 0.001; // Minimum velocity threshold

  // Animation system
  private animationStartTime = 0;
  private animationDuration = 0;
  private animationStartPos: Vec3 | null = null;
  private animationStartTarget: Vec3 | null = null;
  private animationEndPos: Vec3 | null = null;
  private animationEndTarget: Vec3 | null = null;
  private animationStartUp: Vec3 | null = null;
  private animationEndUp: Vec3 | null = null;
  private animationStartOrthoSize: number | null = null;
  private animationEndOrthoSize: number | null = null;
  private animationEasing: ((t: number) => number) | null = null;

  // Track preset view for rotation cycling (clicking same view rotates 90 degrees)
  private lastPresetView: string | null = null;
  private presetViewRotation = 0; // 0, 1, 2, 3 = 0, 90, 180, 270 degrees

  constructor(
    private readonly state: CameraInternalState,
    private readonly updateMatrices: () => void,
    private readonly controls: CameraControls,
    private readonly projection: CameraProjection,
  ) {}

  // --- Velocity management (called by Camera class) ---

  // Every one of these accumulates **in place**, and the inertia loop spends a
  // velocity only while `Math.abs(v) > minVelocity` — false for NaN. So a
  // single non-finite gesture argument does not cost one frame of inertia: it
  // latches the channel dead for the rest of the session, and the value never
  // decays back under the threshold either. That is the same latch
  // `moveFirstPerson`'s `walkVelocity` had (#2441), reached from the argument
  // side rather than the pose side (#2473). Skip the contribution instead;
  // the gesture itself has already been rejected by the same test downstream.

  addOrbitVelocity(deltaX: number, deltaY: number): void {
    if (!areFiniteNumbers(deltaX, deltaY)) return;
    this.velocity.orbit.x += deltaX * 0.001;
    this.velocity.orbit.y += deltaY * 0.001;
  }

  addPanVelocity(deltaX: number, deltaY: number, panSpeed: number): void {
    if (!areFiniteNumbers(deltaX, deltaY, panSpeed)) return;
    this.velocity.pan.x += deltaX * panSpeed * 0.1;
    this.velocity.pan.y += deltaY * panSpeed * 0.1;
  }

  addZoomVelocity(normalizedDelta: number): void {
    if (!Number.isFinite(normalizedDelta)) return;
    this.velocity.zoom += normalizedDelta * 0.1;
  }

  /**
   * Reset preset view tracking (called when user orbits)
   */
  resetPresetTracking(): void {
    this.lastPresetView = null;
    this.presetViewRotation = 0;
  }

  /**
   * Update camera animation and inertia
   * Returns true if camera is still animating
   */
  update(_deltaTime: number): boolean {
    // deltaTime reserved for future physics-based animation smoothing
    void _deltaTime;
    let isAnimating = false;

    // Handle animation
    if (this.animationStartTime > 0 && this.animationDuration > 0) {
      const elapsed = Date.now() - this.animationStartTime;
      const progress = Math.min(elapsed / this.animationDuration, 1);

      if (progress < 1 && this.animationStartPos && this.animationEndPos &&
        this.animationStartTarget && this.animationEndTarget && this.animationEasing) {
        const t = this.animationEasing(progress);
        this.state.camera.position.x = this.animationStartPos.x + (this.animationEndPos.x - this.animationStartPos.x) * t;
        this.state.camera.position.y = this.animationStartPos.y + (this.animationEndPos.y - this.animationStartPos.y) * t;
        this.state.camera.position.z = this.animationStartPos.z + (this.animationEndPos.z - this.animationStartPos.z) * t;
        this.state.camera.target.x = this.animationStartTarget.x + (this.animationEndTarget.x - this.animationStartTarget.x) * t;
        this.state.camera.target.y = this.animationStartTarget.y + (this.animationEndTarget.y - this.animationStartTarget.y) * t;
        this.state.camera.target.z = this.animationStartTarget.z + (this.animationEndTarget.z - this.animationStartTarget.z) * t;

        // Interpolate orthoSize if animating orthographic zoom.
        // The animator is the second writer that bypasses `Camera.setOrthoSize`
        // (#2461): the read-site backstop in `updateCameraMatrices` keeps the
        // projection matrix finite but not the state, and `getOrthoSize()`
        // reads the state — which is what a saved viewpoint persists. Keep the
        // previous half-height when the interpolation yields nothing usable.
        if (this.animationStartOrthoSize !== null && this.animationEndOrthoSize !== null) {
          const next = usableOrthoSize(
            this.animationStartOrthoSize + (this.animationEndOrthoSize - this.animationStartOrthoSize) * t,
          );
          if (next !== null) this.state.orthoSize = next;
        }

        // Interpolate up vector if animating with up
        if (this.animationStartUp && this.animationEndUp) {
          // SLERP-like interpolation for up vector (normalized lerp)
          const upX = this.animationStartUp.x + (this.animationEndUp.x - this.animationStartUp.x) * t;
          const upY = this.animationStartUp.y + (this.animationEndUp.y - this.animationStartUp.y) * t;
          const upZ = this.animationStartUp.z + (this.animationEndUp.z - this.animationStartUp.z) * t;
          // Normalize
          const len = Math.sqrt(upX * upX + upY * upY + upZ * upZ);
          if (len > 0.0001) {
            this.state.camera.up.x = upX / len;
            this.state.camera.up.y = upY / len;
            this.state.camera.up.z = upZ / len;
          }
        }

        this.updateMatrices();
        isAnimating = true;
      } else {
        // Animation complete - set final values
        if (this.animationEndPos) {
          this.state.camera.position.x = this.animationEndPos.x;
          this.state.camera.position.y = this.animationEndPos.y;
          this.state.camera.position.z = this.animationEndPos.z;
        }
        if (this.animationEndTarget) {
          this.state.camera.target.x = this.animationEndTarget.x;
          this.state.camera.target.y = this.animationEndTarget.y;
          this.state.camera.target.z = this.animationEndTarget.z;
        }
        if (this.animationEndUp) {
          this.state.camera.up.x = this.animationEndUp.x;
          this.state.camera.up.y = this.animationEndUp.y;
          this.state.camera.up.z = this.animationEndUp.z;
        }
        if (this.animationEndOrthoSize !== null) {
          const next = usableOrthoSize(this.animationEndOrthoSize);
          if (next !== null) this.state.orthoSize = next;
        }
        this.updateMatrices();

        this.animationStartTime = 0;
        this.animationDuration = 0;
        this.animationStartPos = null;
        this.animationEndPos = null;
        this.animationStartTarget = null;
        this.animationEndTarget = null;
        this.animationStartUp = null;
        this.animationEndUp = null;
        this.animationStartOrthoSize = null;
        this.animationEndOrthoSize = null;
        this.animationEasing = null;
      }
    }

    // Apply inertia
    if (Math.abs(this.velocity.orbit.x) > this.minVelocity || Math.abs(this.velocity.orbit.y) > this.minVelocity) {
      this.resetPresetTracking();
      this.controls.orbit(this.velocity.orbit.x * 100, this.velocity.orbit.y * 100);
      this.velocity.orbit.x *= this.damping;
      this.velocity.orbit.y *= this.damping;
      isAnimating = true;
    }

    if (Math.abs(this.velocity.pan.x) > this.minVelocity || Math.abs(this.velocity.pan.y) > this.minVelocity) {
      this.controls.pan(this.velocity.pan.x * 1000, this.velocity.pan.y * 1000);
      this.velocity.pan.x *= this.damping;
      this.velocity.pan.y *= this.damping;
      isAnimating = true;
    }

    if (Math.abs(this.velocity.zoom) > this.minVelocity) {
      this.controls.zoom(this.velocity.zoom * 1000);
      this.velocity.zoom *= this.damping;
      isAnimating = true;
    }

    return isAnimating;
  }

  // --- Framing (pose picked in `camera-framing.ts`, applied by the tween) ---
  //
  // These wrappers exist on the animator because they must return the tween's
  // promise, and the promise machinery *is* tween state. They null-check the
  // picked target and do nothing else — in particular they do NOT re-validate
  // the input. Each framing input is guarded exactly once, in the pure module;
  // a second copy here would leave neither copy load-bearing, so a reverted
  // guard would still look green.

  /**
   * Frame/center view on a point (keeps current distance and direction)
   * Standard CAD "Frame Selection" behavior
   */
  async framePoint(point: Vec3, duration = 300): Promise<void> {
    const fit = framePointTarget(this.state, point);
    if (!fit) return;
    return this.animateTo(fit.position, fit.target, duration, fit.orthoSize);
  }

  /**
   * Frame selection - zoom to fit bounds while keeping current view direction
   * This is what "Frame Selection" should do - zoom to fill screen
   */
  async frameBounds(min: Vec3, max: Vec3, duration = 300): Promise<void> {
    const fit = frameBoundsTarget(this.state, min, max);
    if (!fit) return;
    return this.animateTo(fit.position, fit.target, duration, fit.orthoSize);
  }

  async zoomExtent(min: Vec3, max: Vec3, duration = 300): Promise<void> {
    const fit = zoomExtentTarget(this.state, min, max);
    if (!fit) return;
    // Update near/far planes dynamically
    this.projection.updateNearFarPlanes(fit.fitDistance);
    return this.animateTo(fit.position, fit.target, duration, fit.orthoSize);
  }

  /**
   * Set preset view with explicit bounds (Y-up coordinate system)
   * Clicking the same view again rotates 90 degrees around the view axis
   * @param buildingRotation Optional building rotation in radians (from IfcSite placement)
   */
  setPresetView(
    view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right',
    bounds?: FramingBounds,
    buildingRotation?: number
  ): void {
    // Resolved and validated before the rotation cycles, so a rejected preset
    // leaves the ViewCube's cycle position where it was.
    const useBounds = resolvePresetBounds(this.state, bounds);
    if (!useBounds) return;

    // Check if clicking the same view again - cycle rotation
    if (this.lastPresetView === view) {
      this.presetViewRotation = (this.presetViewRotation + 1) % 4;
    } else {
      this.lastPresetView = view;
      this.presetViewRotation = 0;
    }

    const fit = presetViewTarget(this.state, view, useBounds, this.presetViewRotation, buildingRotation);
    this.animateToWithUp(fit.position, fit.target, fit.up, 300);
  }

  /**
   * Animate camera to position and target
   */
  async animateTo(endPos: Vec3, endTarget: Vec3, duration = 500, endOrthoSize?: number): Promise<void> {
    this.animationStartPos = { ...this.state.camera.position };
    this.animationStartTarget = { ...this.state.camera.target };
    this.animationEndPos = endPos;
    this.animationEndTarget = endTarget;
    this.animationStartUp = null;
    this.animationEndUp = null;
    if (endOrthoSize !== undefined) {
      this.animationStartOrthoSize = this.state.orthoSize;
      this.animationEndOrthoSize = endOrthoSize;
    } else {
      this.animationStartOrthoSize = null;
      this.animationEndOrthoSize = null;
    }
    this.animationDuration = duration;
    this.animationStartTime = Date.now();
    this.animationEasing = this.easeOutCubic;

    // Wait for animation to complete
    return new Promise((resolve) => {
      const checkAnimation = () => {
        if (this.animationStartTime === 0) {
          resolve();
        } else {
          requestAnimationFrame(checkAnimation);
        }
      };
      checkAnimation();
    });
  }

  /**
   * Animate camera to position, target, and up vector (for orthogonal preset views)
   */
  async animateToWithUp(endPos: Vec3, endTarget: Vec3, endUp: Vec3, duration = 500): Promise<void> {
    // Clear all velocities to prevent inertia from interfering with animation
    this.velocity.orbit.x = 0;
    this.velocity.orbit.y = 0;
    this.velocity.pan.x = 0;
    this.velocity.pan.y = 0;
    this.velocity.zoom = 0;

    this.animationStartPos = { ...this.state.camera.position };
    this.animationStartTarget = { ...this.state.camera.target };
    this.animationStartUp = { ...this.state.camera.up };
    this.animationEndPos = endPos;
    this.animationEndTarget = endTarget;
    this.animationEndUp = endUp;
    this.animationStartOrthoSize = null;
    this.animationEndOrthoSize = null;
    this.animationDuration = duration;
    this.animationStartTime = Date.now();
    this.animationEasing = this.easeOutCubic;

    // Wait for animation to complete
    return new Promise((resolve) => {
      const checkAnimation = () => {
        if (this.animationStartTime === 0) {
          resolve();
        } else {
          requestAnimationFrame(checkAnimation);
        }
      };
      checkAnimation();
    });
  }

  /**
   * Easing function: easeOutCubic
   */
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Reset velocity (stop inertia)
   */
  stopInertia(): void {
    this.velocity.orbit.x = 0;
    this.velocity.orbit.y = 0;
    this.velocity.pan.x = 0;
    this.velocity.pan.y = 0;
    this.velocity.zoom = 0;
  }

  /**
   * Reset camera animation state (clear inertia, cancel animations, reset preset tracking)
   * Called when loading a new model to ensure clean state
   */
  reset(): void {
    this.stopInertia();
    // Cancel any ongoing animations
    this.animationStartTime = 0;
    this.animationDuration = 0;
    this.animationStartPos = null;
    this.animationStartTarget = null;
    this.animationEndPos = null;
    this.animationEndTarget = null;
    this.animationStartUp = null;
    this.animationEndUp = null;
    this.animationStartOrthoSize = null;
    this.animationEndOrthoSize = null;
    this.animationEasing = null;
    // Reset preset view tracking
    this.lastPresetView = null;
    this.presetViewRotation = 0;
  }
}
