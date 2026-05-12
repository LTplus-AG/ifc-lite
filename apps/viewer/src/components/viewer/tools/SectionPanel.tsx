/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane controls panel
 */

import React, { useCallback, useEffect, useState } from 'react';
import { X, Slice, ChevronDown, FileImage, FlipHorizontal2, MousePointerClick, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { AXIS_INFO } from './sectionConstants';
import { SectionPlaneVisualization } from './SectionVisualization';
import { SectionCapControls } from './SectionCapControls';

export function SectionOverlay() {
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const toggleSectionPlane = useViewerStore((s) => s.toggleSectionPlane);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  // Face-pick + custom plane actions (issue #243).
  const sectionPickMode = useViewerStore((s) => s.sectionPickMode);
  const setSectionPickMode = useViewerStore((s) => s.setSectionPickMode);
  const setSectionCustomDistance = useViewerStore((s) => s.setSectionCustomDistance);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const drawingPanelVisible = useViewerStore((s) => s.drawing2DPanelVisible);
  const clearDrawing = useViewerStore((s) => s.clearDrawing2D);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);
  const isCustom = sectionPlane.custom !== undefined;

  const handleClose = useCallback(() => {
    setActiveTool('select');
  }, [setActiveTool]);

  const handleAxisChange = useCallback((axis: 'down' | 'front' | 'side') => {
    setSectionPlaneAxis(axis);
  }, [setSectionPlaneAxis]);

  // Toggle the "next click picks a face" arming. The actual click is
  // intercepted in `selectionHandlers.ts`, which calls
  // `setSectionPlaneFromFace` and clears pick mode for us. (issue #243)
  const handleTogglePickMode = useCallback(() => {
    setSectionPickMode(!sectionPickMode);
  }, [sectionPickMode, setSectionPickMode]);

  // "Reset to axis" in custom mode — clearing the custom field via
  // setSectionPlaneAxis re-uses the existing cardinal pathway. We pick
  // the nearest cardinal that's already in `axis` (kept in sync at pick
  // time) so the user lands on the closest preset they had before.
  const handleResetToAxis = useCallback(() => {
    setSectionPlaneAxis(sectionPlane.axis);
  }, [sectionPlane.axis, setSectionPlaneAxis]);

  const handleCustomDistanceChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setSectionCustomDistance(v);
  }, [setSectionCustomDistance]);

  const handlePositionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isNaN(value)) {
      setSectionPlanePosition(value);
    }
  }, [setSectionPlanePosition]);

  // Section-plane drag preview: while the user is actively dragging
  // the position slider, render the splat shader at 1/4 density so
  // huge scans (>10M points) keep up. Restored on release.
  const handleSliderDragStart = useCallback(() => {
    if (pointCloudAssetCount > 0) setPreviewStride(4);
  }, [setPreviewStride, pointCloudAssetCount]);
  const handleSliderDragEnd = useCallback(() => {
    setPreviewStride(1);
  }, [setPreviewStride]);
  // Reset stride if the panel disappears mid-drag (e.g. user closes
  // the section tool without releasing the slider). Without this the
  // store can stay stuck at 4 and keep scans thinned indefinitely.
  useEffect(() => {
    return () => setPreviewStride(1);
  }, [setPreviewStride]);

  // Auto-arm face-pick when the Section tool opens (issue #243 follow-up).
  // Bonsai/Revit-style point-and-cut is the better default workflow now that
  // hover-preview (#84) lands the violet quad on dwell — user opens tool →
  // hover surface → click → cut. Cardinal axis buttons remain available as
  // a secondary affordance below.
  //
  // The 200ms timeout debounces the click that opened the tool: without it
  // the tool-open click bleeds through to the canvas pick handler and
  // accidentally sections the floor on the very same frame the panel
  // mounts. Cleanup disarms on unmount so leaving the tool doesn't leave
  // pick mode armed for the next tool.
  useEffect(() => {
    const t = setTimeout(() => setSectionPickMode(true), 200);
    return () => {
      clearTimeout(t);
      setSectionPickMode(false);
    };
  }, [setSectionPickMode]);

  const togglePanel = useCallback(() => {
    setIsPanelCollapsed(prev => !prev);
  }, []);

  const handleView2D = useCallback(() => {
    // Clear existing drawing to force regeneration with current settings
    clearDrawing();
    setDrawingPanelVisible(true);
  }, [clearDrawing, setDrawingPanelVisible]);

  return (
    <>
      {/* Compact Section Tool Panel - matches Measure tool style */}
      <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 bg-background/95 backdrop-blur-sm rounded-lg border shadow-lg z-30">
        {/* Header - always visible */}
        <div className="flex items-center justify-between gap-2 p-2">
          <button
            onClick={togglePanel}
            className="flex items-center gap-2 hover:bg-accent/50 rounded px-2 py-1 transition-colors"
          >
            <Slice className="h-4 w-4 text-primary" />
            <span className="font-medium text-sm">Section</span>
            {sectionPlane.enabled && (
              <span className="text-xs text-primary font-mono">
                {isCustom
                  ? <>Custom <span className="inline-block w-16 text-right tabular-nums">{sectionPlane.custom!.distance.toFixed(2)}m</span></>
                  : <>{AXIS_INFO[sectionPlane.axis].label} <span className="inline-block w-12 text-right tabular-nums">{sectionPlane.position.toFixed(1)}%</span></>
                }
              </span>
            )}
            <ChevronDown className={`h-3 w-3 transition-transform ${isPanelCollapsed ? '-rotate-90' : ''}`} />
          </button>
          <div className="flex items-center gap-1">
            {/* Only show 2D button when panel is closed */}
            {!drawingPanelVisible && (
              <Button variant="ghost" size="icon-sm" onClick={handleView2D} title="Open 2D Drawing Panel">
                <FileImage className="h-3 w-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={handleClose} title="Close">
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Expandable content */}
        {!isPanelCollapsed && (
          <div className="border-t px-3 pb-3 min-w-72">
            {/* Direction Selection. "Pick face" is the primary affordance —
                face-pick auto-arms on tool open (issue #243 follow-up) and
                matches Bonsai/Revit point-and-cut UX. Cardinal presets are
                demoted to a secondary row below for power users who want
                an axis-aligned cut without picking a surface. */}
            <div className="mt-3">
              <Button
                variant={sectionPickMode || isCustom ? 'default' : 'outline'}
                size="sm"
                className="w-full flex-col h-auto py-1.5"
                onClick={handleTogglePickMode}
                aria-pressed={sectionPickMode}
                title={
                  sectionPickMode
                    ? 'Click any face in the viewport to cut through it'
                    : 'Pick a face to cut through (Bonsai-style)'
                }
              >
                <span className="text-xs font-medium flex items-center gap-1">
                  <MousePointerClick className="h-3 w-3" />
                  {sectionPickMode ? 'Click a face to cut…' : isCustom ? 'Custom (pick again)' : 'Pick face'}
                </span>
              </Button>
              <div className="mt-2 text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">or pick an axis</div>
              <div className="flex gap-1">
                {(['down', 'front', 'side'] as const).map((axis) => (
                  <Button
                    key={axis}
                    variant={!isCustom && sectionPlane.axis === axis ? 'secondary' : 'ghost'}
                    size="sm"
                    className="flex-1 h-7 px-2 text-[11px]"
                    onClick={() => handleAxisChange(axis)}
                  >
                    <span className="font-normal">{AXIS_INFO[axis].label}</span>
                  </Button>
                ))}
              </div>
              {isCustom && (
                <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-muted-foreground bg-muted/50 rounded px-2 py-1">
                  <span title="Custom plane normal (world-space unit vector)">
                    n=({sectionPlane.custom!.normal.map((v) => v.toFixed(2)).join(', ')})
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleResetToAxis}
                    title="Reset to nearest cardinal axis"
                    className="h-5 w-5"
                  >
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>

            {/* Position. In cardinal mode this is a 0..100% slider along the
                axis. In custom mode (issue #243) the numeric input becomes
                a precise signed distance in world units along the picked
                normal; the slider still works (it shifts the plane by a
                small amount along the normal — see sectionSlice). */}
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {isCustom ? 'Distance (m)' : 'Position'}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant={sectionPlane.flipped ? 'default' : 'ghost'}
                    size="icon-sm"
                    onClick={flipSectionPlane}
                    aria-pressed={sectionPlane.flipped}
                    aria-label={sectionPlane.flipped ? 'Unflip cut direction' : 'Flip cut direction'}
                    title={sectionPlane.flipped ? 'Cut direction is flipped' : 'Flip cut direction'}
                  >
                    <FlipHorizontal2 className="h-3 w-3" />
                  </Button>
                  {isCustom ? (
                    <input
                      type="number"
                      step="0.05"
                      value={sectionPlane.custom!.distance.toFixed(3)}
                      onChange={handleCustomDistanceChange}
                      aria-label="Section plane distance along picked normal (world units)"
                      className="w-20 text-xs font-mono bg-muted px-1.5 py-0.5 rounded border-none text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  ) : (
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={sectionPlane.position}
                      onChange={handlePositionChange}
                      aria-label="Section plane position percentage"
                      className="w-16 text-xs font-mono bg-muted px-1.5 py-0.5 rounded border-none text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  )}
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="0.1"
                value={sectionPlane.position}
                onChange={handlePositionChange}
                onPointerDown={handleSliderDragStart}
                onPointerUp={handleSliderDragEnd}
                // pointercancel + blur cover the cases where the
                // browser steals capture (touch scroll, OS gesture)
                // or the user tabs away without releasing — the
                // store would otherwise stay at stride 4.
                onPointerCancel={handleSliderDragEnd}
                onBlur={handleSliderDragEnd}
                onKeyDown={handleSliderDragStart}
                onKeyUp={handleSliderDragEnd}
                aria-label="Section plane position slider"
                className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* Cap surface controls (hatch, colour, spacing) */}
            <SectionCapControls />

            {/* Show 2D panel button - only when panel is closed */}
            {!drawingPanelVisible && (
              <div className="mt-3 pt-3 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleView2D}
                >
                  <FileImage className="h-4 w-4 mr-2" />
                  Open 2D Drawing
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Instruction hint - brutalist style matching Measure tool */}
      <div
        className="pointer-events-auto absolute bottom-16 left-1/2 -translate-x-1/2 z-30 bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 border-2 border-zinc-900 dark:border-zinc-100 transition-shadow duration-150"
        style={{
          boxShadow: sectionPlane.enabled
            ? '4px 4px 0px 0px #03A9F4' // Light blue shadow when active
            : '3px 3px 0px 0px rgba(0,0,0,0.3)'
        }}
      >
        <span className="font-mono text-xs uppercase tracking-wide">
          {sectionPickMode
            ? 'Hover a surface to preview, click to cut'
            : sectionPlane.enabled
              ? isCustom
                ? `Custom cut at d=${sectionPlane.custom!.distance.toFixed(2)}m${sectionPlane.flipped ? ' (flipped)' : ''}`
                : `Cut ${AXIS_INFO[sectionPlane.axis].label.toLowerCase()} at ${sectionPlane.position.toFixed(1)}%${sectionPlane.flipped ? ' (flipped)' : ''}`
              : 'Clip off — drag slider to cut'}
        </span>
      </div>

      {/* Enable toggle — when OFF the model is not clipped even though the
          plane visual is shown. Label is explicit so users don't mistake
          "Preview" for "nothing will happen". */}
      <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
        <button
          onClick={toggleSectionPlane}
          className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider border-2 transition-colors ${
            sectionPlane.enabled
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 border-zinc-300 dark:border-zinc-700'
          }`}
          title={sectionPlane.enabled ? 'Click to disable the cut' : 'Click to enable the cut'}
        >
          {sectionPlane.enabled ? 'Clipping' : 'Clip off'}
        </button>
      </div>

      {/* Section plane visualization overlay */}
      <SectionPlaneVisualization axis={sectionPlane.axis} enabled={sectionPlane.enabled} />
    </>
  );
}
