/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SVG measurement overlay visualizations (lines, labels, snap indicators)
 */

import React, { useMemo } from 'react';
import type { Measurement, SnapVisualization } from '@/store';
import type { MeasurementConstraintEdge } from '@/store/types';
import { SnapType, type SnapTarget } from '@ifc-lite/renderer';
import type { ProjectUnits } from '@ifc-lite/parser';
import { formatDistance } from './formatDistance';

export interface MeasurementOverlaysProps {
  measurements: Measurement[];
  pending: { screenX: number; screenY: number } | null;
  activeMeasurement: { start: { screenX: number; screenY: number; x: number; y: number; z: number }; current: { screenX: number; screenY: number }; distance: number } | null;
  snapTarget: SnapTarget | null;
  snapVisualization: SnapVisualization | null;
  hoverPosition?: { x: number; y: number } | null;
  projectToScreen?: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null;
  constraintEdge?: MeasurementConstraintEdge | null;
  projectUnits?: ProjectUnits;
  unitDisplayOverrides?: Record<string, string>;
}

export const MeasurementOverlays = React.memo(function MeasurementOverlays({ measurements, pending, activeMeasurement, snapTarget, snapVisualization, hoverPosition, projectToScreen, constraintEdge, projectUnits, unitDisplayOverrides }: MeasurementOverlaysProps) {
  // Determine snap indicator position
  // Priority: activeMeasurement.current > snapTarget projected position > hoverPosition (fallback)
  const snapIndicatorPos = useMemo(() => {
    // During active measurement, use the measurement's current position
    if (activeMeasurement) {
      return { x: activeMeasurement.current.screenX, y: activeMeasurement.current.screenY };
    }
    // During hover, project the snap target's world position to screen
    // This ensures the indicator is at the actual snap point, not the cursor
    if (snapTarget && projectToScreen) {
      const projected = projectToScreen(snapTarget.position);
      if (projected) {
        return projected;
      }
    }
    // Fallback to hover position (cursor position)
    return hoverPosition ?? null;
  }, [
    activeMeasurement?.current?.screenX,
    activeMeasurement?.current?.screenY,
    snapTarget?.position?.x,
    snapTarget?.position?.y,
    snapTarget?.position?.z,
    projectToScreen,
    hoverPosition?.x,
    hoverPosition?.y,
  ]);

  return (
    <>
      {/* SVG filter definitions for glow effect */}
      <svg className="absolute w-0 h-0 pointer-events-none" style={{ pointerEvents: 'none' }}>
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <filter id="snap-glow">
            <feGaussianBlur stdDeviation="4" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
      </svg>

      {/* Completed measurements */}
      {measurements.map((m) => (
        <div key={m.id} className="pointer-events-none">
          {/* Line connecting start and end */}
          <svg
            className="absolute inset-0 pointer-events-none z-20"
            style={{ overflow: 'visible', pointerEvents: 'none' }}
          >
            <line
              x1={m.start.screenX}
              y1={m.start.screenY}
              x2={m.end.screenX}
              y2={m.end.screenY}
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              strokeDasharray="6,3"
              filter="url(#glow)"
            />
            {/* Start point */}
            <circle
              cx={m.start.screenX}
              cy={m.start.screenY}
              r="5"
              fill="white"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
            />
            {/* End point */}
            <circle
              cx={m.end.screenX}
              cy={m.end.screenY}
              r="5"
              fill="white"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
            />
          </svg>

          {/* Distance label at midpoint - brutalist style */}
          <div
            className="absolute pointer-events-none z-20 bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-2 py-1 font-mono text-xs font-bold -translate-x-1/2 -translate-y-1/2 border-2 border-zinc-900 dark:border-zinc-100 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.3)]"
            style={{
              left: (m.start.screenX + m.end.screenX) / 2,
              top: (m.start.screenY + m.end.screenY) / 2,
            }}
          >
            {formatDistance(m.distance, projectUnits, unitDisplayOverrides)}
          </div>
        </div>
      ))}

      {/* Active measurement (live preview while dragging) */}
      {activeMeasurement && (
        <div className="pointer-events-none">
          <svg
            className="absolute inset-0 pointer-events-none z-20"
            style={{ overflow: 'visible', pointerEvents: 'none' }}
          >
            {/* Animated dashed line (marching ants effect) */}
            <line
              x1={activeMeasurement.start.screenX}
              y1={activeMeasurement.start.screenY}
              x2={activeMeasurement.current.screenX}
              y2={activeMeasurement.current.screenY}
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              strokeDasharray="6,3"
              strokeOpacity="0.7"
              filter="url(#glow)"
            />
            {/* Start point */}
            <circle
              cx={activeMeasurement.start.screenX}
              cy={activeMeasurement.start.screenY}
              r="6"
              fill="white"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              filter="url(#glow)"
            />
            {/* Current point (slightly larger, pulsing) */}
            <circle
              cx={activeMeasurement.current.screenX}
              cy={activeMeasurement.current.screenY}
              r="7"
              fill="white"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              filter="url(#glow)"
              className="animate-pulse"
            />
          </svg>

          {/* Live distance label - brutalist style */}
          <div
            className="absolute pointer-events-none z-20 bg-primary text-primary-foreground px-2.5 py-1 font-mono text-sm font-bold -translate-x-1/2 -translate-y-1/2 border-2 border-primary shadow-[3px_3px_0px_0px_rgba(0,0,0,0.2)]"
            style={{
              left: (activeMeasurement.start.screenX + activeMeasurement.current.screenX) / 2,
              top: (activeMeasurement.start.screenY + activeMeasurement.current.screenY) / 2,
            }}
          >
            {formatDistance(activeMeasurement.distance, projectUnits, unitDisplayOverrides)}
          </div>
        </div>
      )}

      {/* Orthogonal constraint axes visualization */}
      {activeMeasurement && constraintEdge?.activeAxis && projectToScreen && (() => {
        const startWorld = activeMeasurement.start;
        const startScreen = { x: startWorld.screenX, y: startWorld.screenY };

        // Project axis endpoints to screen space
        const axisLength = 2.0; // 2 meters in world space

        const { axis1, axis2, axis3 } = constraintEdge.axes;
        const colors = constraintEdge.colors;

        // Calculate endpoints along each axis (positive and negative)
        const axis1End = projectToScreen({
          x: startWorld.x + axis1.x * axisLength,
          y: startWorld.y + axis1.y * axisLength,
          z: startWorld.z + axis1.z * axisLength,
        });
        const axis1Neg = projectToScreen({
          x: startWorld.x - axis1.x * axisLength,
          y: startWorld.y - axis1.y * axisLength,
          z: startWorld.z - axis1.z * axisLength,
        });
        const axis2End = projectToScreen({
          x: startWorld.x + axis2.x * axisLength,
          y: startWorld.y + axis2.y * axisLength,
          z: startWorld.z + axis2.z * axisLength,
        });
        const axis2Neg = projectToScreen({
          x: startWorld.x - axis2.x * axisLength,
          y: startWorld.y - axis2.y * axisLength,
          z: startWorld.z - axis2.z * axisLength,
        });
        const axis3End = projectToScreen({
          x: startWorld.x + axis3.x * axisLength,
          y: startWorld.y + axis3.y * axisLength,
          z: startWorld.z + axis3.z * axisLength,
        });
        const axis3Neg = projectToScreen({
          x: startWorld.x - axis3.x * axisLength,
          y: startWorld.y - axis3.y * axisLength,
          z: startWorld.z - axis3.z * axisLength,
        });

        if (!axis1End || !axis1Neg || !axis2End || !axis2Neg || !axis3End || !axis3Neg) return null;

        const activeAxis = constraintEdge.activeAxis;

        return (
          <svg
            className="absolute inset-0 pointer-events-none z-25"
            style={{ overflow: 'visible', pointerEvents: 'none' }}
          >
            {/* Axis 1 */}
            <line
              x1={axis1Neg.x}
              y1={axis1Neg.y}
              x2={axis1End.x}
              y2={axis1End.y}
              stroke={colors.axis1}
              strokeWidth={activeAxis === 'axis1' ? 3 : 1.5}
              strokeOpacity={activeAxis === 'axis1' ? 0.9 : 0.3}
              strokeDasharray={activeAxis === 'axis1' ? 'none' : '4,4'}
              strokeLinecap="round"
            />
            {/* Axis 2 */}
            <line
              x1={axis2Neg.x}
              y1={axis2Neg.y}
              x2={axis2End.x}
              y2={axis2End.y}
              stroke={colors.axis2}
              strokeWidth={activeAxis === 'axis2' ? 3 : 1.5}
              strokeOpacity={activeAxis === 'axis2' ? 0.9 : 0.3}
              strokeDasharray={activeAxis === 'axis2' ? 'none' : '4,4'}
              strokeLinecap="round"
            />
            {/* Axis 3 */}
            <line
              x1={axis3Neg.x}
              y1={axis3Neg.y}
              x2={axis3End.x}
              y2={axis3End.y}
              stroke={colors.axis3}
              strokeWidth={activeAxis === 'axis3' ? 3 : 1.5}
              strokeOpacity={activeAxis === 'axis3' ? 0.9 : 0.3}
              strokeDasharray={activeAxis === 'axis3' ? 'none' : '4,4'}
              strokeLinecap="round"
            />
            {/* Center origin dot */}
            <circle
              cx={startScreen.x}
              cy={startScreen.y}
              r="4"
              fill="white"
              stroke={colors[activeAxis]}
              strokeWidth="2"
            />
          </svg>
        );
      })()}

      {/* Edge highlight - draw full edge in 3D-projected screen space */}
      {snapVisualization?.edgeLine3D && projectToScreen && (() => {
        const start = projectToScreen(snapVisualization.edgeLine3D.v0);
        const end = projectToScreen(snapVisualization.edgeLine3D.v1);
        if (!start || !end) return null;

        // Corner position (at v0 or v1)
        const cornerPos = snapVisualization.cornerRings
          ? (snapVisualization.cornerRings.atStart ? start : end)
          : null;

        return (
          <svg
            className="absolute inset-0 pointer-events-none z-30"
            style={{ overflow: 'visible', pointerEvents: 'none' }}
          >
            {/* Edge line with snap color (orange for edges) */}
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="#FF9800"
              strokeWidth="4"
              strokeOpacity="0.9"
              strokeLinecap="round"
              filter="url(#snap-glow)"
            />
            {/* Outer glow line for better visibility */}
            <line
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke="#FF9800"
              strokeWidth="8"
              strokeOpacity="0.3"
              strokeLinecap="round"
            />
            {/* Edge endpoints */}
            <circle cx={start.x} cy={start.y} r="4" fill="#FF9800" fillOpacity="0.6" />
            <circle cx={end.x} cy={end.y} r="4" fill="#FF9800" fillOpacity="0.6" />

            {/* Corner rings - shows strong attraction at corners */}
            {cornerPos && snapVisualization.cornerRings && (
              <>
                {/* Outer pulsing ring */}
                <circle
                  cx={cornerPos.x}
                  cy={cornerPos.y}
                  r="18"
                  fill="none"
                  stroke="#FFEB3B"
                  strokeWidth="2"
                  strokeOpacity="0.4"
                  className="animate-pulse"
                />
                {/* Middle ring */}
                <circle
                  cx={cornerPos.x}
                  cy={cornerPos.y}
                  r="12"
                  fill="none"
                  stroke="#FFEB3B"
                  strokeWidth="2"
                  strokeOpacity="0.6"
                />
                {/* Inner ring */}
                <circle
                  cx={cornerPos.x}
                  cy={cornerPos.y}
                  r="6"
                  fill="#FFEB3B"
                  fillOpacity="0.8"
                  stroke="white"
                  strokeWidth="1"
                />
                {/* Center dot */}
                <circle
                  cx={cornerPos.x}
                  cy={cornerPos.y}
                  r="2"
                  fill="white"
                />
                {/* Valence indicators (small dots around corner) */}
                {snapVisualization.cornerRings.valence >= 3 && (
                  <>
                    <circle cx={cornerPos.x - 10} cy={cornerPos.y} r="2" fill="#FFEB3B" fillOpacity="0.7" />
                    <circle cx={cornerPos.x + 10} cy={cornerPos.y} r="2" fill="#FFEB3B" fillOpacity="0.7" />
                    <circle cx={cornerPos.x} cy={cornerPos.y - 10} r="2" fill="#FFEB3B" fillOpacity="0.7" />
                  </>
                )}
              </>
            )}
          </svg>
        );
      })()}

      {/* Plane indicator - subtle grid/cross for face snaps */}
      {snapVisualization?.planeIndicator && (
        <svg
          className="absolute inset-0 pointer-events-none z-25"
          style={{ overflow: 'visible', pointerEvents: 'none' }}
        >
          {/* Cross indicator */}
          <line
            x1={snapVisualization.planeIndicator.x - 20}
            y1={snapVisualization.planeIndicator.y}
            x2={snapVisualization.planeIndicator.x + 20}
            y2={snapVisualization.planeIndicator.y}
            stroke="hsl(var(--primary))"
            strokeWidth="2"
            strokeOpacity="0.4"
          />
          <line
            x1={snapVisualization.planeIndicator.x}
            y1={snapVisualization.planeIndicator.y - 20}
            x2={snapVisualization.planeIndicator.x}
            y2={snapVisualization.planeIndicator.y + 20}
            stroke="hsl(var(--primary))"
            strokeWidth="2"
            strokeOpacity="0.4"
          />
          {/* Small circle at center */}
          <circle
            cx={snapVisualization.planeIndicator.x}
            cy={snapVisualization.planeIndicator.y}
            r="4"
            fill="hsl(var(--primary))"
            fillOpacity="0.6"
          />
        </svg>
      )}

      {/* Snap indicator */}
      {snapTarget && snapIndicatorPos && (
        <SnapIndicator
          screenX={snapIndicatorPos.x}
          screenY={snapIndicatorPos.y}
          snapType={snapTarget.type}
        />
      )}

      {/* Pending point (legacy - keep for backward compatibility) */}
      {pending && !activeMeasurement && (
        <svg
          className="absolute inset-0 pointer-events-none z-20"
          style={{ overflow: 'visible', pointerEvents: 'none' }}
        >
          <circle
            cx={pending.screenX}
            cy={pending.screenY}
            r="5"
            fill="none"
            stroke="hsl(var(--primary))"
            strokeWidth="1.5"
          />
          <circle
            cx={pending.screenX}
            cy={pending.screenY}
            r="2.5"
            fill="hsl(var(--primary))"
          />
        </svg>
      )}
    </>
  );
}, (prevProps, nextProps) => {
  // Custom comparison to prevent unnecessary re-renders
  // Return true if props are equal (skip re-render), false if different (re-render)

  // Compare measurements - check both IDs AND screen coordinates
  if (prevProps.measurements.length !== nextProps.measurements.length) return false;
  for (let i = 0; i < prevProps.measurements.length; i++) {
    const prev = prevProps.measurements[i];
    const next = nextProps.measurements[i];
    if (!next || prev.id !== next.id) return false;
    // Check screen coordinates for zoom/camera changes
    if (prev.start.screenX !== next.start.screenX || prev.start.screenY !== next.start.screenY) return false;
    if (prev.end.screenX !== next.end.screenX || prev.end.screenY !== next.end.screenY) return false;
  }

  // Compare activeMeasurement - check if it exists and if position changed
  if (!!prevProps.activeMeasurement !== !!nextProps.activeMeasurement) return false;
  if (prevProps.activeMeasurement && nextProps.activeMeasurement) {
    if (
      prevProps.activeMeasurement.current.screenX !== nextProps.activeMeasurement.current.screenX ||
      prevProps.activeMeasurement.current.screenY !== nextProps.activeMeasurement.current.screenY ||
      prevProps.activeMeasurement.start.screenX !== nextProps.activeMeasurement.start.screenX ||
      prevProps.activeMeasurement.start.screenY !== nextProps.activeMeasurement.start.screenY
    ) return false;
  }

  // Compare snapTarget - check type and position
  if (!!prevProps.snapTarget !== !!nextProps.snapTarget) return false;
  if (prevProps.snapTarget && nextProps.snapTarget) {
    if (
      prevProps.snapTarget.type !== nextProps.snapTarget.type ||
      prevProps.snapTarget.position.x !== nextProps.snapTarget.position.x ||
      prevProps.snapTarget.position.y !== nextProps.snapTarget.position.y ||
      prevProps.snapTarget.position.z !== nextProps.snapTarget.position.z
    ) return false;
  }

  // Compare snapVisualization
  if (!!prevProps.snapVisualization !== !!nextProps.snapVisualization) return false;
  if (prevProps.snapVisualization && nextProps.snapVisualization) {
    // Compare edgeLine3D (3D world coordinates)
    const prevEdge = prevProps.snapVisualization.edgeLine3D;
    const nextEdge = nextProps.snapVisualization.edgeLine3D;
    if (!!prevEdge !== !!nextEdge) return false;
    if (prevEdge && nextEdge) {
      if (
        prevEdge.v0.x !== nextEdge.v0.x ||
        prevEdge.v0.y !== nextEdge.v0.y ||
        prevEdge.v0.z !== nextEdge.v0.z ||
        prevEdge.v1.x !== nextEdge.v1.x ||
        prevEdge.v1.y !== nextEdge.v1.y ||
        prevEdge.v1.z !== nextEdge.v1.z
      ) return false;
    }
    // Compare slidingDot (t parameter only)
    const prevDot = prevProps.snapVisualization.slidingDot;
    const nextDot = nextProps.snapVisualization.slidingDot;
    if (!!prevDot !== !!nextDot) return false;
    if (prevDot && nextDot) {
      if (prevDot.t !== nextDot.t) return false;
    }
    // Compare cornerRings (atStart + valence)
    const prevCorner = prevProps.snapVisualization.cornerRings;
    const nextCorner = nextProps.snapVisualization.cornerRings;
    if (!!prevCorner !== !!nextCorner) return false;
    if (prevCorner && nextCorner) {
      if (
        prevCorner.atStart !== nextCorner.atStart ||
        prevCorner.valence !== nextCorner.valence
      ) return false;
    }
    const prevPlane = prevProps.snapVisualization.planeIndicator;
    const nextPlane = nextProps.snapVisualization.planeIndicator;
    if (!!prevPlane !== !!nextPlane) return false;
    if (prevPlane && nextPlane) {
      if (
        prevPlane.x !== nextPlane.x ||
        prevPlane.y !== nextPlane.y
      ) return false;
    }
  }

  // Compare projectToScreen (always re-render if it changes as we need it for projection)
  if (prevProps.projectToScreen !== nextProps.projectToScreen) return false;

  // Compare hoverPosition
  if (prevProps.hoverPosition?.x !== nextProps.hoverPosition?.x ||
      prevProps.hoverPosition?.y !== nextProps.hoverPosition?.y) return false;

  // Compare pending
  if (prevProps.pending?.screenX !== nextProps.pending?.screenX ||
      prevProps.pending?.screenY !== nextProps.pending?.screenY) return false;

  // Compare constraintEdge
  if (!!prevProps.constraintEdge !== !!nextProps.constraintEdge) return false;
  if (prevProps.constraintEdge && nextProps.constraintEdge) {
    if (prevProps.constraintEdge.activeAxis !== nextProps.constraintEdge.activeAxis) return false;
  }

  return true; // All props are equal, skip re-render
});

interface SnapIndicatorProps {
  screenX: number;
  screenY: number;
  snapType: SnapType;
}

function SnapIndicator({ screenX, screenY, snapType }: SnapIndicatorProps) {
  // Distinct colors for each snap type - no labels needed, shapes are self-explanatory
  // Record<SnapType, string> so a future SnapType member without a colour
  // fails to compile instead of silently rendering undefined (mirrors
  // getBestSnapTarget's priority map in snap-detector.ts).
  const snapColors: Record<SnapType, string> = {
    [SnapType.VERTEX]: '#FFEB3B', // Yellow - circle = point
    [SnapType.EDGE]: '#FF9800', // Orange - line = edge
    [SnapType.FACE]: '#03A9F4', // Light Blue - square = face
    [SnapType.FACE_CENTER]: '#00BCD4', // Cyan - square with dot = center
    [SnapType.POINT_CLOUD]: '#AB47BC', // Violet - small dot = snapped scan point (#1860)
  };

  const color = snapColors[snapType];

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-25"
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      {/* Outer glow ring - subtle pulsing indicator */}
      <circle
        cx={screenX}
        cy={screenY}
        r="10"
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeOpacity="0.4"
        filter="url(#snap-glow)"
      />

      {/* Vertex: filled circle (point) */}
      {snapType === SnapType.VERTEX && (
        <>
          <circle cx={screenX} cy={screenY} r="5" fill={color} opacity="0.3" />
          <circle cx={screenX} cy={screenY} r="2.5" fill={color} />
        </>
      )}

      {/* Point cloud: same "point" shape as vertex, distinct colour, so
          a snapped scan point reads as a subtly different kind of point
          rather than a wholly new indicator (#1860). */}
      {snapType === SnapType.POINT_CLOUD && (
        <>
          <circle cx={screenX} cy={screenY} r="5" fill={color} opacity="0.3" />
          <circle cx={screenX} cy={screenY} r="2.5" fill={color} />
        </>
      )}

      {/* Edge: horizontal line with center dot */}
      {snapType === SnapType.EDGE && (
        <>
          <line
            x1={screenX - 8}
            y1={screenY}
            x2={screenX + 8}
            y2={screenY}
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx={screenX} cy={screenY} r="2" fill={color} />
        </>
      )}

      {/* Face: square outline */}
      {snapType === SnapType.FACE && (
        <>
          <rect
            x={screenX - 5}
            y={screenY - 5}
            width="10"
            height="10"
            fill={color}
            fillOpacity="0.2"
            stroke={color}
            strokeWidth="1.5"
          />
        </>
      )}

      {/* Face Center: square with center dot */}
      {snapType === SnapType.FACE_CENTER && (
        <>
          <rect
            x={screenX - 5}
            y={screenY - 5}
            width="10"
            height="10"
            fill="none"
            stroke={color}
            strokeWidth="1.5"
          />
          <circle cx={screenX} cy={screenY} r="2" fill={color} />
        </>
      )}
    </svg>
  );
}
