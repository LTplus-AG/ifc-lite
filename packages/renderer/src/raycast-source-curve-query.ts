/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Camera, visibility and culling policy for opt-in authored source snaps. */
import type { Camera } from './camera.js';
import { createProjectableLineInterval } from './camera-projection.js';
import { isEntityVisible } from './entity-visibility.js';
import type { Ray } from './raycaster.js';
import type { SnapOptions, SnapTarget } from './snap-detector.js';
import { preferredSourceCurveSnap, sourceCurveMayReachRay, type SourceSnapCurve } from './source-curve-snap.js';
import type { PickClipState, PickOptions } from './types.js';

export function querySourceCurves(
    curves: readonly SourceSnapCurve[], meshSnap: SnapTarget | null,
    camera: Camera, ray: Ray, x: number, y: number,
    viewport: { width: number; height: number },
    options?: PickOptions & { snapOptions?: Partial<SnapOptions> },
    clip?: PickClipState | null,
): SnapTarget | null {
    if (curves.length === 0) return null;
    const radius = options?.snapOptions?.screenSnapRadius ?? 20;
    const cameraLineInterval = createProjectableLineInterval(camera.getRelativeToEyeFrame());
    const orthoHalfHeight = camera.getProjectionMode() === 'orthographic' ? camera.getOrthoSize() : null;
    const fov = camera.getFOV();
    // Evaluate exact f64 source curves; display chords only guide drawing.
    return preferredSourceCurveSnap(
        curves, meshSnap, x, y, radius,
        point => camera.projectToScreen(point, viewport.width, viewport.height),
        curve => isEntityVisible(curve.globalId, options?.hiddenIds, options?.isolatedIds),
        clip, options?.snapOptions,
        curve => sourceCurveMayReachRay(curve, ray, radius, fov, viewport.height, orthoHalfHeight),
        cameraLineInterval,
    );
}
