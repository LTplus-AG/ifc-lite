/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure tool panel UI (measurement list, controls)
 */

import React, { useCallback, useState, useEffect, useMemo } from 'react';
import { X, Trash2, Ruler, ChevronDown, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore, type Measurement } from '@/store';
import { MeasurementOverlays } from './MeasurementVisuals';
import { formatDistance } from './formatDistance';
import { useDraggablePanel } from '@/hooks/useDraggablePanel';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import {
  ifcOriginViewerPoint,
  mapCoordinateDecimals,
  viewerPointToProjected,
  type ProjectedPoint,
  type UsableEffectiveGeoref,
} from '@/lib/geo/pick-to-geo';
import { reprojectPointToLatLon, type LatLon } from '@/lib/geo/reproject';

/** Live E/N/H readout bound to one anchor georef (issue #1657). */
interface GeoReadout {
  effective: UsableEffectiveGeoref;
  toProjected: (p: { x: number; y: number; z: number }) => ProjectedPoint;
  format: (v: number) => string;
}

/**
 * Reproject a picked point's E/N to WGS84 lat/lon asynchronously (proj4).
 * Returns null until the projection resolves; the E/N/H readout never blocks
 * on it. Quantised to ~mm so hover jitter doesn't spam proj4.
 */
function useProjectedLatLon(
  projected: ProjectedPoint | null,
  effective: UsableEffectiveGeoref | null,
): LatLon | null {
  const [latLon, setLatLon] = useState<LatLon | null>(null);
  const key = projected
    ? `${Math.round(projected.eastings * 1000)}:${Math.round(projected.northings * 1000)}`
    : '';
  const crsName = effective?.projectedCRS.name ?? '';
  useEffect(() => {
    if (!projected || !effective) {
      setLatLon(null);
      return;
    }
    let cancelled = false;
    void reprojectPointToLatLon(
      projected.eastings,
      projected.northings,
      effective.projectedCRS,
      effective.lengthUnitScale,
    ).then((r) => {
      if (!cancelled) setLatLon(r);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, crsName]);
  return latLon;
}

export function MeasureOverlay() {
  const measurements = useViewerStore((s) => s.measurements);
  const pendingMeasurePoint = useViewerStore((s) => s.pendingMeasurePoint);
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const snapTarget = useViewerStore((s) => s.snapTarget);
  const snapVisualization = useViewerStore((s) => s.snapVisualization);
  const snapEnabled = useViewerStore((s) => s.snapEnabled);
  const measurementConstraintEdge = useViewerStore((s) => s.measurementConstraintEdge);
  const toggleSnap = useViewerStore((s) => s.toggleSnap);
  const measureGeoEnabled = useViewerStore((s) => s.measureGeoEnabled);
  const toggleMeasureGeo = useViewerStore((s) => s.toggleMeasureGeo);
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

  // Georef-aware XYZ readout (issue #1657): convert picked viewer points to
  // projected E/N/H via the ANCHOR model's effective IfcMapConversion.
  // Hidden entirely when no loaded model carries a usable map georef.
  const anchorGeoref = useAnchorGeoreference();
  const geo = useMemo<GeoReadout | null>(() => {
    if (!anchorGeoref) return null;
    const { effective } = anchorGeoref;
    const origin = ifcOriginViewerPoint(effective.coordinateInfo);
    const decimals = mapCoordinateDecimals(effective.projectedCRS, effective.lengthUnitScale);
    return {
      effective,
      toProjected: (p: { x: number; y: number; z: number }): ProjectedPoint =>
        viewerPointToProjected(p, effective, origin),
      format: (v: number) => v.toFixed(decimals),
    };
  }, [anchorGeoref]);
  const geoActive = measureGeoEnabled && geo !== null;

  // Live point priority: drag current > hover snap > legacy pending point.
  const livePoint = activeMeasurement?.current ?? snapTarget?.position ?? pendingMeasurePoint;
  const liveProjected = geoActive && geo && livePoint ? geo.toProjected(livePoint) : null;
  const liveLatLon = useProjectedLatLon(liveProjected, geoActive && geo ? geo.effective : null);

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
                    geo={geoActive ? geo : null}
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

      {/* Live geo readout for the current point - brutalist style */}
      {geo && liveProjected && (
        <div className="pointer-events-none absolute bottom-28 left-1/2 -translate-x-1/2 z-30 bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1 border-2 border-zinc-900 dark:border-zinc-100 font-mono text-[10px] leading-tight whitespace-nowrap text-center">
          <div>
            E {geo.format(liveProjected.eastings)} N {geo.format(liveProjected.northings)} H {geo.format(liveProjected.height)}
          </div>
          <div className="opacity-60">
            {liveProjected.crsName}
            {liveLatLon ? ` | lat ${liveLatLon.lat.toFixed(6)} lon ${liveLatLon.lon.toFixed(6)}` : ''}
          </div>
        </div>
      )}

      {/* Snap + XYZ Geo toggles - brutalist style */}
      <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex gap-1">
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
        {geo && (
          <button
            onClick={toggleMeasureGeo}
            className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider border-2 transition-colors ${
              measureGeoEnabled
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 border-zinc-300 dark:border-zinc-700'
            }`}
            title="Show map coordinates (Eastings/Northings/orthogonal Height)"
          >
            XYZ Geo {measureGeoEnabled ? 'On' : 'Off'}
          </button>
        )}
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
  geo: GeoReadout | null;
}

function MeasurementItem({ measurement, index, onDelete, geo }: MeasurementItemProps) {
  return (
    <div className="bg-muted/50 rounded px-2 py-0.5 text-xs">
      <div className="flex items-center justify-between">
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
      {geo && (
        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground leading-tight overflow-x-auto">
          <GeoEndpoint label="A" point={measurement.start} geo={geo} />
          <GeoEndpoint label="B" point={measurement.end} geo={geo} />
        </div>
      )}
    </div>
  );
}

/** One measurement endpoint's E/N/H in the anchor CRS map unit. */
function GeoEndpoint({
  label,
  point,
  geo,
}: {
  label: string;
  point: { x: number; y: number; z: number };
  geo: GeoReadout;
}) {
  const p = geo.toProjected(point);
  return (
    <div className="whitespace-nowrap">
      {label} E {geo.format(p.eastings)} N {geo.format(p.northings)} H {geo.format(p.height)}
    </div>
  );
}
