/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera animation system handling tweened transitions, inertia/momentum,
 * preset views, and first-person mode.
 * Extracted from Camera class using composition pattern.
 */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-controls.js';
import type { CameraControls } from './camera-controls.js';
import type { CameraProjection } from './camera-projection.js';

/**
 * Manages camera animations: tweened transitions between positions,
 * inertia/momentum after user interaction, preset view switching
 * with rotation cycling, and first-person movement.
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

  // First-person mode
  private isFirstPersonMode = false;
  private walkVelocity = { x: 0, z: 0 };

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

  addOrbitVelocity(deltaX: number, deltaY: number): void {
    this.velocity.orbit.x += deltaX * 0.001;
    this.velocity.orbit.y += deltaY * 0.001;
  }

  addPanVelocity(deltaX: number, deltaY: number, panSpeed: number): void {
    this.velocity.pan.x += deltaX * panSpeed * 0.1;
    this.velocity.pan.y += deltaY * panSpeed * 0.1;
  }

  addZoomVelocity(normalizedDelta: number): void {
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

        // Interpolate orthoSize if animating orthographic zoom
        if (this.animationStartOrthoSize !== null && this.animationEndOrthoSize !== null) {
          this.state.orthoSize = this.animationStartOrthoSize + (this.animationEndOrthoSize - this.animationStartOrthoSize) * t;
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
          this.state.orthoSize = this.animationEndOrthoSize;
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

  /**
   * Animate camera to fit bounds (southeast isometric view)
   * Y-up coordinate system
   */
  async zoomToFit(min: Vec3, max: Vec3, duration = 500): Promise<void> {
    const center = {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    };
    const size = {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    };
    const maxSize = Math.max(size.x, size.y, size.z);
    const distance = maxSize * 2.0;

    const endTarget = center;
    // Southeast isometric view for Y-up (same as fitToBounds)
    const endPos = {
      x: center.x + distance * 0.6,
      y: center.y + distance * 0.5,
      z: center.z + distance * 0.6,
    };

    // Calculate orthoSize for orthographic mode so zoom level resets properly
    const aspect = this.state.camera.aspect || 1;
    const endOrthoSize = this.state.projectionMode === 'orthographic'
      ? Math.max(0.01, maxSize / 2, maxSize / 2 / aspect) * 1.5
      : undefined;

    return this.animateTo(endPos, endTarget, duration, endOrthoSize);
  }

  /**
   * Frame/center view on a point (keeps current distance and direction)
   * Standard CAD "Frame Selection" behavior
   */
  async framePoint(point: Vec3, duration = 300): Promise<void> {
    // Keep current viewing direction and distance
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };

    // New position: point + current offset
    const endPos = {
      x: point.x + dir.x,
      y: point.y + dir.y,
      z: point.z + dir.z,
    };

    return this.animateTo(endPos, point, duration);
  }

  /**
   * Frame selection - zoom to fit bounds while keeping current view direction
   * This is what "Frame Selection" should do - zoom to fill screen
   */
  async frameBounds(min: Vec3, max: Vec3, duration = 300): Promise<void> {
    const center = {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    };
    const size = {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    };
    const maxSize = Math.max(size.x, size.y, size.z);

    if (maxSize < 1e-6) {
      // Very small or zero size - just center on it
      return this.framePoint(center, duration);
    }

    // Calculate required distance based on FOV to fit bounds
    const fovFactor = Math.tan(this.state.camera.fov / 2);
    const distance = (maxSize / 2) / fovFactor * 1.2; // 1.2x padding for nice framing

    // Get current viewing direction from view matrix (more reliable than position-target)
    // View matrix forward is -Z axis in view space
    const viewMatrix = this.state.viewMatrix.m;
    // Extract forward direction from view matrix (negative Z column, normalized)
    let dir = {
      x: -viewMatrix[8],   // -m[2][0] (forward X)
      y: -viewMatrix[9],   // -m[2][1] (forward Y)
      z: -viewMatrix[10],  // -m[2][2] (forward Z)
    };
    const dirLen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);

    // Normalize direction
    if (dirLen > 1e-6) {
      dir.x /= dirLen;
      dir.y /= dirLen;
      dir.z /= dirLen;
    } else {
      // Fallback: use position-target if view matrix is invalid
      dir = {
        x: this.state.camera.position.x - this.state.camera.target.x,
        y: this.state.camera.position.y - this.state.camera.target.y,
        z: this.state.camera.position.z - this.state.camera.target.z,
      };
      const fallbackLen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
      if (fallbackLen > 1e-6) {
        dir.x /= fallbackLen;
        dir.y /= fallbackLen;
        dir.z /= fallbackLen;
      } else {
        // Last resort: southeast isometric
        dir.x = 0.6;
        dir.y = 0.5;
        dir.z = 0.6;
        const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
        dir.x /= len;
        dir.y /= len;
        dir.z /= len;
      }
    }

    // New position: center + direction * distance
    const endPos = {
      x: center.x + dir.x * distance,
      y: center.y + dir.y * distance,
      z: center.z + dir.z * distance,
    };

    // Calculate orthoSize for orthographic mode so zoom level resets properly
    const aspect = this.state.camera.aspect || 1;
    const endOrthoSize = this.state.projectionMode === 'orthographic'
      ? Math.max(0.01, maxSize / 2, maxSize / 2 / aspect) * 1.2
      : undefined;

    return this.animateTo(endPos, center, duration, endOrthoSize);
  }

  async zoomExtent(min: Vec3, max: Vec3, duration = 300): Promise<void> {
    const center = {
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    };
    const size = {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    };
    const maxSize = Math.max(size.x, size.y, size.z);

    // Calculate required distance based on FOV
    const fovFactor = Math.tan(this.state.camera.fov / 2);
    const distance = (maxSize / 2) / fovFactor * 1.5; // 1.5x for padding

    // Update near/far planes dynamically
    this.projection.updateNearFarPlanes(distance);

    // Keep current viewing direction
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    const currentDistance = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);

    // Normalize direction
    if (currentDistance > 1e-10) {
      dir.x /= currentDistance;
      dir.y /= currentDistance;
      dir.z /= currentDistance;
    } else {
      // Fallback direction
      dir.x = 0.6;
      dir.y = 0.5;
      dir.z = 0.6;
      const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
      dir.x /= len;
      dir.y /= len;
      dir.z /= len;
    }

    // New position: center + direction * distance
    const endPos = {
      x: center.x + dir.x * distance,
      y: center.y + dir.y * distance,
      z: center.z + dir.z * distance,
    };

    // Calculate orthoSize for orthographic mode so zoom level resets properly
    const aspect = this.state.camera.aspect || 1;
    const endOrthoSize = this.state.projectionMode === 'orthographic'
      ? Math.max(0.01, maxSize / 2, maxSize / 2 / aspect) * 1.5
      : undefined;

    return this.animateTo(endPos, center, duration, endOrthoSize);
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
   * Set first-person mode
   */
  enableFirstPersonMode(enabled: boolean): void {
    this.isFirstPersonMode = enabled;
  }

  /**
   * Walk on the horizontal XZ plane (Y-up coordinate system).
   * Forward/backward moves in the camera's horizontal facing direction.
   * Left/right strafes perpendicular. Y position stays fixed (walking on ground).
   * Speed scales with scene size. Movement uses smooth acceleration to avoid
   * abrupt jumps — velocity ramps up over successive frames.
   */
  moveFirstPerson(forward: number, right: number, _up: number): void {
    // Camera forward direction projected onto XZ plane
    const dir = {
      x: this.state.camera.target.x - this.state.camera.position.x,
      z: this.state.camera.target.z - this.state.camera.position.z,
    };
    const horizLen = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
    if (horizLen < 1e-10) return;

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

  /**
   * Set preset view with explicit bounds (Y-up coordinate system)
   * Clicking the same view again rotates 90 degrees around the view axis
   * @param buildingRotation Optional building rotation in radians (from IfcSite placement)
   */
  setPresetView(
    view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right',
    bounds?: { min: Vec3; max: Vec3 },
    buildingRotation?: number
  ): void {
    const useBounds = bounds || this.getCurrentBounds();
    if (!useBounds) {
      console.warn('[Camera] No bounds available for setPresetView');
      return;
    }

    // Check if clicking the same view again - cycle rotation
    if (this.lastPresetView === view) {
      this.presetViewRotation = (this.presetViewRotation + 1) % 4;
    } else {
      this.lastPresetView = view;
      this.presetViewRotation = 0;
    }

    const center = {
      x: (useBounds.min.x + useBounds.max.x) / 2,
      y: (useBounds.min.y + useBounds.max.y) / 2,
      z: (useBounds.min.z + useBounds.max.z) / 2,
    };
    const size = {
      x: useBounds.max.x - useBounds.min.x,
      y: useBounds.max.y - useBounds.min.y,
      z: useBounds.max.z - useBounds.min.z,
    };
    const maxSize = Math.max(size.x, size.y, size.z);

    // Calculate distance based on FOV for proper fit
    const fovFactor = Math.tan(this.state.camera.fov / 2);
    const distance = (maxSize / 2) / fovFactor * 1.5; // 1.5x for padding

    let endPos: Vec3;
    const endTarget = center;

    // WebGL uses Y-up coordinate system internally
    // We set both position AND up vector for proper orthogonal views
    let upVector: Vec3 = { x: 0, y: 1, z: 0 }; // Default Y-up

    // Up vector rotation options for top/bottom views (rotate around Y axis)
    // 0: -Z, 1: -X, 2: +Z, 3: +X
    const topUpVectors: Vec3[] = [
      { x: 0, y: 0, z: -1 },  // 0 degrees - North up
      { x: -1, y: 0, z: 0 },  // 90 degrees - West up
      { x: 0, y: 0, z: 1 },   // 180 degrees - South up
      { x: 1, y: 0, z: 0 },   // 270 degrees - East up
    ];
    const bottomUpVectors: Vec3[] = [
      { x: 0, y: 0, z: 1 },   // 0 degrees - South up
      { x: 1, y: 0, z: 0 },   // 90 degrees - East up
      { x: 0, y: 0, z: -1 },  // 180 degrees - North up
      { x: -1, y: 0, z: 0 },  // 270 degrees - West up
    ];

    // Apply building rotation if present (rotate around Y axis)
    const cosR = buildingRotation !== undefined && buildingRotation !== 0 ? Math.cos(buildingRotation) : 1.0;
    const sinR = buildingRotation !== undefined && buildingRotation !== 0 ? Math.sin(buildingRotation) : 0.0;

    switch (view) {
      case 'top': {
        // Top view: position camera *just barely* off the +Y pole so the
        // subsequent orbit math has a well-defined polar tangent (no pole
        // singularity). camera.up stays world Y throughout — screen-up is
        // then determined by lookAt projecting (0,1,0) onto perp(look),
        // which falls along the horizontal component of `-look`.
        //
        // The 4 rotation cycles select which compass direction appears at
        // the top of the screen by varying the small horizontal offset
        // (theta in the spherical math).
        //   rotation 0 → camera slightly to +Z of center → screen-up = +Z
        //   rotation 1 → camera slightly to +X → screen-up = +X
        //   rotation 2 → camera slightly to -Z → screen-up = -Z
        //   rotation 3 → camera slightly to -X → screen-up = -X
        // Building rotation is applied as the same Y-axis rotation that
        // setPresetView would have used to remap the legacy up vector.
        const poleOffset = Math.sin(0.01) * distance; // ~0.6° tilt
        const verticalOffset = Math.cos(0.01) * distance;
        const thetaPerRotation = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
        const thetaWorld = thetaPerRotation[this.presetViewRotation] + (buildingRotation ?? 0);
        endPos = {
          x: center.x + poleOffset * Math.sin(thetaWorld),
          y: center.y + verticalOffset,
          z: center.z + poleOffset * Math.cos(thetaWorld),
        };
        upVector = { x: 0, y: 1, z: 0 };
        break;
      }
      case 'bottom': {
        // Bottom view: mirror of top — phi = π − MIN_PHI.
        const poleOffset = Math.sin(0.01) * distance;
        const verticalOffset = Math.cos(0.01) * distance;
        const thetaPerRotation = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];
        const thetaWorld = thetaPerRotation[this.presetViewRotation] + (buildingRotation ?? 0);
        endPos = {
          x: center.x + poleOffset * Math.sin(thetaWorld),
          y: center.y - verticalOffset,
          z: center.z + poleOffset * Math.cos(thetaWorld),
        };
        upVector = { x: 0, y: 1, z: 0 };
        break;
      }
      case 'front':
        // Front view: from +Z looking at model
        // Rotate camera position around Y axis by building rotation
        // Standard rotation: x' = x*cos - z*sin, z' = x*sin + z*cos
        // For +Z direction (0,0,1): x' = -sin, z' = cos
        // But we need to look at building's front, so use negative rotation
        endPos = {
          x: center.x + sinR * distance,
          y: center.y,
          z: center.z + cosR * distance,
        };
        upVector = { x: 0, y: 1, z: 0 }; // Y-up
        break;
      case 'back':
        // Back view: from -Z looking at model
        // For -Z direction (0,0,-1) rotated: x' = sin, z' = -cos
        endPos = {
          x: center.x - sinR * distance,
          y: center.y,
          z: center.z - cosR * distance,
        };
        upVector = { x: 0, y: 1, z: 0 }; // Y-up
        break;
      case 'left':
        // Left view: from -X looking at model
        // For -X direction (-1,0,0) rotated: x' = -cos, z' = sin
        endPos = {
          x: center.x - cosR * distance,
          y: center.y,
          z: center.z + sinR * distance,
        };
        upVector = { x: 0, y: 1, z: 0 }; // Y-up
        break;
      case 'right':
        // Right view: from +X looking at model
        // For +X direction (1,0,0) rotated: x' = cos, z' = -sin
        endPos = {
          x: center.x + cosR * distance,
          y: center.y,
          z: center.z - sinR * distance,
        };
        upVector = { x: 0, y: 1, z: 0 }; // Y-up
        break;
    }

    this.animateToWithUp(endPos, endTarget, upVector, 300);
  }

  /**
   * Get current bounds estimate (simplified - in production would use scene bounds)
   */
  private getCurrentBounds(): { min: Vec3; max: Vec3 } | null {
    // Estimate bounds from camera distance
    const dir = {
      x: this.state.camera.position.x - this.state.camera.target.x,
      y: this.state.camera.position.y - this.state.camera.target.y,
      z: this.state.camera.position.z - this.state.camera.target.z,
    };
    const distance = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    const size = distance / 2;

    return {
      min: {
        x: this.state.camera.target.x - size,
        y: this.state.camera.target.y - size,
        z: this.state.camera.target.z - size,
      },
      max: {
        x: this.state.camera.target.x + size,
        y: this.state.camera.target.y + size,
        z: this.state.camera.target.z + size,
      },
    };
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
