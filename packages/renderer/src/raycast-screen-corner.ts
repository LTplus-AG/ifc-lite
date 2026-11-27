/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The screen-space corner step of `RaycastEngine.raycastSceneMagnetic` (#11504). */

import type { MeshData } from '@ifc-lite/geometry';
import type { Camera } from './camera.js';
import type { Ray } from './raycaster.js';
import { SnapType, type SnapDetector, type SnapOptions, type MagneticSnapResult } from './snap-detector.js';
import type { PickClipState, PickOptions } from './types.js';
import type { ScreenCornerIndex } from './snap-screen-corners.js';
import { releasedEdgeLock } from './raycast-point-cloud-query.js';

/** What the engine lends the corner step for one pick. */
export interface ScreenCornerContext {
    camera: Camera;
    /** The current view stamp; read again by the idle build to notice the camera moving between picks. */
    viewKey: () => string;
    snapOccurrences?: import('./snap-corner-instances.js').SnapOccurrences;
    getPieces(): readonly MeshData[];
    snapDetector: SnapDetector;
}

/**
 * CAD-style corner snapping (#11504). With `snapOptions.screenCornerSnap` set and vertex or edge snapping on,
 * the nearest feature corner of the eligible, visible, unclipped pieces within the corner radius of the cursor
 * replaces the ray-based result, whatever the ray hit; failing that the nearest edge within the edge radius
 * replaces a face-only or empty result. An existing vertex/edge snap otherwise stands.
 */
export function withScreenCorner(
    index: ScreenCornerIndex, ctx: ScreenCornerContext,
    current: MagneticSnapResult, x: number, y: number, ray: Ray, viewport: { width: number; height: number },
    options: (PickOptions & { snapOptions?: Partial<SnapOptions> }) | undefined, clip?: PickClipState | null,
    hitDistance: number | null = null,
): MagneticSnapResult {
    const snap = options?.snapOptions;
    index.dropLive();
    const config = snap?.screenCornerSnap;
    if (!config || (snap.snapToVertices === false && snap.snapToEdges === false)) return current;
    const hit = index.query({
        x, y, ray, camera: ctx.camera, viewKey: ctx.viewKey(), liveViewKey: ctx.viewKey, viewport,
        snapOccurrences: ctx.snapOccurrences, pieces: ctx.getPieces(), geometryFor: mesh => ctx.snapDetector.getGeometryCache(mesh),
        startGeometry: mesh => ctx.snapDetector.startGeometryCache(mesh),
        options: config, hiddenIds: options?.hiddenIds, isolatedIds: options?.isolatedIds, clip, hitDistance,
        // Only the enabled kinds are searched: a disabled kind must not win the grid and then be dropped below.
        kinds: { corners: snap.snapToVertices !== false, edges: snap.snapToEdges !== false },
    });
    if (!hit) return current;
    const kind = current.snapTarget?.type;
    if (hit.kind === 'edge' && (kind === SnapType.VERTEX || kind === SnapType.EDGE)) return current;
    if (hit.kind === 'corner' ? snap.snapToVertices === false : snap.snapToEdges === false) return current;
    return {
        snapTarget: {
            type: hit.kind === 'corner' ? SnapType.VERTEX : SnapType.EDGE,
            position: hit.position, expressId: hit.expressId, confidence: 1,
            metadata: hit.edge ? { vertices: [hit.edge.v0, hit.edge.v1] } : undefined,
        },
        edgeLock: releasedEdgeLock(),
    };
}
