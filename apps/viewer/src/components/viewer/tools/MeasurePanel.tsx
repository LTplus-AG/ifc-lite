/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure tool panel UI (measurement list, controls)
 */

import React, { useCallback, useState, useEffect } from 'react';
import { X, Trash2, Ruler, ChevronDown, GripVertical, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore, type Measurement } from '@/store';
import { MeasurementOverlays } from './MeasurementVisuals';
import { formatDistance } from './formatDistance';
import { useDraggablePanel } from '@/hooks/useDraggablePanel';
import { useAnchorGeoreference, type AnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { viewerPointToProjected } from '@/lib/geo/pick-to-geo';
import { mapUnitsToMeters } from '@/lib/geo/cesium-placement';
import {
  reprojectPointToLatLon,
  reprojectionInputKey,
  type LatLon,
} from '@/lib/geo/reproject';

interface Vec3Like { x: number; y: number; z: number }
interface Enh { e: string; n: string; h: string }

/**
 * Project a picked viewer point to real-world Eastings/Northings/Height and
 * format it in the CRS's metre unit to millimetre precision. The stored
 * MapConversion offsets are in the authored map unit (millimetres for the
 * bundled sample), so we convert to metres with the anchor's map-unit scale —
 * the raw offsets would read ~1000x too large for a metre CRS.
 */
function projectedEnh(point: Vec3Like, anchor: AnchorGeoreference): Enh {
  const proj = viewerPointToProjected(point, anchor.eff, anchor.originViewer);
  const { projectedCRS, lengthUnitScale } = anchor.eff;
  return {
    e: mapUnitsToMeters(proj.eastings, projectedCRS, lengthUnitScale).toFixed(3),
    n: mapUnitsToMeters(proj.northings, projectedCRS, lengthUnitScale).toFixed(3),
    h: mapUnitsToMeters(proj.height, projectedCRS, lengthUnitScale).toFixed(3),
  };
}

/** One compact monospace E/N/H line, optionally labelled (A/B endpoints). */
function EnhLine({ label, enh }: { label?: string; enh: Enh }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10px] leading-tight text-muted-foreground whitespace-nowrap">
      {label && <span className="text-muted-foreground/60 w-3 shrink-0">{label}</span>}
      <span>E {enh.e}</span>
      <span>N {enh.n}</span>
      <span>H {enh.h}</span>
    </div>
  );
}

/**
 * Resolve a picked viewer point to WGS84 lat/lon asynchronously (proj4). The
 * synchronous E/N/H readout never blocks on this; lat/lon appears once the
 * projection resolves and is `null` for a CRS proj4 can't resolve (the line is
 * simply absent). The effect is keyed by a primitive derived from *all* inputs
 * the reprojection consumes (CRS name + projection metadata + unit scales +
 * quantised E/N) so it recomputes on any georef edit but not on unrelated
 * re-renders — see {@link reprojectionInputKey}.
 */
function useProjectedLatLon(
  point: Vec3Like | null,
  anchor: AnchorGeoreference | null,
): LatLon | null {
  const [latLon, setLatLon] = useState<LatLon | null>(null);
  const projected = point && anchor
    ? viewerPointToProjected(point, anchor.eff, anchor.originViewer)
    : null;
  const key = projected && anchor
    ? reprojectionInputKey(
        projected.eastings,
        projected.northings,
        anchor.eff.projectedCRS,
        anchor.eff.lengthUnitScale,
      )
    : '';

  useEffect(() => {
    if (!projected || !anchor) {
      setLatLon(null);
      return;
    }
    let cancelled = false;
    void reprojectPointToLatLon(
      projected.eastings,
      projected.northings,
      anchor.eff.projectedCRS,
      anchor.eff.lengthUnitScale,
    ).then((r) => {
      if (!cancelled) setLatLon(r);
    });
    return () => {
      cancelled = true;
    };
    // Keyed by the primitive `key` so unrelated re-renders don't refetch and a
    // georef change that alters the projection always does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return latLon;
}

export function MeasureOverlay() {
  const measurements = useViewerStore((s) => s.measurements);
  const pendingMeasurePoint = useViewerStore((s) => s.pendingMeasurePoint);
  const activeMeasurement = useViewerStore((s) => s.activeMeasurement);
  const snapTarget = useViewerStore((s) => s.snapTarget);
  const snapVisualization = useViewerStore((s) => s.snapVisualization);
  const snapEnabled = useViewerStore((s) => s.snapEnabled);
  const geoReadoutEnabled = useViewerStore((s) => s.geoReadoutEnabled);
  const toggleGeoReadout = useViewerStore((s) => s.toggleGeoReadout);
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

  // Real-world XYZ readout. `anchor` is non-null only when the georef anchor
  // model carries a usable IfcMapConversion (projected CRS + offsets, not a
  // bare IfcSite lat/lon), which gates the toggle and the readout.
  const anchor = useAnchorGeoreference();
  const showGeo = geoReadoutEnabled && anchor !== null;
  // Live point: the current drag endpoint while measuring, else the most
  // recently finalized endpoint. Drives the standalone readout box.
  const livePoint: Vec3Like | null = activeMeasurement?.current
    ?? (measurements.length > 0 ? measurements[measurements.length - 1].end : null);
  const liveEnh = showGeo && anchor && livePoint ? projectedEnh(livePoint, anchor) : null;
  // Async WGS84 lat/lon for the live point. Non-blocking: null until proj4
  // resolves (and stays null for an unresolvable CRS), so E/N/H is unaffected.
  const liveLatLon = useProjectedLatLon(showGeo ? livePoint : null, showGeo ? anchor : null);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const drag = useDraggablePanel(panelRef);

  // The Presentation dock (BasketPresentationDock) pins a persistent pill at
  // `bottom-4 z-30 left-1/2` and, when expanded, a tall card at the same
  // anchor. The measure hint + live readout sit ABOVE that anchor; their
  // bottom offset steps up while the dock is visible so neither ever overlaps
  // it. Mirrors the storey-name pill's bottom-4 -> bottom-28 shift in
  // ViewportOverlays. The Snap / Geo toggles used to live at this same
  // `bottom-4 left-1/2` anchor and collided with the pill outright (measured:
  // Presentation x 592-716 over Snap 567-633 + Geo XYZ 641-742); they now live
  // inside the draggable panel below, well clear of the bottom strip.
  const basketPresentationVisible = useViewerStore((s) => s.basketPresentationVisible);
  const hintBottomClass = basketPresentationVisible ? 'bottom-32' : 'bottom-16';
  const readoutBottomClass = basketPresentationVisible ? 'bottom-44' : 'bottom-28';

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

        {/* Snap + Geo toggles — live INSIDE the panel (top-anchored, draggable)
            so they clear the persistent Presentation pill at bottom-4. Always
            rendered, whether the panel is collapsed or expanded, so the
            controls are never hidden. */}
        <div className="flex items-center gap-1.5 border-t px-2 py-2">
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
          {/* Geo XYZ stays visible even with no usable georef so the feature is
              discoverable; it disables with an explanatory tooltip instead of
              vanishing (defect: users could not tell the feature existed). */}
          <button
            onClick={toggleGeoReadout}
            disabled={!anchor}
            className={`flex items-center gap-1 px-2 py-1 font-mono text-[10px] uppercase tracking-wider border-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              geoReadoutEnabled && anchor
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 border-zinc-300 dark:border-zinc-700'
            }`}
            title={
              anchor
                ? 'Toggle real-world XYZ (Eastings / Northings / Height)'
                : 'Requires map georeferencing (IfcMapConversion) in the model'
            }
          >
            <Globe className="h-3 w-3" />
            Geo XYZ {geoReadoutEnabled && anchor ? 'On' : 'Off'}
          </button>
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
                    geoAnchor={showGeo ? anchor : null}
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
        className={`pointer-events-auto absolute ${hintBottomClass} left-1/2 -translate-x-1/2 z-30 bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 border-2 border-zinc-900 dark:border-zinc-100 transition-shadow duration-150`}
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

      {/* Live real-world XYZ readout for the active / last point */}
      {liveEnh && anchor && (
        <div className={`pointer-events-none absolute ${readoutBottomClass} left-1/2 -translate-x-1/2 z-30 bg-background/95 backdrop-blur-sm border-2 border-primary/60 px-3 py-1.5 shadow-lg max-w-[92vw] overflow-x-auto`}>
          <div className="flex items-baseline gap-2">
            <Globe className="h-3 w-3 text-primary shrink-0 self-center" />
            <span className="font-mono text-[10px] uppercase tracking-wider text-primary shrink-0">
              {activeMeasurement ? 'Live' : 'Last'}
            </span>
            <div className="font-mono text-[11px] tabular-nums whitespace-nowrap">
              <span>E {liveEnh.e}</span>
              <span className="ml-2">N {liveEnh.n}</span>
              <span className="ml-2">H {liveEnh.h}</span>
              <span className="ml-2 text-muted-foreground">m</span>
            </div>
          </div>
          <div className="font-mono text-[9px] text-muted-foreground/80 mt-0.5 pl-5">
            {anchor.eff.projectedCRS.name}
          </div>
          {liveLatLon && (
            <div className="font-mono text-[10px] tabular-nums whitespace-nowrap text-muted-foreground mt-0.5 pl-5">
              Lat {liveLatLon.lat.toFixed(6)} / Lon {liveLatLon.lon.toFixed(6)}
            </div>
          )}
        </div>
      )}

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
  /** When set, show real-world E/N/H for the measurement's two endpoints. */
  geoAnchor: AnchorGeoreference | null;
}

function MeasurementItem({ measurement, index, onDelete, geoAnchor }: MeasurementItemProps) {
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
      {geoAnchor && (
        <div className="mt-0.5 overflow-x-auto">
          <EnhLine label="A" enh={projectedEnh(measurement.start, geoAnchor)} />
          <EnhLine label="B" enh={projectedEnh(measurement.end, geoAnchor)} />
        </div>
      )}
    </div>
  );
}
