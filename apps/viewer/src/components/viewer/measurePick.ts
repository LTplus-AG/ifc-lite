/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool's snapped point pick, shared by the mouse press
 * (`handleMeasureDown`) and the touch tap (`touchRouting.ts`, #5856), plus the
 * snap visualisation it drives. One pick, so a tapped point snaps exactly like
 * a clicked one.
 */

import type { SnapTarget } from '@ifc-lite/renderer';
import type { MeasurePoint, SnapVisualization } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { projectToCssScreen } from '../../utils/projectScreen.js';

/**
 * Compute snap visualization (edge highlights, sliding dot, corner rings, plane indicators).
 * Stores 3D coordinates so edge highlights stay positioned correctly during camera rotation.
 */
export function updateSnapViz(
  ctx: MouseHandlerContext,
  snapTarget: SnapTarget | null,
  edgeLockInfo?: { edgeT: number; isCorner: boolean; cornerValence: number },
): void {
  if (!snapTarget || !ctx.canvas) {
    ctx.setSnapVisualization(null);
    return;
  }

  const viz: Partial<SnapVisualization> = {};

  // For edge snaps: store 3D world coordinates (will be projected to screen by ToolOverlays)
  if ((snapTarget.type === 'edge' || snapTarget.type === 'vertex') && snapTarget.metadata?.vertices) {
    const [v0, v1] = snapTarget.metadata.vertices;

    // Store 3D coordinates - these will be projected dynamically during rendering
    viz.edgeLine3D = {
      v0: { x: v0.x, y: v0.y, z: v0.z },
      v1: { x: v1.x, y: v1.y, z: v1.z },
    };

    // Add sliding dot t-parameter along the edge
    if (edgeLockInfo) {
      viz.slidingDot = { t: edgeLockInfo.edgeT };

      // Add corner rings if at a corner with high valence
      if (edgeLockInfo.isCorner && edgeLockInfo.cornerValence >= 2) {
        viz.cornerRings = {
          atStart: edgeLockInfo.edgeT < 0.5,
          valence: edgeLockInfo.cornerValence,
        };
      }
    } else {
      // No edge lock info - calculate t from snap position
      const edge = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
      const toSnap = { x: snapTarget.position.x - v0.x, y: snapTarget.position.y - v0.y, z: snapTarget.position.z - v0.z };
      const edgeLenSq = edge.x * edge.x + edge.y * edge.y + edge.z * edge.z;
      const t = edgeLenSq > 0 ? (toSnap.x * edge.x + toSnap.y * edge.y + toSnap.z * edge.z) / edgeLenSq : 0.5;
      viz.slidingDot = { t: Math.max(0, Math.min(1, t)) };
    }
  }

  // For face snaps: show plane indicator (still screen-space since it's just an indicator)
  if ((snapTarget.type === 'face' || snapTarget.type === 'face_center') && snapTarget.normal) {
    const pos = projectToCssScreen(ctx.camera, ctx.canvas, snapTarget.position);
    if (pos) {
      viz.planeIndicator = {
        x: pos.x,
        y: pos.y,
        normal: snapTarget.normal,
      };
    }
  }

  ctx.setSnapVisualization(viz);
}

/**
 * Raycast a measure point at canvas CSS coordinates, with the magnetic
 * edge/vertex/face snap, and update the snap target, edge lock and snap
 * visualisation. Returns null when nothing is hit.
 */
export function pickMeasurePoint(ctx: MouseHandlerContext, x: number, y: number): MeasurePoint | null {
  const { canvas, renderer, camera } = ctx;
  // Use magnetic snap for better edge locking
  const currentLock = ctx.edgeLockStateRef.current;
  const result = renderer.raycastSceneMagnetic(x, y, {
    edge: currentLock.edge,
    meshExpressId: currentLock.meshExpressId,
    lockStrength: currentLock.lockStrength,
  }, {
    hiddenIds: ctx.hiddenEntitiesRef.current,
    isolatedIds: ctx.isolatedEntitiesRef.current,
    snapOptions: ctx.snapEnabledRef.current ? {
      snapToVertices: true,
      snapToEdges: true,
      snapToFaces: true,
      screenSnapRadius: 60,
    } : {
      snapToVertices: false,
      snapToEdges: false,
      snapToFaces: false,
      screenSnapRadius: 0,
    },
  });

  const snapPoint = result.snapTarget || result.intersection;
  const pos = snapPoint ? ('position' in snapPoint ? snapPoint.position : snapPoint.point) : null;
  if (!pos) return null;

  if (result.snapTarget) {
    ctx.setSnapTarget(result.snapTarget);
  }

  // Update edge lock state
  if (result.edgeLock.shouldRelease) {
    ctx.clearEdgeLock();
    updateSnapViz(ctx, result.snapTarget || null);
  } else if (result.edgeLock.shouldLock && result.edgeLock.edge) {
    ctx.setEdgeLock(result.edgeLock.edge, result.edgeLock.meshExpressId!, result.edgeLock.edgeT);
    updateSnapViz(ctx, result.snapTarget, {
      edgeT: result.edgeLock.edgeT,
      isCorner: result.edgeLock.isCorner,
      cornerValence: result.edgeLock.cornerValence,
    });
  } else {
    updateSnapViz(ctx, result.snapTarget);
  }

  // Project snapped 3D position to screen - measurement starts from indicator, not cursor
  const screenPos = projectToCssScreen(camera, canvas, pos);
  return { x: pos.x, y: pos.y, z: pos.z, screenX: screenPos?.x ?? x, screenY: screenPos?.y ?? y };
}
