/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurement handler functions extracted from useMouseControls.
 * Pure functions that operate on a MouseHandlerContext — no React dependency.
 */

import type { SnapTarget } from '@ifc-lite/renderer';
import type { MeasurePoint, SnapVisualization } from '@/store';
import type { MeasurementConstraintEdge, OrthogonalAxis, Vec3 } from '@/store/types.js';
import type { MouseHandlerContext, Camera } from './mouseHandlerTypes.js';
import { getEntityCenter } from '../../utils/viewportUtils.js';
import { projectToCssScreen } from '../../utils/projectScreen.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * Projects a world position onto the closest orthogonal constraint axis.
 * Used by measurement tool when shift is held for axis-aligned measurements.
 *
 * Computes the dot product of the displacement vector (startWorld -> currentWorld)
 * with each of the three orthogonal axes, then projects onto whichever axis has
 * the largest absolute dot product (i.e., the axis most aligned with the cursor direction).
 */
export function projectOntoConstraintAxis(
  startWorld: Vec3,
  currentWorld: Vec3,
  constraint: MeasurementConstraintEdge,
): { projectedPos: Vec3; activeAxis: OrthogonalAxis } {
  const dx = currentWorld.x - startWorld.x;
  const dy = currentWorld.y - startWorld.y;
  const dz = currentWorld.z - startWorld.z;

  const { axis1, axis2, axis3 } = constraint.axes;
  const dot1 = dx * axis1.x + dy * axis1.y + dz * axis1.z;
  const dot2 = dx * axis2.x + dy * axis2.y + dz * axis2.z;
  const dot3 = dx * axis3.x + dy * axis3.y + dz * axis3.z;

  const absDot1 = Math.abs(dot1);
  const absDot2 = Math.abs(dot2);
  const absDot3 = Math.abs(dot3);

  let activeAxis: OrthogonalAxis;
  let chosenDot: number;
  let chosenDir: Vec3;

  if (absDot1 >= absDot2 && absDot1 >= absDot3) {
    activeAxis = 'axis1';
    chosenDot = dot1;
    chosenDir = axis1;
  } else if (absDot2 >= absDot3) {
    activeAxis = 'axis2';
    chosenDot = dot2;
    chosenDir = axis2;
  } else {
    activeAxis = 'axis3';
    chosenDot = dot3;
    chosenDir = axis3;
  }

  const projectedPos: Vec3 = {
    x: startWorld.x + chosenDot * chosenDir.x,
    y: startWorld.y + chosenDot * chosenDir.y,
    z: startWorld.z + chosenDot * chosenDir.z,
  };

  return { projectedPos, activeAxis };
}

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
 * Get approximate world position for an entity (for measurement tool fallback).
 */
export function getApproximateWorldPosition(
  geom: MeshData[] | null,
  entityId: number,
  _screenX: number,
  _screenY: number,
  _canvasWidth: number,
  _canvasHeight: number,
): { x: number; y: number; z: number } {
  return getEntityCenter(geom, entityId) || { x: 0, y: 0, z: 0 };
}

/**
 * Handle mousedown for measurement tool (non-shift).
 * Returns true if the event was handled (caller should early-return).
 */
export function handleMeasureDown(ctx: MouseHandlerContext, e: PointerEvent): boolean {
  const { canvas, renderer, camera, mouseState } = ctx;

  mouseState.isDragging = true;
  canvas.style.cursor = 'crosshair';

  // Calculate canvas-relative coordinates
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

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

  if (result.intersection || result.snapTarget) {
    const snapPoint = result.snapTarget || result.intersection;
    const pos = snapPoint ? ('position' in snapPoint ? snapPoint.position : snapPoint.point) : null;

    if (pos) {
      // Project snapped 3D position to screen - measurement starts from indicator, not cursor
      const screenPos = projectToCssScreen(camera, canvas, pos);
      const measurePoint: MeasurePoint = {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        screenX: screenPos?.x ?? x,
        screenY: screenPos?.y ?? y,
      };

      ctx.startMeasurement(measurePoint);

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

      // Set up orthogonal constraint for shift+drag - always use world axes
      ctx.setMeasurementConstraintEdge({
        axes: {
          axis1: { x: 1, y: 0, z: 0 },  // World X
          axis2: { x: 0, y: 1, z: 0 },  // World Y (vertical)
          axis3: { x: 0, y: 0, z: 1 },  // World Z
        },
        colors: {
          axis1: '#F44336',  // Red - X axis
          axis2: '#8BC34A',  // Lime - Y axis (vertical)
          axis3: '#2196F3',  // Blue - Z axis
        },
        activeAxis: null,
      });
    }
  }

  return true;
}

/**
 * Handle mousemove for measurement tool while dragging with active measurement.
 * Returns true if the event was handled (caller should early-return).
 */
export function handleMeasureDrag(ctx: MouseHandlerContext, e: MouseEvent, x: number, y: number): boolean {
  const { canvas, renderer, camera, mouseState } = ctx;

  // Check if shift is held for orthogonal constraint
  const useOrthogonalConstraint = e.shiftKey && ctx.measurementConstraintEdgeRef.current;

  // Throttle raycasting to 60fps max using requestAnimationFrame
  if (!ctx.measureRaycastPendingRef.current) {
    ctx.measureRaycastPendingRef.current = true;

    ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
      ctx.measureRaycastPendingRef.current = false;
      ctx.measureRaycastFrameRef.current = null;

      const raycastStart = performance.now();

      // When using orthogonal constraint (shift held), use simpler raycasting
      // since the final position will be projected onto an axis anyway
      const snapOn = ctx.snapEnabledRef.current && !useOrthogonalConstraint;

      // If last raycast was slow, reduce complexity to prevent UI freezes
      const wasSlowLastTime = ctx.lastMeasureRaycastDurationRef.current > ctx.SLOW_RAYCAST_THRESHOLD_MS;
      const reduceComplexity = wasSlowLastTime && !useOrthogonalConstraint;

      // Use magnetic snap for edge sliding behavior (only when not in orthogonal mode)
      const currentLock = useOrthogonalConstraint
        ? { edge: null, meshExpressId: null, lockStrength: 0 }
        : ctx.edgeLockStateRef.current;

      const result = renderer.raycastSceneMagnetic(x, y, {
        edge: currentLock.edge,
        meshExpressId: currentLock.meshExpressId,
        lockStrength: currentLock.lockStrength,
      }, {
        hiddenIds: ctx.hiddenEntitiesRef.current,
        isolatedIds: ctx.isolatedEntitiesRef.current,
        // Reduce snap complexity when using orthogonal constraint or when slow
        snapOptions: snapOn ? {
          snapToVertices: !reduceComplexity, // Skip vertex snapping when slow
          snapToEdges: true,
          snapToFaces: true,
          screenSnapRadius: reduceComplexity ? 40 : 60, // Smaller radius when slow
        } : useOrthogonalConstraint ? {
          // In orthogonal mode, snap to edges and vertices only (no faces)
          snapToVertices: true,
          snapToEdges: true,
          snapToFaces: false,
          screenSnapRadius: 40,
        } : {
          snapToVertices: false,
          snapToEdges: false,
          snapToFaces: false,
          screenSnapRadius: 0,
        },
      });

      // Track raycast duration for adaptive throttling
      ctx.lastMeasureRaycastDurationRef.current = performance.now() - raycastStart;

      if (result.intersection || result.snapTarget) {
        const snapPoint = result.snapTarget || result.intersection;
        let pos = snapPoint ? ('position' in snapPoint ? snapPoint.position : snapPoint.point) : null;

        if (pos) {
          // Apply orthogonal constraint if shift is held and we have a constraint
          if (useOrthogonalConstraint && ctx.activeMeasurementRef.current) {
            const constraint = ctx.measurementConstraintEdgeRef.current!;
            const start = ctx.activeMeasurementRef.current.start;
            const projected = projectOntoConstraintAxis(start, pos, constraint);
            pos = projected.projectedPos;

            // Update active axis for visualization
            ctx.updateConstraintActiveAxis(projected.activeAxis);
          } else if (!useOrthogonalConstraint && ctx.measurementConstraintEdgeRef.current?.activeAxis) {
            // Clear active axis when shift is released
            ctx.updateConstraintActiveAxis(null);
          }

          // Project snapped 3D position to screen - indicator position, not raw cursor
          const screenPos = projectToCssScreen(camera, canvas, pos);
          const measurePoint: MeasurePoint = {
            x: pos.x,
            y: pos.y,
            z: pos.z,
            screenX: screenPos?.x ?? x,
            screenY: screenPos?.y ?? y,
          };

          ctx.updateMeasurement(measurePoint);
          ctx.setSnapTarget(result.snapTarget || null);

          // Update edge lock state and snap visualization (even in orthogonal mode)
          if (result.edgeLock.shouldRelease) {
            ctx.clearEdgeLock();
            updateSnapViz(ctx, result.snapTarget || null);
          } else if (result.edgeLock.shouldLock && result.edgeLock.edge) {
            // Check if we're on the same edge to preserve lock strength (hysteresis)
            const sameDirection = currentLock.edge &&
              Math.abs(currentLock.edge.v0.x - result.edgeLock.edge.v0.x) < 0.0001 &&
              Math.abs(currentLock.edge.v0.y - result.edgeLock.edge.v0.y) < 0.0001 &&
              Math.abs(currentLock.edge.v0.z - result.edgeLock.edge.v0.z) < 0.0001 &&
              Math.abs(currentLock.edge.v1.x - result.edgeLock.edge.v1.x) < 0.0001 &&
              Math.abs(currentLock.edge.v1.y - result.edgeLock.edge.v1.y) < 0.0001 &&
              Math.abs(currentLock.edge.v1.z - result.edgeLock.edge.v1.z) < 0.0001;
            const reversedDirection = currentLock.edge &&
              Math.abs(currentLock.edge.v0.x - result.edgeLock.edge.v1.x) < 0.0001 &&
              Math.abs(currentLock.edge.v0.y - result.edgeLock.edge.v1.y) < 0.0001 &&
              Math.abs(currentLock.edge.v0.z - result.edgeLock.edge.v1.z) < 0.0001 &&
              Math.abs(currentLock.edge.v1.x - result.edgeLock.edge.v0.x) < 0.0001 &&
              Math.abs(currentLock.edge.v1.y - result.edgeLock.edge.v0.y) < 0.0001 &&
              Math.abs(currentLock.edge.v1.z - result.edgeLock.edge.v0.z) < 0.0001;
            const isSameEdge = currentLock.edge &&
              currentLock.meshExpressId === result.edgeLock.meshExpressId &&
              (sameDirection || reversedDirection);

            if (isSameEdge) {
              ctx.updateEdgeLockPosition(result.edgeLock.edgeT, result.edgeLock.isCorner, result.edgeLock.cornerValence);
              ctx.incrementEdgeLockStrength();
            } else {
              ctx.setEdgeLock(result.edgeLock.edge, result.edgeLock.meshExpressId!, result.edgeLock.edgeT);
              ctx.updateEdgeLockPosition(result.edgeLock.edgeT, result.edgeLock.isCorner, result.edgeLock.cornerValence);
            }
            updateSnapViz(ctx, result.snapTarget, {
              edgeT: result.edgeLock.edgeT,
              isCorner: result.edgeLock.isCorner,
              cornerValence: result.edgeLock.cornerValence,
            });
          } else {
            updateSnapViz(ctx, result.snapTarget || null);
          }
        }
      }
    });
  }

  // Mark as dragged (any movement counts for measure tool)
  mouseState.didDrag = true;
  return true;
}

/**
 * Handle mousemove for measurement tool hover preview (before dragging starts).
 * Shows snap indicators to help user see where they can snap.
 * Returns true if the event was handled (caller should early-return).
 */
export function handleMeasureHover(ctx: MouseHandlerContext, x: number, y: number): boolean {
  const { renderer } = ctx;

  // Throttle hover snap detection more aggressively (100ms) to avoid performance issues
  const now = Date.now();
  if (now - ctx.lastHoverSnapTimeRef.current < ctx.HOVER_SNAP_THROTTLE_MS) {
    return true; // Skip hover snap detection if throttled
  }
  ctx.lastHoverSnapTimeRef.current = now;

  // Throttle raycasting to avoid performance issues
  if (!ctx.measureRaycastPendingRef.current) {
    ctx.measureRaycastPendingRef.current = true;

    ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
      ctx.measureRaycastPendingRef.current = false;
      ctx.measureRaycastFrameRef.current = null;

      // Use magnetic snap for hover preview
      const currentLock = ctx.edgeLockStateRef.current;
      const result = renderer.raycastSceneMagnetic(x, y, {
        edge: currentLock.edge,
        meshExpressId: currentLock.meshExpressId,
        lockStrength: currentLock.lockStrength,
      }, {
        hiddenIds: ctx.hiddenEntitiesRef.current,
        isolatedIds: ctx.isolatedEntitiesRef.current,
        snapOptions: {
          snapToVertices: true,
          snapToEdges: true,
          snapToFaces: true,
          screenSnapRadius: 40, // Good radius for hover snap detection
        },
      });

      // Update snap target for visual feedback
      if (result.snapTarget) {
        ctx.setSnapTarget(result.snapTarget);

        // Update edge lock state for hover
        if (result.edgeLock.shouldRelease) {
          ctx.clearEdgeLock();
          updateSnapViz(ctx, result.snapTarget);
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
      } else {
        ctx.setSnapTarget(null);
        ctx.clearEdgeLock();
        updateSnapViz(ctx, null);
      }
    });
  }
  return true; // Don't fall through to other tool handlers
}

/**
 * Handle mouseup for measurement tool with active measurement.
 * Returns true if the event was handled (caller should early-return).
 */
export function handleMeasureUp(ctx: MouseHandlerContext, e: PointerEvent): boolean {
  const { canvas, renderer, camera, mouseState } = ctx;

  // Cancel any pending raycast to avoid stale updates
  if (ctx.measureRaycastFrameRef.current) {
    cancelAnimationFrame(ctx.measureRaycastFrameRef.current);
    ctx.measureRaycastFrameRef.current = null;
    ctx.measureRaycastPendingRef.current = false;
  }

  // Do a final synchronous raycast at the mouseup position to ensure accurate end point
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const useOrthogonalConstraint = e.shiftKey && ctx.measurementConstraintEdgeRef.current;
  const currentLock = ctx.edgeLockStateRef.current;

  // Use simpler snap options in orthogonal mode (no magnetic locking needed)
  const finalLock = useOrthogonalConstraint
    ? { edge: null, meshExpressId: null, lockStrength: 0 }
    : currentLock;

  const result = renderer.raycastSceneMagnetic(mx, my, {
    edge: finalLock.edge,
    meshExpressId: finalLock.meshExpressId,
    lockStrength: finalLock.lockStrength,
  }, {
    hiddenIds: ctx.hiddenEntitiesRef.current,
    isolatedIds: ctx.isolatedEntitiesRef.current,
    snapOptions: ctx.snapEnabledRef.current && !useOrthogonalConstraint ? {
      snapToVertices: true,
      snapToEdges: true,
      snapToFaces: true,
      screenSnapRadius: 60,
    } : useOrthogonalConstraint ? {
      // In orthogonal mode, snap to edges and vertices only (no faces)
      snapToVertices: true,
      snapToEdges: true,
      snapToFaces: false,
      screenSnapRadius: 40,
    } : {
      snapToVertices: false,
      snapToEdges: false,
      snapToFaces: false,
      screenSnapRadius: 0,
    },
  });

  // Update measurement with final position before finalizing
  if (result.intersection || result.snapTarget) {
    const snapPoint = result.snapTarget || result.intersection;
    let pos = snapPoint ? ('position' in snapPoint ? snapPoint.position : snapPoint.point) : null;

    if (pos) {
      // Apply orthogonal constraint if shift is held
      if (useOrthogonalConstraint && ctx.activeMeasurementRef.current) {
        const constraint = ctx.measurementConstraintEdgeRef.current!;
        const start = ctx.activeMeasurementRef.current.start;
        const projected = projectOntoConstraintAxis(start, pos, constraint);
        pos = projected.projectedPos;
      }

      const screenPos = projectToCssScreen(camera, canvas, pos);
      const measurePoint: MeasurePoint = {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        screenX: screenPos?.x ?? mx,
        screenY: screenPos?.y ?? my,
      };
      ctx.updateMeasurement(measurePoint);
    }
  }

  ctx.finalizeMeasurement();
  ctx.clearEdgeLock(); // Clear edge lock after measurement complete
  mouseState.isDragging = false;
  mouseState.didDrag = false;
  canvas.style.cursor = 'crosshair';
  return true;
}

/**
 * Update measurement screen coordinates during zoom (wheel event).
 * Called when in measure mode with pending measurements.
 */
export function updateMeasureScreenCoords(ctx: MouseHandlerContext): void {
  const { canvas, camera } = ctx;
  ctx.updateMeasurementScreenCoords((worldPos) => {
    return projectToCssScreen(camera, canvas, worldPos);
  });
  // Update camera state tracking to prevent duplicate update in animation loop
  const cameraPos = camera.getPosition();
  const cameraRot = camera.getRotation();
  const cameraDist = camera.getDistance();
  ctx.lastCameraStateRef.current = {
    position: cameraPos,
    rotation: cameraRot,
    distance: cameraDist,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  };
}
