/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure tool panel UI (measurement list, controls)
 */

import React, { useCallback, useState, useEffect } from 'react';
import { X, Trash2, Ruler, ChevronDown, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore, type Measurement } from '@/store';
import { MeasurementOverlays } from './MeasurementVisuals';
import { formatDistance } from './formatDistance';
import { useDraggablePanel } from '@/hooks/useDraggablePanel';

export function MeasureOverlay() {
  const measurements = useViewerStore((s) => s.measurements);
  const pendingMeasurePoint = useViewerStore((s) => s.pendingMeasurePoint);
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const snapTarget = useViewerStore((s) => s.snapTarget);
  const snapVisualization = useViewerStore((s) => s.snapVisualization);
  const snapEnabled = useViewerStore((s) => s.snapEnabled);
  const measurementConstraintEdge = useViewerStore((s) => s.measurementConstraintEdge);
  const toggleSnap = useViewerStore((s) => s.toggleSnap);
  const deleteMeasurement = useViewerStore((s) => s.deleteMeasurement);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const projectToScreen = useViewerStore((s) => s.cameraCallbacks.projectToScreen);

  // Track cursor position in ref (no re-renders on mouse move)
  const cursorPosRef = React.useRef<{ x: number; y: number } | null>(null);
  // Only update snap indicator position when snap target changes (not on every cursor move)
  const [snapIndicatorPos, setSnapIndicatorPos] = useState<{ x: number; y: number } | null>(null);
  // Panel collapsed by default for minimal UI
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);
  // Ref to the overlay container for coordinate conversion
  const overlayRef = React.useRef<HTMLDivElement>(null);

  // Update cursor position in ref (no re-renders)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Convert page coords to overlay-relative coords for consistent SVG positioning
      const container = overlayRef.current?.parentElement;
      if (container) {
        const rect = container.getBoundingClientRect();
        cursorPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      } else {
        cursorPosRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  // Update snap indicator position when snap target changes
  // Cursor position is stored in ref (no re-renders on mouse move)
  // Snap target changes already trigger re-renders, so indicator will update frequently enough
  useEffect(() => {
    if (snapTarget && cursorPosRef.current) {
      setSnapIndicatorPos(cursorPosRef.current);
    } else {
      setSnapIndicatorPos(null);
    }
  }, [snapTarget]);

  const handleClear = useCallback(() => {
    clearMeasurements();
  }, [clearMeasurements]);

  const handleDeleteMeasurement = useCallback((id: string) => {
    deleteMeasurement(id);
  }, [deleteMeasurement]);

  const togglePanel = useCallback(() => {
    setIsPanelCollapsed(prev => !prev);
  }, []);

  const handleClose = useCallback(() => {
    setActiveTool('select');
  }, [setActiveTool]);

  // Calculate total distance
  const totalDistance = measurements.reduce((sum, m) => sum + m.distance, 0);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const drag = useDraggablePanel(panelRef);

  return (
    <>
      {/* Hidden ref element for coordinate calculation */}
      <div ref={overlayRef} className="absolute top-0 left-0 w-0 h-0" />

      {/* Compact Measure Tool Panel */}
      <div ref={panelRef} style={drag.style} className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 bg-background/95 backdrop-blur-sm rounded-lg border shadow-lg z-30">
        {/* Header: grip drags (issue #1107), title button collapses. */}
        <div className="flex items-center justify-between gap-2 p-2">
          <div className="flex items-center gap-1 min-w-0">
            <span
              onMouseDown={drag.onDragStart}
              title="Drag to move"
              className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <button
              onClick={togglePanel}
              className="flex items-center gap-2 hover:bg-accent/50 rounded px-2 py-1 transition-colors min-w-0"
            >
              <Ruler className="h-4 w-4 text-primary" />
              <span className="font-medium text-sm">Measure</span>
              {measurements.length > 0 && !isPanelCollapsed && (
                <span className="text-xs text-muted-foreground">({measurements.length})</span>
              )}
              <ChevronDown className={`h-3 w-3 transition-transform ${isPanelCollapsed ? '-rotate-90' : ''}`} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            {measurements.length > 0 && (
              <Button variant="ghost" size="icon-sm" onClick={handleClear} title="Clear all">
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={handleClose} title="Close">
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Expandable content */}
        {!isPanelCollapsed && (
          <div className="border-t px-2 pb-2 min-w-56">
            {measurements.length > 0 ? (
              <div className="space-y-1 mt-2">
                {measurements.map((m, i) => (
                  <MeasurementItem
                    key={m.id}
                    measurement={m}
                    index={i}
                    onDelete={handleDeleteMeasurement}
                  />
                ))}
                {measurements.length > 1 && (
                  <div className="flex items-center justify-between border-t pt-1 mt-1 text-xs font-medium">
                    <span>Total</span>
                    <span className="font-mono">{formatDistance(totalDistance)}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-2 text-muted-foreground text-xs">
                No measurements
              </div>
            )}
          </div>
        )}
      </div>

      {/* Instruction hint - brutalist style with snap-colored shadow */}
      <div
        className="pointer-events-auto absolute bottom-16 left-1/2 -translate-x-1/2 z-30 bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 border-2 border-zinc-900 dark:border-zinc-100 transition-shadow duration-150"
        style={{
          boxShadow: snapTarget
            ? `4px 4px 0px 0px ${
                snapTarget.type === 'vertex' ? '#FFEB3B' :
                snapTarget.type === 'edge' ? '#FF9800' :
                snapTarget.type === 'face' ? '#03A9F4' : '#00BCD4'
              }`
            : '3px 3px 0px 0px rgba(0,0,0,0.3)'
        }}
      >
        <span className="font-mono text-xs uppercase tracking-wide">
          {activeMeasurement ? 'Release to complete' : 'Drag to measure'}
        </span>
      </div>

      {/* Snap toggle - brutalist style */}
      <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
        <button
          onClick={toggleSnap}
          className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider border-2 transition-colors ${
            snapEnabled
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 border-zinc-300 dark:border-zinc-700'
          }`}
          title="Toggle snap (S key)"
        >
          Snap {snapEnabled ? 'On' : 'Off'}
        </button>
      </div>

      {/* Render measurement lines, labels, and snap indicators */}
      <MeasurementOverlays
        measurements={measurements}
        pending={pendingMeasurePoint}
        activeMeasurement={activeMeasurement}
        snapTarget={snapTarget}
        snapVisualization={snapVisualization}
        hoverPosition={snapIndicatorPos}
        projectToScreen={projectToScreen}
        constraintEdge={measurementConstraintEdge}
      />
    </>
  );
}

interface MeasurementItemProps {
  measurement: Measurement;
  index: number;
  onDelete: (id: string) => void;
}

function MeasurementItem({ measurement, index, onDelete }: MeasurementItemProps) {
  return (
    <div className="flex items-center justify-between bg-muted/50 rounded px-2 py-0.5 text-xs">
      <span className="text-muted-foreground text-xs">#{index + 1}</span>
      <span className="font-mono font-medium">{formatDistance(measurement.distance)}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="h-4 w-4 hover:bg-destructive/20"
        onClick={() => onDelete(measurement.id)}
      >
        <X className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}
