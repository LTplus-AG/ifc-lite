/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The point-cloud step of `RaycastEngine.raycastSceneMagnetic`, split out of the engine unchanged. */

import type { Intersection, Ray } from './raycaster.js';
import { SnapType, type SnapOptions, type MagneticSnapResult } from './snap-detector.js';
import type { PickClipState, PickOptions } from './types.js';
import {
    queryPointClouds,
    releasedEdgeLock,
    pointCloudSnapEnabled,
    pointCloudWinsOverMeshSnap,
    type PointCloudRayProvider,
    type PointCloudSnapCamera,
} from './raycast-point-cloud-query.js';

export interface PointCloudSnapArgs {
    ray: Ray;
    intersection: Intersection | null;
    options: (PickOptions & { snapOptions?: Partial<SnapOptions> }) | undefined;
    clip?: PickClipState | null;
    cameraFov: number;
    viewportHeight: number;
    /** Half the visible height in world units for an orthographic camera, else null. */
    orthoHalfHeight: number | null;
}

export function withPointCloudSnap(
    provider: PointCloudRayProvider | null, magneticResult: MagneticSnapResult, args: PointCloudSnapArgs,
): MagneticSnapResult {
    const { ray, intersection, options, clip } = args;
    // Point-cloud snapping (#1860): search up to whatever the mesh
    // path already found (or the whole scene, if there was no mesh
    // hit at all) — a real mesh surface in front of a scan point
    // should still win the pick. Gated on the caller's snap config
    // so the measure tool's snap toggle disables scan-point
    // magnetism exactly like mesh vertex/edge magnetism.
    const snapCamera: PointCloudSnapCamera = {
        fov: args.cameraFov,
        canvasHeightPx: args.viewportHeight,
        orthoHalfHeight: args.orthoHalfHeight,
    };
    const maxPointDistance = intersection ? intersection.distance : Infinity;
    const pointHit = pointCloudSnapEnabled(options?.snapOptions)
        ? queryPointClouds(provider, ray, snapCamera, maxPointDistance, options, clip)
        : null;
    if (pointHit) {
        // The face bounded the search. The selected feature can be closer than that face.
        if (pointCloudWinsOverMeshSnap(pointHit, magneticResult.snapTarget, ray, snapCamera)) {
            magneticResult = {
                snapTarget: {
                    type: SnapType.POINT_CLOUD,
                    position: pointHit.position,
                    expressId: pointHit.expressId,
                    confidence: 1,
                },
                edgeLock: releasedEdgeLock(),
            };
        }
    }
    return magneticResult;
}
