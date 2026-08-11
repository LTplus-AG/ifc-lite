/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Project the hero's BCF pin into its host element's pixel space — the body
 * behind `SceneHandle.projectPin()`.
 *
 * It lives outside `hero-scene.ts` for the reason `release-renderer.ts` does:
 * `createScene` needs a WebGL context and so never executes in CI (happy-dom
 * refuses one), while this is pure maths over a camera and a point and runs
 * anywhere. That seam is what makes #2453 testable at all.
 *
 * `visible` used to be a DEPTH test only (`z >= -1 && z <= 1`). After
 * `.project()` all three components are NDC, so a pin that had orbited out of
 * frame sideways still reported `visible: true` and `McpLanding`'s
 * `HeroOverlay` went on rendering the `BCF #04` caption at `pinFrame.x + 22` —
 * outside a stage that is `overflow-hidden`, so the caption was clipped away
 * while the code believed it was showing it. Sweeping the real constants (pin
 * at (2.6, 1.9, 2.601), orbit target (0, 3, 0), `PerspectiveCamera(35, 4/5)`)
 * over a full revolution, the BCF-pin step spends 178 of 720 sampled azimuths
 * in that state and peaks at |ndc.x| = 1.087. The portrait `aspect-[4/5]`
 * stage is what makes it lateral: it narrows the horizontal FOV to about 28°
 * against the 35° vertical, so |ndc.y| never exceeds 0.59 on any hero camera.
 */

import type * as THREE from 'three';
import { Vector3 } from 'three';

export interface PinFrame {
  /** Pixels from the host element's left edge. */
  x: number;
  /** Pixels from the host element's top edge. */
  y: number;
  /** Whether the pin is inside the camera frustum — see `projectPinFrame`. */
  visible: boolean;
}

/** Re-usable scratch vector: this runs once per animation frame. */
const scratch = new Vector3();

/**
 * Project `pin` through `camera` into `width` x `height` pixel space.
 *
 * Returns `null` only when the host has no size yet, so there is no coordinate
 * space to project into (#2446). Out-of-frame is reported through `visible`,
 * never by returning `null`.
 *
 * `visible` means "the pin is inside the view frustum": all three NDC
 * components within [-1, 1], bounds included. It is deliberately a statement
 * about the PIN and not about any overlay anchored to it — the caption's own
 * offset and width are the overlay's layout problem, and folding a pixel
 * margin in here would make `visible: false` mean two different things. The
 * bounds are inclusive because the pin is a world-space sprite with extent: at
 * exactly |ndc| == 1 its centre is on the edge and half of it is still drawn,
 * so excluding the boundary would hide the caption of a pin the viewer can
 * see. `x` and `y` are still filled in when `visible` is false, and are
 * meaningless — read `visible` first.
 */
export function projectPinFrame(
  pin: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
): PinFrame | null {
  if (width === 0 || height === 0) return null;
  scratch.copy(pin).project(camera);
  const visible = scratch.z >= -1 && scratch.z <= 1
    && scratch.x >= -1 && scratch.x <= 1
    && scratch.y >= -1 && scratch.y <= 1;
  return {
    x: ((scratch.x + 1) / 2) * width,
    y: ((-scratch.y + 1) / 2) * height,
    visible,
  };
}
