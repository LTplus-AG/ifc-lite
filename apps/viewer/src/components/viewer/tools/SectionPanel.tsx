/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane controls panel
 */

import React, { useCallback, useState } from 'react';
import { X, Slice, ChevronDown, FileImage, FlipHorizontal2 } from 'lucide-react';
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
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const drawingPanelVisible = useViewerStore((s) => s.drawing2DPanelVisible);
  const clearDrawing = useViewerStore((s) => s.clearDrawing2D);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);

  const handleClose = useCallback(() => {
    setActiveTool('select');
  }, [setActiveTool]);

  const handleAxisChange = useCallback((axis: 'down' | 'front' | 'side') => {
    setSectionPlaneAxis(axis);
  }, [setSectionPlaneAxis]);

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
                {AXIS_INFO[sectionPlane.axis].label} <span className="inline-block w-12 text-right tabular-nums">{sectionPlane.position.toFixed(1)}%</span>
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
            {/* Direction Selection */}
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Direction</div>
              <div className="flex gap-1">
                {(['down', 'front', 'side'] as const).map((axis) => (
                  <Button
                    key={axis}
                    variant={sectionPlane.axis === axis ? 'default' : 'outline'}
                    size="sm"
                    className="flex-1 flex-col h-auto py-1.5"
                    onClick={() => handleAxisChange(axis)}
                  >
                    <span className="text-xs font-medium">{AXIS_INFO[axis].label}</span>
                  </Button>
                ))}
              </div>
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
          {sectionPlane.enabled
            ? `Cut ${AXIS_INFO[sectionPlane.axis].label.toLowerCase()} at ${sectionPlane.position.toFixed(1)}%${sectionPlane.flipped ? ' (flipped)' : ''}`
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
