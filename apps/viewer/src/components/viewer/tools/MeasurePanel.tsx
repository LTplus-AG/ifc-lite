/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool's viewport presence, mounted by `ToolOverlays` while
 * `activeTool === 'measure'` (#5502, charter #5478 item 20). It composes:
 *
 *  - `MeasureToolbar` — the bar in the HUD's top-center region (mode, snap,
 *    geo XYZ, the Measurements panel, clear, close);
 *  - `MeasureGeoReadout` + `MeasureHint` — the bottom-center readout and
 *    the one hint line;
 *  - `MeasurementOverlays` — the world-anchored lines, labels and snap
 *    glyphs.
 *
 * The LIST / POINT / QTY readouts are NOT here any more: they are the
 * `measurements` side panel (`MeasurementsPanel`), reachable from the bar.
 * What remains in this file is the cursor plumbing the overlays need.
 */

import React, { useEffect, useState } from 'react';
import { useViewerStore } from '@/store';
import { MeasurementOverlays } from './MeasurementVisuals';
import { MeasureToolbar } from './MeasureToolbar';
import { MeasureGeoReadout, MeasureHint } from './MeasureHudReadouts';

export function MeasureOverlay() {
  const measurements = useViewerStore((s) => s.measurements);
  const finishedVisible = useViewerStore((s) => s.sceneState.measurements.visible);
  const pendingMeasurePoint = useViewerStore((s) => s.pendingMeasurePoint);
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const snapTarget = useViewerStore((s) => s.snapTarget);
  const snapVisualization = useViewerStore((s) => s.snapVisualization);
  const measurementConstraintEdge = useViewerStore((s) => s.measurementConstraintEdge);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const activePolyline = useViewerStore((s) => s.activePolyline);
  const polylineMeasurements = useViewerStore((s) => s.polylineMeasurements);

  // Cursor position lives in a ref (no re-renders on mouse move); the snap
  // indicator position is state, updated only when the snap target changes.
  const cursorPosRef = React.useRef<{ x: number; y: number } | null>(null);
  const [snapIndicatorPos, setSnapIndicatorPos] = useState<{ x: number; y: number } | null>(null);
  // Live cursor position, tracked in STATE only while a polyline is being
  // traced. The rubber-band segment needs the cursor even when there is no
  // snap target (cursor over empty background, or Snap toggled off, in which
  // case the hover raycast never runs and snapTarget is never updated) —
  // without this the segment flickers off over gaps and is absent entirely
  // with Snap off. Outside polyline tracing this stays null so ordinary
  // mouse movement keeps causing zero re-renders.
  const [polylineCursor, setPolylineCursor] = useState<{ x: number; y: number } | null>(null);
  // Hidden element whose parent is the viewport overlay container, so page
  // coordinates can be converted to overlay-relative ones for the SVG.
  const overlayRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const container = overlayRef.current?.parentElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        cursorPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      } else {
        cursorPosRef.current = { x: e.clientX, y: e.clientY };
      }
      // Feed the rubber band while a polyline is active. Read from the store
      // directly (not a subscription) so this listener never needs re-binding
      // and mousemove outside polyline tracing stays render-free.
      if (useViewerStore.getState().activePolyline) {
        setPolylineCursor(cursorPosRef.current);
      }
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  useEffect(() => {
    setSnapIndicatorPos(snapTarget && cursorPosRef.current ? cursorPosRef.current : null);
  }, [snapTarget]);

  // Drop the tracked cursor when no polyline is being traced, so a finished
  // or cancelled polyline's last position cannot leak into the next one as a
  // stale rubber-band endpoint.
  useEffect(() => {
    if (!activePolyline) setPolylineCursor(null);
  }, [activePolyline]);

  return (
    <>
      <div ref={overlayRef} className="absolute left-0 top-0 h-0 w-0" />
      <MeasureToolbar />
      <MeasureGeoReadout />
      <MeasureHint />
      <MeasurementOverlays
        measurements={finishedVisible ? measurements : []}
        pending={pendingMeasurePoint}
        activeMeasurement={activeMeasurement}
        snapTarget={snapTarget}
        snapVisualization={snapVisualization}
        // Snapped position wins so the rubber band lands on the snapped
        // point; the raw cursor is the fallback that keeps the segment
        // alive over empty background and with Snap off.
        hoverPosition={snapIndicatorPos ?? polylineCursor}
        projectToScreen={projectToScreen}
        constraintEdge={measurementConstraintEdge}
        unitDisplayOverrides={unitDisplayOverrides}
        activePolyline={activePolyline}
        polylineMeasurements={finishedVisible ? polylineMeasurements : []}
      />
    </>
  );
}
