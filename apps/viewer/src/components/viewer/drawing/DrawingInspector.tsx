/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel's inspector column (#5495): Overrides / Sheet / Underlays
 * / Scan as tabs BESIDE the canvas, replacing `DrawingSettingsPanel`,
 * `SheetSetupPanel`, `DxfUnderlayPanel` and `ScanSectionPanel`'s own
 * `w-72 border-l` drawers (and their own close-button headers — the active
 * tab now carries that). One persisted store field decides which tab is
 * open (`useDrawingViewModel`'s `openDrawer`/`toggleDrawer`/`closeDrawer`,
 * backed by `drawingInspectorSlice`); toggling the already-open tab in the
 * toolbar collapses the column.
 *
 * Resizable (drag the left edge) and collapsible; both persist. Below
 * `DRAWING_INSPECTOR_OVERLAY_BELOW` the Drawing panel itself is too narrow
 * for a beside column to leave a usable canvas — a floating Drawing window
 * or the mobile layout — so the inspector overlays the canvas as a sheet
 * instead; that is the one place this component covers the canvas, and only
 * there.
 */

import React, { useCallback, useRef } from 'react';
import { FileText, Layers, Palette, ScanLine } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n/en';
import { DrawingSettingsPanel } from '../DrawingSettingsPanel';
import { DxfUnderlayPanel } from '../DxfUnderlayPanel';
import { ScanSectionPanel } from '../ScanSectionPanel';
import { SheetSetupPanel } from '../SheetSetupPanel';
import type { DrawingDrawer, DrawingViewModel } from './useDrawingViewModel';
import type { useDrawingLayers } from './useDrawingLayers';

/** Below this the toolbar has already collapsed to icons (its own 'narrow'
 *  tier starts at 640px) and a column at even its MIN_WIDTH (240px) would
 *  leave the canvas too thin to read — a floating Drawing window or the
 *  mobile layout, not the normal docked case. The inspector overlays the
 *  canvas instead of squeezing it (#5495). */
export const DRAWING_INSPECTOR_OVERLAY_BELOW = 720;

const TABS: ReadonlyArray<{ id: DrawingDrawer; icon: typeof Palette; labelKey: TranslationKey }> = [
  { id: 'overrides', icon: Palette, labelKey: 'section2d.drawers.overrides' },
  { id: 'sheet', icon: FileText, labelKey: 'section2d.drawers.sheet' },
  { id: 'underlays', icon: Layers, labelKey: 'section2d.drawers.underlays' },
  { id: 'scan', icon: ScanLine, labelKey: 'section2d.drawers.scan' },
];

export interface DrawingInspectorProps {
  vm: DrawingViewModel;
  layers: ReturnType<typeof useDrawingLayers>;
  /** The Drawing panel's own measured width; drives the overlay fallback. */
  panelWidth: number;
}

export function DrawingInspector({ vm, layers, panelWidth }: DrawingInspectorProps): React.ReactElement | null {
  const { t } = useTranslation();
  const tab = vm.openDrawer;
  const width = useViewerStore((s) => s.drawingInspectorWidth);
  const setWidth = useViewerStore((s) => s.setDrawingInspectorWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };
    const move = (ev: PointerEvent) => {
      const drag = dragState.current;
      if (!drag) return;
      // The handle sits on the column's LEFT edge: dragging left (negative dx) widens it.
      setWidth(drag.startWidth - (ev.clientX - drag.startX));
    };
    const up = () => {
      dragState.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [width, setWidth]);

  if (!tab) return null;

  const overlay = panelWidth > 0 && panelWidth < DRAWING_INSPECTOR_OVERLAY_BELOW;

  const body = (
    <Tabs value={tab} onValueChange={(v) => vm.toggleDrawer(v as DrawingDrawer)} className="flex h-full flex-col overflow-hidden">
      <TabsList className="properties-tabs-list w-full shrink-0">
        {TABS.map(({ id, icon: Icon, labelKey }) => (
          <TabsTrigger
            key={id}
            value={id}
            title={t(labelKey)}
            className="properties-tab-trigger flex-1 min-w-0 uppercase text-2xs tracking-wide"
          >
            <Icon className="h-3 w-3 shrink-0 panel-compact-icon" />
            <span className="panel-compact-text">{t(labelKey)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TabsContent value="overrides" className="m-0 h-full">
          <DrawingSettingsPanel />
        </TabsContent>
        <TabsContent value="sheet" className="m-0 h-full">
          <SheetSetupPanel onOpenTitleBlockEditor={() => vm.setTitleBlockEditorVisible(true)} />
        </TabsContent>
        <TabsContent value="underlays" className="m-0 h-full">
          <DxfUnderlayPanel
            onCenterOnModel={layers.handleCenterDxfUnderlay}
            planViewActive={vm.sectionPlane.axis === 'down' && vm.sectionPlane.custom === undefined}
            georeferenceAvailable={layers.dxfGeoreferenceAvailable}
          />
        </TabsContent>
        <TabsContent value="scan" className="m-0 h-full">
          <ScanSectionPanel
            hasPointCloud={layers.scanSectionLayer.hasPointCloud}
            totalInBand={layers.scanSectionLayer.totalInBand}
            renderedCount={layers.scanSectionLayer.renderedCount}
          />
        </TabsContent>
      </div>
    </Tabs>
  );

  if (overlay) {
    // The narrow fallback: no room beside the canvas, so the inspector takes
    // the whole canvas area as a sheet instead of squeezing it unusable.
    return (
      <div className="panel-container absolute inset-0 z-20 flex flex-col bg-background">
        {body}
      </div>
    );
  }

  return (
    <div
      className="panel-container relative flex shrink-0 border-l bg-background"
      style={{ width }}
      data-drawing-inspector
    >
      <button
        type="button"
        aria-label={t('section2d.inspector.resizeLabel')}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-ew-resize touch-none"
        onPointerDown={handleResizeStart}
      />
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}
