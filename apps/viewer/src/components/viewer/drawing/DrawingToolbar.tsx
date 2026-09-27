/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel's toolbar row (#5494): the markup tools as one segmented
 * control, the display toggles as chips, the settings drawers as labelled
 * toggles, and the zoom cluster. Replaces the icon row and its ~20-item
 * overflow menu. Width tiers: `wide` shows labels, `compact` collapses them
 * to icons, `narrow` moves only the rarest items (drawers, pin, clear) into
 * one short menu and drops the +/- zoom steps (wheel and pinch still zoom).
 */

import { Box, BoxSelect, Cloud, Eye, FileText, Hexagon, Layers, Maximize2, MoreHorizontal, MousePointer2, Palette, Pin, PinOff, Printer, Ruler, ScanLine, Shapes, Tag, Trash2, Type, ZoomIn, ZoomOut } from 'lucide-react';
import type { Annotation2DTool } from '@/store/slices/drawing2DSlice';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n/en';
import type { DrawingDrawer } from './useDrawingViewModel';
import { DrawerToggle, IconAction, ToggleChip, ToolSegment, ToolbarDivider } from './DrawingToolbarControls';

export type DrawingWidthTier = 'wide' | 'compact' | 'narrow';

const TOOLS: ReadonlyArray<{ tool: Annotation2DTool; icon: typeof Ruler; labelKey: TranslationKey }> = [
  { tool: 'none', icon: MousePointer2, labelKey: 'section2d.tools.select' },
  { tool: 'measure', icon: Ruler, labelKey: 'section2d.tools.distance' },
  { tool: 'polygon-area', icon: Hexagon, labelKey: 'section2d.tools.area' },
  { tool: 'text', icon: Type, labelKey: 'section2d.tools.text' },
  { tool: 'cloud', icon: Cloud, labelKey: 'section2d.tools.cloud' },
];

const DRAWERS: ReadonlyArray<{ id: DrawingDrawer; icon: typeof Palette; labelKey: TranslationKey }> = [
  { id: 'overrides', icon: Palette, labelKey: 'section2d.drawers.overrides' },
  { id: 'sheet', icon: FileText, labelKey: 'section2d.drawers.sheet' },
  { id: 'underlays', icon: Layers, labelKey: 'section2d.drawers.underlays' },
  { id: 'scan', icon: ScanLine, labelKey: 'section2d.drawers.scan' },
];

export interface DrawingToolbarProps {
  tier: DrawingWidthTier;
  activeTool: Annotation2DTool;
  onSelectTool: (tool: Annotation2DTool) => void;
  hasMarkup: boolean;
  onClearMarkup: () => void;
  display: { symbolic: boolean; ifcAnnotations: boolean; projection: boolean; overlay3D: boolean; printPreview: boolean };
  /** IFC annotations overlay only on plan (Down) cuts. */
  ifcAnnotationsAvailable: boolean;
  /** Construction projection is not available on a custom (face-picked) plane. */
  projectionAvailable: boolean;
  onToggleSymbolic: () => void;
  onToggleIfcAnnotations: () => void;
  onToggleProjection: () => void;
  onToggleOverlay3D: () => void;
  onTogglePrintPreview: () => void;
  openDrawer: DrawingDrawer | null;
  /** Per drawer: its feature is active (preset applied, sheet on, underlays loaded, scan shown). */
  drawerActivity: Record<DrawingDrawer, boolean>;
  onToggleDrawer: (drawer: DrawingDrawer) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  pinned: boolean;
  onTogglePinned: () => void;
}

export function DrawingToolbar(p: DrawingToolbarProps) {
  const { t } = useTranslation();
  const showLabels = p.tier === 'wide';
  const narrow = p.tier === 'narrow';
  const pinLabel = p.pinned ? t('section2d.pin.unpinTitle') : t('section2d.pin.pinTitle');

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b px-2 py-1">
      <div role="radiogroup" aria-label={t('section2d.tools.group')} className="inline-flex items-center gap-0.5 rounded-md bg-muted p-0.5">
        {TOOLS.map(({ tool, icon, labelKey }) => (
          <ToolSegment key={tool} icon={icon} label={t(labelKey)} active={p.activeTool === tool} showLabel={showLabels} onSelect={() => p.onSelectTool(tool)} />
        ))}
      </div>
      {p.hasMarkup && !narrow && (
        <IconAction icon={Trash2} label={t('section2d.annotations.clear')} onClick={p.onClearMarkup} />
      )}

      <ToolbarDivider />

      <div role="group" aria-label={t('section2d.display.group')} className="inline-flex items-center gap-1">
        <ToggleChip
          icon={p.display.symbolic ? Shapes : Box} label={t('section2d.display.symbolic')}
          tip={p.display.symbolic ? t('section2d.symbolic.planTitle') : t('section2d.symbolic.cutTitle')}
          on={p.display.symbolic} showLabel={showLabels} onToggle={p.onToggleSymbolic}
        />
        <ToggleChip
          icon={Tag} label={t('section2d.display.ifcAnnotations')}
          tip={!p.ifcAnnotationsAvailable ? t('section2d.display.ifcAnnotationsUnavailable')
            : p.display.ifcAnnotations ? t('section2d.ifcAnnotations.hideTitle') : t('section2d.ifcAnnotations.showTitle')}
          on={p.display.ifcAnnotations} disabled={!p.ifcAnnotationsAvailable} showLabel={showLabels} onToggle={p.onToggleIfcAnnotations}
        />
        <ToggleChip
          icon={BoxSelect} label={t('section2d.display.projection')}
          tip={!p.projectionAvailable ? t('section2d.display.projectionUnavailable')
            : p.display.projection ? t('section2d.construction.hideTitle') : t('section2d.construction.showTitle')}
          on={p.display.projection} disabled={!p.projectionAvailable} showLabel={showLabels} onToggle={p.onToggleProjection}
        />
        <ToggleChip
          icon={Eye} label={t('section2d.display.overlay3d')} tip={t('section2d.overlay.toggleTitle')}
          on={p.display.overlay3D} showLabel={showLabels} onToggle={p.onToggleOverlay3D}
        />
        <ToggleChip
          icon={Printer} label={t('section2d.display.printPreview')}
          tip={p.display.printPreview ? t('section2d.printPreview.hideTitle') : t('section2d.printPreview.showTitle')}
          on={p.display.printPreview} showLabel={showLabels} onToggle={p.onTogglePrintPreview}
        />
      </div>

      {!narrow && (
        <>
          <ToolbarDivider />
          <div role="group" aria-label={t('section2d.drawers.group')} className="inline-flex items-center gap-0.5">
            {DRAWERS.map(({ id, icon, labelKey }) => (
              <DrawerToggle key={id} icon={icon} label={t(labelKey)} open={p.openDrawer === id} dot={p.drawerActivity[id]} showLabel={showLabels} onToggle={() => p.onToggleDrawer(id)} />
            ))}
          </div>
        </>
      )}

      <div className="ml-auto inline-flex items-center gap-0.5">
        {!narrow && <IconAction icon={ZoomOut} label={t('section2d.zoom.out')} onClick={p.onZoomOut} />}
        {!narrow && (
          <span className="w-11 text-center text-xs tabular-nums text-muted-foreground" aria-label={t('section2d.zoom.level', { percent: p.zoomPercent })}>
            {p.zoomPercent}%
          </span>
        )}
        {!narrow && <IconAction icon={ZoomIn} label={t('section2d.zoom.in')} onClick={p.onZoomIn} />}
        <IconAction icon={Maximize2} label={t('section2d.zoom.fit')} onClick={p.onFit} />
        {!narrow && <IconAction icon={p.pinned ? Pin : PinOff} label={pinLabel} pressed={p.pinned} onClick={p.onTogglePinned} />}
        {narrow && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" className="h-6 w-6 text-muted-foreground" aria-label={t('section2d.more')}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 text-xs">
              {DRAWERS.map(({ id, icon: Icon, labelKey }) => (
                <DropdownMenuCheckboxItem key={id} checked={p.openDrawer === id} onCheckedChange={() => p.onToggleDrawer(id)} className="text-xs">
                  <Icon className="mr-2 h-3.5 w-3.5" />{t(labelKey)}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={p.pinned} onCheckedChange={p.onTogglePinned} className="text-xs">
                <Pin className="mr-2 h-3.5 w-3.5" />{t('section2d.pin.label')}
              </DropdownMenuCheckboxItem>
              {p.hasMarkup && (
                <DropdownMenuItem onClick={p.onClearMarkup} className="text-xs">
                  <Trash2 className="mr-2 h-3.5 w-3.5" />{t('section2d.annotations.clear')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
