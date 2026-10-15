/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The second row of the Section bar (#7545): what the ACTIVE plane is doing.
 * Its offset (typed, scrubbed, stepped by `− +`, the arrow keys or the wheel, in
 * the project unit, from the plane's datum) with the step it moves by and the
 * storeys as snap ticks; Flip, Set view and Show; Fill, Cap and Cut; the box's
 * size and Fit; the alignment picker; and the 2D section. Row 1 says which planes
 * exist; this row edits the one that is selected, so no control has to say which
 * plane it means.
 */

import { useCallback } from 'react';
import { ChevronDown, Eye, EyeOff, FlipHorizontal2, Focus, Layers, Minus, PaintBucket, PencilRuler, Plus, Slice } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  HudPopover,
  HudPopoverContent,
  HudPopoverTrigger,
  HudValueField,
} from '../../viewport-ui/hud';
import { HudDivider, HudToggle } from '../../viewport-ui/hud/HudToggle';
import { SectionCapControls } from './SectionCapControls';
import { STOREY_SNAP_TOLERANCE_M } from './useSectionDistance';
import { useSectionOffset } from './useSectionOffset';
import { useSectionFill } from './useSectionFill';
import { SectionStepMenu } from './SectionStepMenu';
import { SectionSetViewButton } from './SectionSetViewButton';
import { SectionZoomMenu } from './SectionZoomMenu';
import { useLiveTestId } from './SectionBarMeasure';
import { storeyCutElevation } from '@/lib/section/section-distance';
import { sectionBoxFromBounds, sectionBoxSize } from '@/lib/section/section-box';
import { AlignmentSectionControls } from './AlignmentSectionControls';
import { useAlignmentToolState } from '@/lib/section/alignment-controller';

/** One unbreakable run of controls on the bar. */
const GROUP = 'flex items-center gap-1';
/** A one-shot action on the bar (Cap, Fit): muted at rest, the chrome accent on hover/open. */
/** The `−` / `+` beside the offset. */
const STEPPER = 'inline-flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40';
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

/** `compact`: icons only (every control keeps its name and title), for a narrow top-center lane. */
export function SectionActivePlaneRow({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  /** A control's word, or nothing in the compact form. */
  const word = (key: Parameters<typeof t>[0]) => (compact ? null : t(key));
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const toggleSectionPlane = useViewerStore((s) => s.toggleSectionPlane);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  const openPanelInHome = useViewerStore((s) => s.openPanelInHome);
  const toggleBottomPanel = useViewerStore((s) => s.toggleBottomPanel);
  const clearDrawing = useViewerStore((s) => s.clearDrawing2D);
  const drawingOpen = useViewerStore(selectDrawingPanelOpen);
  const setPreviewStride = useViewerStore((s) => s.setPointCloudPreviewStride);
  const pointCloudAssetCount = useViewerStore((s) => s.pointCloudAssetCount);
  const setSectionBox = useViewerStore((s) => s.setSectionBox);
  const hasSelection = useViewerStore((s) => s.selectedEntityId !== null || s.selectedEntityIds.size > 0);
  const offset = useSectionOffset();
  const distance = offset.distance;
  const fill = useSectionFill();
  const setShowGizmo = useViewerStore((s) => s.setSectionPlaneShowGizmo);
  const alignmentBusy = useAlignmentToolState(s => s.busy);
  // Test ids belong to the live bar only: the offscreen copies the tiers are measured from must not repeat them.
  const boxSizeTestId = useLiveTestId('section-box-size');
  const datumTestId = useLiveTestId('section-offset-datum');

  const isCustom = sectionPlane.custom !== undefined;
  const box = sectionPlane.box;

  // The box fits the selection when there is one (the same bounds Frame
  // uses, assemblies resolved to their parts), else the placed model bounds;
  // with neither known there is nothing to cut with, so the control stays.
  const fitBox = useCallback(() => {
    const selected = hasSelection ? useViewerStore.getState().cameraCallbacks.selectionBounds?.() : null;
    const next = sectionBoxFromBounds(selected) ?? sectionBoxFromBounds(distance.bounds);
    if (next) setSectionBox(next);
  }, [hasSelection, distance.bounds, setSectionBox]);

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
  const nudge = (direction: 1 | -1) => offset.onChange(Math.min(offset.max, Math.max(offset.min, offset.value + direction * offset.step)));
  const boxSize = box ? sectionBoxSize(box) : null;

  return (
    <>
      <AlignmentSectionControls />
      {boxSize ? (
        <span className={GROUP}>
          <HudDivider />
          <span title={t('sectionTool.box.sizeAria')} className="whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground" data-testid={boxSizeTestId}>
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
          <SectionZoomMenu compact={compact} />
        </span>
      ) : (
      <>
      <span className={GROUP}>
      <HudDivider />
      {!compact && <span className="px-0.5 text-2xs uppercase tracking-wide text-muted-foreground">{t('sectionPlanes.offset.label')}</span>}
      <button type="button" className={STEPPER} onClick={() => nudge(-1)} disabled={alignmentBusy} aria-label={t('sectionPlanes.offset.dec')} title={t('sectionPlanes.offset.dec')}>
        <Minus aria-hidden className="h-3 w-3" />
      </button>
      <HudValueField
        disabled={alignmentBusy}
        value={offset.value}
        onChange={offset.onChange}
        unit={offset.unit.symbol === '%' ? t('sectionTool.distance.percentUnit') : offset.unit.symbol === 'm' ? t('sectionTool.distance.unit') : offset.unit.symbol}
        step={offset.step}
        min={offset.min}
        max={offset.max}
        precision={offset.precision}
        wheelStep
        snaps={offset.snaps}
        snapTolerance={STOREY_SNAP_TOLERANCE_M / offset.unit.scale}
        onScrubStart={handleScrubStart}
        onScrubEnd={handleScrubEnd}
        aria-label={t(distance.kind === 'alignment' ? 'alignmentSection.distance' : isCustom ? 'sectionTool.distance.customAria' : 'sectionTool.distance.aria')}
        className="min-w-[5rem] justify-end"
      />
      <button type="button" className={STEPPER} onClick={() => nudge(1)} disabled={alignmentBusy} aria-label={t('sectionPlanes.offset.inc')} title={t('sectionPlanes.offset.inc')}>
        <Plus aria-hidden className="h-3 w-3" />
      </button>
      {offset.datum !== 'percent' && <span className="whitespace-nowrap text-2xs text-muted-foreground" data-testid={datumTestId}>{t(`sectionPlanes.offset.datum.${offset.datum}`)}</span>}
      <SectionStepMenu />
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
          <HudPopoverContent align="start" className="p-1" data-testid="section-storeys" aria-label={t('sectionTool.storeys.title')}>
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
      <span className={GROUP}>
      <HudDivider />
      <HudToggle
        pressed={sectionPlane.flipped}
        onPressedChange={flipSectionPlane}
        aria-label={t(sectionPlane.flipped ? 'sectionTool.unflipLabel' : 'sectionTool.flipLabel')}
        title={t(sectionPlane.flipped ? 'sectionTool.flippedTitle' : 'sectionTool.flipLabel')}
        icon={<FlipHorizontal2 aria-hidden className="h-3.5 w-3.5" />}
      >
        {word('sectionPlanes.flip.label')}
      </HudToggle>
      <SectionSetViewButton compact={compact} />
      <SectionZoomMenu compact={compact} />
      <HudToggle
        pressed={sectionPlane.showGizmo}
        aria-label={t('sectionPlanes.show.label')}
        onPressedChange={() => setShowGizmo(sectionPlane.id, !sectionPlane.showGizmo)}
        title={t(sectionPlane.showGizmo ? 'sectionPlanes.show.hideTitle' : 'sectionPlanes.show.showTitle')}
        icon={sectionPlane.showGizmo ? <Eye aria-hidden className="h-3.5 w-3.5" /> : <EyeOff aria-hidden className="h-3.5 w-3.5" />}
      >
        {word('sectionPlanes.show.label')}
      </HudToggle>
      </span>
      </>
      )}
      <span className={GROUP}>
      <HudDivider />
      {!box && (
        <HudToggle
          pressed={fill.on}
          aria-label={t('sectionPlanes.fill.label')}
          onPressedChange={fill.toggle}
          title={t(fill.on ? 'sectionPlanes.fill.offTitle' : 'sectionPlanes.fill.title')}
          icon={<PaintBucket aria-hidden className="h-3.5 w-3.5" />}
        >
          {word('sectionPlanes.fill.label')}
        </HudToggle>
      )}
      {!box && (
        <>
        <HudPopoverTrigger asChild>
          <button type="button" title={t('sectionTool.cap.title')} className={ACTION}>
            <Slice aria-hidden className="h-3.5 w-3.5" />
            {t('sectionTool.cap.label')}
            <ChevronDown aria-hidden className="h-3 w-3 opacity-70" />
          </button>
        </HudPopoverTrigger>
        <HudPopoverContent align="center" side="bottom" className="w-64" data-testid="section-cap-popover" aria-label={t('sectionTool.cap.label')}>
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
        aria-label={t('sectionTool.drawing.label')}
        onPressedChange={handleDrawing}
        title={t(drawingOpen ? 'sectionTool.drawing.closeTitle' : 'sectionTool.drawing.openTitle')}
        icon={<PencilRuler aria-hidden className="h-3.5 w-3.5" />}
      >
        {word('sectionTool.drawing.label')}
      </HudToggle>
      </span>
    </>
  );
}
