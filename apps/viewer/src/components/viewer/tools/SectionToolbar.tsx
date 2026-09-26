/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's bar on the HUD's top-center region (#5499, charter
 * #5478 §6):
 *
 *   ✂ SECTION │ Down Front Side Face Box │ ⇅ │ +1.20 m ▾ │ Cap ▾ │ ◉ Cut │ 2D │ ✕
 *
 * One segmented axis control (face pick is its fourth segment, not a
 * separate mode; the section box its fifth, #5513), a scrubbable distance
 * in metres with the storeys as snap ticks and a storey menu, the cap
 * appearance behind the bar's one popover, a Cut toggle that replaces the
 * old CLIP ON/OFF chip, the Drawing panel and close. In box mode the
 * distance group reads the box's size and offers Fit (to the selection,
 * else the model); Cap hides, a box has no cap. Every control writes the
 * store; the bar holds no state of its own beyond the popovers' open flags.
 *
 * Registered as the `section` row's `Bar` in `TOOL_HUD`, so `ToolOverlays`
 * places it (top-center, order 0); this component never positions itself.
 */

import { useCallback } from 'react';
import { ChevronDown, FlipHorizontal2, Focus, Layers, PencilRuler, Scissors, Slice, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';
import { resetSectionToAxis } from '@/store/section-active';
import { useTranslation } from '@/i18n';
import { tourAnchor, TOUR_ANCHORS } from '@/lib/tours/anchors';
import { cn } from '@/lib/utils';
import {
  HudPopover,
  HudPopoverAnchor,
  HudPopoverContent,
  HudPopoverTrigger,
  HudSegmented,
  HudToolbar,
  HudValueField,
  type HudSegmentedOption,
} from '../../viewport-ui/hud';
import { HudDivider, HudToggle } from '../../viewport-ui/hud/HudToggle';
import { AXIS_INFO } from './sectionConstants';
import { SectionCapControls } from './SectionCapControls';
import { STOREY_SNAP_TOLERANCE_M, useSectionDistance } from './useSectionDistance';
import { storeyCutElevation } from '@/lib/section/section-distance';
import { sectionBoxFromBounds, sectionBoxSize } from '@/lib/section/section-box';
import type { SectionPlaneAxis } from '@/store/types';

type AxisSegment = SectionPlaneAxis | 'face' | 'box';

/** One unbreakable run of controls on the bar. */
const GROUP = 'flex items-center gap-1';
/** A one-shot action on the bar (Cap, Fit): muted at rest, the chrome accent on hover/open. */
const ACTION = 'inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground';

/** The Drawing panel counts as open when docked, floating or popped out. */
function selectDrawingPanelOpen(s: {
  drawing2DPanelVisible: boolean;
  floatingPanels: ReadonlyArray<{ id: string }>;
  poppedOutIds: readonly string[];
}): boolean {
  return (
    s.drawing2DPanelVisible ||
    s.floatingPanels.some((p) => p.id === 'drawing') ||
    s.poppedOutIds.includes('drawing')
  );
}

export function SectionToolbar() {
  const { t } = useTranslation();
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const sectionPickMode = useViewerStore((s) => s.sectionPickMode);
  const setSectionPickMode = useViewerStore((s) => s.setSectionPickMode);
  const toggleSectionPlane = useViewerStore((s) => s.toggleSectionPlane);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const openPanelInHome = useViewerStore((s) => s.openPanelInHome);
  const toggleBottomPanel = useViewerStore((s) => s.toggleBottomPanel);
  const clearDrawing = useViewerStore((s) => s.clearDrawing2D);
  const drawingOpen = useViewerStore(selectDrawingPanelOpen);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  const setSectionBox = useViewerStore((s) => s.setSectionBox);
  const hasSelection = useViewerStore((s) => s.selectedEntityId !== null || s.selectedEntityIds.size > 0);
  const distance = useSectionDistance();

  const isCustom = sectionPlane.custom !== undefined;
  const box = sectionPlane.box;
  // While pick mode is armed the user is "on" the Face segment even before a
  // face exists; a committed custom plane keeps it selected afterwards.
  const axisValue: AxisSegment = sectionPickMode || isCustom ? 'face' : box ? 'box' : sectionPlane.axis;

  const axes: HudSegmentedOption<AxisSegment>[] = [
    ...(['down', 'front', 'side'] as const).map((axis) => ({ value: axis, label: t(AXIS_INFO[axis].labelKey) })),
    {
      value: 'face',
      label: t('sectionTool.axis.face'),
      title: t(sectionPickMode ? 'sectionTool.pick.activeTitle' : 'sectionTool.pick.title'),
    },
    { value: 'box', label: t('sectionTool.axis.box'), title: t('sectionTool.box.title') },
  ];

  // The box fits the selection when there is one (the same bounds Frame
  // uses, assemblies resolved to their parts), else the placed model bounds;
  // with neither known there is nothing to cut with, so the segment stays.
  const fitBox = useCallback(() => {
    const selected = hasSelection ? useViewerStore.getState().cameraCallbacks.selectionBounds?.() : null;
    const next = sectionBoxFromBounds(selected) ?? sectionBoxFromBounds(distance.bounds);
    if (next) setSectionBox(next);
  }, [hasSelection, distance.bounds, setSectionBox]);

  // A cardinal segment is a cardinal cut (drops any face-picked plane and
  // disarms the pick); from a face-picked plane, its own axis keeps the side
  // on screen (#5644, `resetSectionToAxis`). The Face segment arms the next
  // click — again, from a custom plane, so "pick another face" is the same
  // gesture.
  const handleAxis = useCallback((next: AxisSegment) => {
    if (next === 'face') {
      setSectionPickMode(true);
      return;
    }
    if (sectionPickMode) setSectionPickMode(false);
    if (next === 'box') {
      fitBox();
      return;
    }
    resetSectionToAxis(useViewerStore.getState, next);
  }, [sectionPickMode, setSectionPickMode, fitBox]);

  // Scrubbing thins a loaded scan to a quarter of its points so a >10M-point
  // cloud keeps up with the drag; restored on release (and on unmount, by
  // `SectionOverlay`).
  const handleScrubStart = useCallback(() => {
    if (pointCloudAssetCount > 0) setPreviewStride(4);
  }, [pointCloudAssetCount, setPreviewStride]);
  const handleScrubEnd = useCallback(() => setPreviewStride(1), [setPreviewStride]);

  // The Drawing panel is a bottom-strip panel (#5493): opening goes through
  // the table so it replaces whichever bottom panel is docked; the drawing
  // is cleared first so it regenerates against the current cut.
  const handleDrawing = useCallback(() => {
    if (drawingOpen) {
      toggleBottomPanel('drawing');
      return;
    }
    clearDrawing();
    openPanelInHome('drawing');
  }, [drawingOpen, toggleBottomPanel, clearDrawing, openPanelInHome]);

  const showStoreys = !isCustom && sectionPlane.axis === 'down' && distance.kind === 'world' && distance.storeys.length > 0;
  const unit = distance.kind === 'percent' ? t('sectionTool.distance.percentUnit') : t('sectionTool.distance.unit');
  const boxSize = box ? sectionBoxSize(box) : null;

  // The Cap popover is anchored to the whole bar, not to its trigger: when
  // the bar wraps in a narrow top-center lane the trigger can sit on a
  // middle row, and a trigger-anchored popover then opens over the rows
  // below it (#5481). Anchored to the bar it always opens under the bar.
  return (
    <HudPopover>
    <HudPopoverAnchor asChild>
    <HudToolbar data-tool-bar="section" data-testid="section-toolbar" className="justify-center" {...tourAnchor(TOUR_ANCHORS.sectionPanel)}>
      {/* Grouped so a wrap (the HUD caps the top-center lane, #5503) breaks
          between groups — caption + axis, flip + distance, Cap + Cut,
          2D + close — never inside one. */}
      <span className={GROUP}>
        <span className="flex items-center gap-1 px-1 text-2xs font-medium uppercase tracking-wider text-muted-foreground">
          <Scissors aria-hidden className="h-3.5 w-3.5 text-overlay-accent" />
          {t('sectionTool.heading')}
        </span>
        <HudDivider />
        <HudSegmented options={axes} value={axisValue} onChange={handleAxis} aria-label={t('sectionTool.bar.axisAria')} />
      </span>
      {boxSize ? (
        <span className={GROUP}>
          <HudDivider />
          <span title={t('sectionTool.box.sizeAria')} className="whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground" data-testid="section-box-size">
            {t('sectionTool.box.size', { x: boxSize[0].toFixed(2), y: boxSize[1].toFixed(2), z: boxSize[2].toFixed(2) })}
          </span>
          <button
            type="button"
            onClick={fitBox}
            title={t(hasSelection ? 'sectionTool.box.fitSelectionTitle' : 'sectionTool.box.fitModelTitle')}
            className={ACTION}
          >
            <Focus aria-hidden className="h-3.5 w-3.5" />
            {t('sectionTool.box.fit')}
          </button>
        </span>
      ) : (
      <span className={GROUP}>
      <HudDivider />
      <HudToggle
        pressed={sectionPlane.flipped}
        onPressedChange={flipSectionPlane}
        aria-label={t(sectionPlane.flipped ? 'sectionTool.unflipLabel' : 'sectionTool.flipLabel')}
        title={t(sectionPlane.flipped ? 'sectionTool.flippedTitle' : 'sectionTool.flipLabel')}
        icon={<FlipHorizontal2 aria-hidden className="h-3.5 w-3.5" />}
      />
      <HudValueField
        value={distance.value}
        onChange={distance.onChange}
        unit={unit}
        step={distance.step}
        min={distance.min}
        max={distance.max}
        precision={2}
        snaps={distance.snaps}
        snapTolerance={STOREY_SNAP_TOLERANCE_M}
        onScrubStart={handleScrubStart}
        onScrubEnd={handleScrubEnd}
        aria-label={t(isCustom ? 'sectionTool.distance.customAria' : 'sectionTool.distance.aria')}
        className="min-w-[4.5rem] justify-end"
      />
      {showStoreys && (
        <HudPopover>
          <HudPopoverTrigger asChild>
            <button
              type="button"
              title={t('sectionTool.storeys.title')}
              aria-label={t('sectionTool.storeys.title')}
              className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            </button>
          </HudPopoverTrigger>
          <HudPopoverContent align="start" className="p-1" data-testid="section-storeys">
            <ul aria-label={t('sectionTool.storeys.aria')} className="max-h-64 overflow-y-auto">
              {distance.storeys.map((storey) => {
                const active = Math.abs(distance.value - storeyCutElevation(storey)) <= STOREY_SNAP_TOLERANCE_M;
                return (
                  <li key={`${storey.modelId}:${storey.expressId}`}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => distance.cutAtStorey(storey)}
                      className={cn(
                        'flex w-full items-center justify-between gap-4 rounded-sm px-2 py-1 text-left text-xs',
                        active ? 'bg-overlay-accent-soft text-overlay-accent' : 'hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <Layers aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
                        {storey.name}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {t('sectionTool.storeys.elevation', { elevation: storey.elevation.toFixed(2) })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </HudPopoverContent>
        </HudPopover>
      )}
      </span>
      )}
      <span className={GROUP}>
      <HudDivider />
      {!box && (
        <>
        <HudPopoverTrigger asChild>
          <button type="button" title={t('sectionTool.cap.title')} className={ACTION}>
            <Slice aria-hidden className="h-3.5 w-3.5" />
            {t('sectionTool.cap.label')}
            <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
          </button>
        </HudPopoverTrigger>
        <HudPopoverContent align="center" side="bottom" className="w-64" data-testid="section-cap-popover">
          <SectionCapControls />
        </HudPopoverContent>
        </>
      )}
      <HudToggle
        pressed={sectionPlane.enabled}
        onPressedChange={toggleSectionPlane}
        title={t(sectionPlane.enabled ? 'sectionTool.cut.onTitle' : 'sectionTool.cut.offTitle')}
        icon={<span aria-hidden className={cn('inline-block h-2 w-2 rounded-full border', sectionPlane.enabled ? 'border-overlay-accent bg-overlay-accent' : 'border-current')} />}
      >
        {t('sectionTool.cut.label')}
      </HudToggle>
      </span>
      <span className={GROUP}>
      <HudDivider />
      <HudToggle
        pressed={drawingOpen}
        onPressedChange={handleDrawing}
        title={t(drawingOpen ? 'sectionTool.drawing.closeTitle' : 'sectionTool.drawing.openTitle')}
        icon={<PencilRuler aria-hidden className="h-3.5 w-3.5" />}
      >
        {t('sectionTool.drawing.label')}
      </HudToggle>
      <Button variant="ghost" size="icon-sm" className="h-6 w-6" onClick={() => setActiveTool('select')} title={t('sectionTool.closeTitle')} aria-label={t('sectionTool.closeTitle')}>
        <X className="h-3.5 w-3.5" />
      </Button>
      </span>
    </HudToolbar>
    </HudPopoverAnchor>
    </HudPopover>
  );
}
