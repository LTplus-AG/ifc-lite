/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane controls panel
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Slice, ChevronDown, FileImage, FlipHorizontal2, MousePointerClick, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { AXIS_INFO } from './sectionConstants';
import { SectionPlaneVisualization } from './SectionVisualization';
import { SectionCapControls } from './SectionCapControls';

// Visible margin so the panel can't be dragged fully off the 3D canvas.
const PANEL_DRAG_MARGIN_PX = 8;

export function SectionOverlay() {
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const sectionPickMode = useViewerStore((s) => s.sectionPickMode);
  const setSectionPlaneAxis = useViewerStore((s) => s.setSectionPlaneAxis);
  const setSectionPlanePosition = useViewerStore((s) => s.setSectionPlanePosition);
  const setSectionPickMode = useViewerStore((s) => s.setSectionPickMode);
  const toggleSectionPlane = useViewerStore((s) => s.toggleSectionPlane);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const drawingPanelVisible = useViewerStore((s) => s.drawing2DPanelVisible);
  const clearDrawing = useViewerStore((s) => s.clearDrawing2D);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);
  const isCustomPlane = sectionPlane.normal !== undefined;

  // Draggable panel state. `panelPos` is null until the user drags, at which
  // point we switch from the CSS-centred default to explicit pixel offsets
  // inside the 3D-area parent element.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startPx: { x: number; y: number };
    startPy: { x: number; y: number };
    rectW: number;
    rectH: number;
  } | null>(null);

  // Clamp the stored position back inside the parent rect on resize so a
  // panel dragged near the edge doesn't float off-screen when the viewport
  // shrinks (window resize, drawing panel opening, etc.).
  useEffect(() => {
    if (!panelPos) return;
    const el = panelRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    const panelRect = el.getBoundingClientRect();
    const maxX = Math.max(PANEL_DRAG_MARGIN_PX, parentRect.width - panelRect.width - PANEL_DRAG_MARGIN_PX);
    const maxY = Math.max(PANEL_DRAG_MARGIN_PX, parentRect.height - panelRect.height - PANEL_DRAG_MARGIN_PX);
    const clamped = {
      x: Math.min(maxX, Math.max(PANEL_DRAG_MARGIN_PX, panelPos.x)),
      y: Math.min(maxY, Math.max(PANEL_DRAG_MARGIN_PX, panelPos.y)),
    };
    if (clamped.x !== panelPos.x || clamped.y !== panelPos.y) {
      setPanelPos(clamped);
    }
    // We intentionally do NOT depend on panelPos here to avoid a feedback loop;
    // this runs whenever panelPos changes (React's normal effect schedule) and
    // the clamp is idempotent.

  }, [panelPos]);

  const handleDragPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only left-button drags; ignore right-click, touch pan, etc.
    if (e.button !== 0) return;
    const el = panelRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const parentRect = parent.getBoundingClientRect();
    const panelRect = el.getBoundingClientRect();
    const startPy = {
      x: panelRect.left - parentRect.left,
      y: panelRect.top - parentRect.top,
    };
    dragStateRef.current = {
      pointerId: e.pointerId,
      startPx: { x: e.clientX, y: e.clientY },
      startPy,
      rectW: parentRect.width,
      rectH: parentRect.height,
    };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    // Seed explicit position so subsequent pointermove updates are absolute,
    // not relative to the CSS-centred default.
    setPanelPos(startPy);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const el = panelRef.current;
    if (!el) return;
    const dx = e.clientX - drag.startPx.x;
    const dy = e.clientY - drag.startPx.y;
    const panelRect = el.getBoundingClientRect();
    const maxX = Math.max(PANEL_DRAG_MARGIN_PX, drag.rectW - panelRect.width - PANEL_DRAG_MARGIN_PX);
    const maxY = Math.max(PANEL_DRAG_MARGIN_PX, drag.rectH - panelRect.height - PANEL_DRAG_MARGIN_PX);
    setPanelPos({
      x: Math.min(maxX, Math.max(PANEL_DRAG_MARGIN_PX, drag.startPy.x + dx)),
      y: Math.min(maxY, Math.max(PANEL_DRAG_MARGIN_PX, drag.startPy.y + dy)),
    });
  }, []);

  const handleDragPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    dragStateRef.current = null;
  }, []);

  const handleClose = useCallback(() => {
    setActiveTool('select');
  }, [setActiveTool]);

  const handleAxisChange = useCallback((axis: 'down' | 'front' | 'side') => {
    // Re-selecting a preset also cancels any pending face-pick so the UI
    // doesn't stay in a half-armed state.
    setSectionPickMode(false);
    setSectionPlaneAxis(axis);
  }, [setSectionPlaneAxis, setSectionPickMode]);

  const handlePickFaceToggle = useCallback(() => {
    setSectionPickMode(!sectionPickMode);
  }, [sectionPickMode, setSectionPickMode]);

  const handlePositionChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isNaN(value)) {
      setSectionPlanePosition(value);
    }
  }, [setSectionPlanePosition]);

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
      {/* Compact Section Tool Panel - matches Measure tool style.
          Draggable within its parent (the 3D canvas area) via the grip on
          the header. Until first dragged the panel sits in the default
          centred position; `panelPos` flips it to explicit pixel offsets
          after the first drag. */}
      <div
        ref={panelRef}
        className={
          panelPos === null
            ? "pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 bg-background/95 backdrop-blur-sm rounded-lg border shadow-lg z-30"
            : "pointer-events-auto absolute bg-background/95 backdrop-blur-sm rounded-lg border shadow-lg z-30"
        }
        style={panelPos === null ? undefined : { top: `${panelPos.y}px`, left: `${panelPos.x}px` }}
      >
        {/* Header - always visible */}
        <div className="flex items-center justify-between gap-2 p-2">
          <div
            className="flex items-center text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing select-none touch-none"
            title="Drag to move panel"
            onPointerDown={handleDragPointerDown}
            onPointerMove={handleDragPointerMove}
            onPointerUp={handleDragPointerUp}
            onPointerCancel={handleDragPointerUp}
          >
            <GripVertical className="h-4 w-4" />
          </div>
          <button
            onClick={togglePanel}
            className="flex items-center gap-2 hover:bg-accent/50 rounded px-2 py-1 transition-colors"
          >
            <Slice className="h-4 w-4 text-primary" />
            <span className="font-medium text-sm">Section</span>
            {sectionPlane.enabled && (
              <span className="text-xs text-primary font-mono">
                {isCustomPlane ? 'Custom' : AXIS_INFO[sectionPlane.axis].label}{' '}
                <span className="inline-block w-12 text-right tabular-nums">{sectionPlane.position.toFixed(1)}%</span>
              </span>
            )}
            <ChevronDown className={`h-3 w-3 transition-transform ${isPanelCollapsed ? '-rotate-90' : ''}`} />
          </button>
          <div className="flex items-center gap-1">
            {/* Only show 2D button when panel is closed — and never for custom
                planes, where the drawing pipeline can't project correctly yet. */}
            {!drawingPanelVisible && !isCustomPlane && (
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
            {/* Direction Selection */}
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Direction</div>
              <div className="flex gap-1">
                {(['down', 'front', 'side'] as const).map((axis) => (
                  <Button
                    key={axis}
                    variant={!isCustomPlane && sectionPlane.axis === axis ? 'default' : 'outline'}
                    size="sm"
                    className="flex-1 flex-col h-auto py-1.5"
                    onClick={() => handleAxisChange(axis)}
                  >
                    <span className="text-xs font-medium">{AXIS_INFO[axis].label}</span>
                  </Button>
                ))}
              </div>
              <Button
                variant={sectionPickMode ? 'default' : isCustomPlane ? 'secondary' : 'outline'}
                size="sm"
                className="mt-1.5 w-full h-auto py-1.5"
                onClick={handlePickFaceToggle}
                aria-pressed={sectionPickMode}
                title={sectionPickMode
                  ? 'Click any face to cut through it'
                  : 'Pick any face in the model to cut through'}
              >
                <MousePointerClick className="h-3 w-3 mr-1.5" />
                <span className="text-xs font-medium">
                  {sectionPickMode ? 'Click a face…' : isCustomPlane ? 'Custom plane — pick again' : 'Pick face'}
                </span>
              </Button>
            </div>

            {/* Position Slider */}
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Position</div>
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
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="0.1"
                value={sectionPlane.position}
                onChange={handlePositionChange}
                aria-label="Section plane position slider"
                className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* Cap surface controls (hatch, colour, spacing) */}
            <SectionCapControls />

            {/* Show 2D panel button - only when panel is closed and the
                plane is a cardinal axis (the drawing pipeline doesn't yet
                support arbitrary normals). */}
            {!drawingPanelVisible && !isCustomPlane && (
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
            {isCustomPlane && (
              <div className="mt-3 pt-3 border-t text-[10px] text-muted-foreground leading-snug">
                2D drawing export is only available for the Down / Front / Side presets. Pick a preset to generate a plan/section.
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
          {sectionPlane.enabled
            ? `Cut ${isCustomPlane ? 'custom' : AXIS_INFO[sectionPlane.axis].label.toLowerCase()} at ${sectionPlane.position.toFixed(1)}%${sectionPlane.flipped ? ' (flipped)' : ''}`
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
      <SectionPlaneVisualization axis={sectionPlane.axis} enabled={sectionPlane.enabled} isCustom={isCustomPlane} />
    </>
  );
}
