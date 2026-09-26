/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch tool's HUD presence (#5503, charter #5478): what used to
 * be one self-positioned `top-4 left-1/2` card is now
 *
 *   - `SpaceSketchBar` — one `HudToolbar` (the `TOOL_HUD.spaceSketch.Bar`
 *     slot, placed top-center by `ToolOverlays`): draw mode, history, snap,
 *     the Options / Help `HudPopover`s, the confirm / done action, minimize
 *     and close — the TOOL's controls, kept short enough to sit between the
 *     top-left chips and the ViewCube. When the lane is too narrow for one
 *     row (#5975: 1600px and below with both side panels open) it steps
 *     down, as `useHudBarTier` measures: first history, snap and Help fold
 *     into one `MorePopover` and the heading text goes (the ribbon button
 *     and the plan card below already name the tool), then the confirm
 *     button shrinks to ✓ + count. It steps back up when a panel closes;
 *   - `SpaceSketchPlanCard` — the 2D plan canvas on the shared `HudSurface`,
 *     the next top-center item under the bar, with the PLAN's controls in
 *     its header row: storey, derive every storey, room tally, cleanup, fit;
 *   - `SpaceSketchHint` — the in-progress gesture hint or the live status
 *     line, bottom-center like every tool's hint;
 *   - `SpaceSketchParkedChip` — the minimized state as a top-left `HudChip`
 *     (the parked-tool convention), with a resume action.
 *
 * All presentational: the controller (`SpaceSketchOverlay`) owns the wasm
 * sessions and every piece of state and passes it down.
 */

import { useState, type ReactNode } from 'react';
import {
  X, Undo2, Redo2, Layers, Maximize, Magnet, SlidersHorizontal, HelpCircle, Eraser, Square, PenLine, Frame,
  Check, Minus, Building2, ChevronDown, MoreHorizontal,
} from 'lucide-react';
import type { BoundaryMode } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  HudChip, HudHint, HudItem, HudPopover, HudPopoverContent, HudPopoverTrigger, HudSegmented, HudSurface, HudToolbar,
  useHudBarTier,
} from '../../../viewport-ui/hud';
import { formatArea } from '../computePolygonArea';
import { OptionsPopover, HelpPopover, MorePopover, type OptionsPopoverProps } from './SpaceSketchPopovers';

const ICON_BTN =
  'inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:hover:bg-transparent';
const ICON_BTN_ACTIVE = 'bg-overlay-accent-soft text-overlay-accent hover:bg-overlay-accent-soft hover:text-overlay-accent';
const ICON = 'h-3.5 w-3.5';

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

export type DrawMode = 'free' | 'rect';

export interface SpaceSketchBarProps {
  /** A model to author spaces into exists (footprint is enabled). */
  canAuthor: boolean;
  drawMode: DrawMode;
  onDrawMode: (mode: DrawMode) => void;
  footprintArmed: boolean;
  onFootprint: () => void;
  /** Drafted rooms on the active storey (the armed-footprint warning names the count). */
  roomCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  snapToBuilding: boolean;
  onToggleSnap: () => void;
  optionsOpen: boolean;
  onOptionsOpenChange: (open: boolean) => void;
  /** A non-default option is set, so the Options trigger carries a dot. */
  optionsDirty: boolean;
  options: OptionsPopoverProps;
  helpOpen: boolean;
  onHelpOpenChange: (open: boolean) => void;
  needsConfirm: boolean;
  pendingRooms: number;
  pendingStoreys: number;
  onConfirm: () => void;
  onClose: () => void;
  onMinimize: () => void;
}

/** The bar's forms, widest first (#5975). `minimal` is never measured: it is
 *  what is left when neither wider form fits, and `HudToolbar` may still wrap
 *  it as the collision fallback. */
const TIER_FULL = 0;
const TIER_COMPACT = 1;
const TIER_MINIMAL = 2;
const OFFSCREEN = { position: 'fixed', top: -9999, left: -9999, visibility: 'hidden' } as const;

/**
 * The bar as rendered: the widest form that fits the top-center lane as one
 * row. The full and compact forms are also rendered offscreen, unwrapped and
 * hidden, only to be measured (`useHudBarTier`), so the bar can grow back
 * when room returns.
 */
export function SpaceSketchBar(p: SpaceSketchBarProps) {
  const { measureRef, tier } = useHudBarTier(TIER_MINIMAL);
  return (
    <>
      <div ref={measureRef(TIER_FULL)} aria-hidden="true" style={OFFSCREEN}>
        <SpaceSketchBarContent {...p} tier={TIER_FULL} measuring />
      </div>
      <div ref={measureRef(TIER_COMPACT)} aria-hidden="true" style={OFFSCREEN}>
        <SpaceSketchBarContent {...p} tier={TIER_COMPACT} measuring />
      </div>
      <SpaceSketchBarContent {...p} tier={tier} />
    </>
  );
}

/**
 * The bar's markup in one form (`SpaceSketchBar` picks it; tests force it).
 * `measuring` marks an offscreen copy: unwrapped, so it reports its one-row
 * width, and untagged (no `data-tool-bar`, no test ids), so no query ever finds it. The
 * visible bar keeps `HudToolbar`'s wrap as the last-resort collision fallback.
 */
export function SpaceSketchBarContent(p: SpaceSketchBarProps & { tier: number; measuring?: boolean }) {
  const { t } = useTranslation();
  const [moreOpen, setMoreOpen] = useState(false);
  const compact = p.tier >= TIER_COMPACT;
  const minimal = p.tier >= TIER_MINIMAL;
  const confirmLabel = p.needsConfirm
    ? p.pendingStoreys > 1
      ? t('spaceSketch.footer.confirmButtonMultiStorey', { count: p.pendingRooms, floors: p.pendingStoreys })
      : t('spaceSketch.footer.confirmButton', { count: p.pendingRooms })
    : t('spaceSketch.footer.doneButton');
  return (
    <HudToolbar
      className={cn('select-none', p.measuring && 'flex-nowrap')}
      data-tool-bar={p.measuring ? undefined : 'spaceSketch'}
      data-bar-tier={p.measuring ? undefined : p.tier}
    >
      {!compact && (
        <>
          <span className="flex items-center gap-1.5 whitespace-nowrap px-1.5 text-2xs font-medium uppercase tracking-wide text-overlay-ink-muted">
            <Layers aria-hidden className={ICON} />
            {t('spaceSketch.panel.heading')}
          </span>
          <Divider />
        </>
      )}
      <HudSegmented<DrawMode>
        aria-label={t('spaceSketch.bar.drawModeAria')}
        value={p.drawMode}
        onChange={p.onDrawMode}
        options={[
          { value: 'free', label: <PenLine aria-hidden className={ICON} />, ariaLabel: t('spaceSketch.tools.editTitle') },
          { value: 'rect', label: <Square aria-hidden className={ICON} />, ariaLabel: t('spaceSketch.tools.rectTitle') },
        ]}
      />
      <button type="button"
        className={cn(ICON_BTN, p.footprintArmed && 'bg-status-danger/15 text-status-danger hover:bg-status-danger/20 hover:text-status-danger')}
        onClick={p.onFootprint} disabled={!p.canAuthor}
        title={p.footprintArmed
          ? t('spaceSketch.tools.footprintArmedTitle', { count: p.roomCount })
          : t('spaceSketch.tools.footprintTitle')}>
        <Frame aria-hidden className={ICON} />
      </button>
      <Divider />
      {compact ? (
        <HudPopover
          open={moreOpen}
          onOpenChange={(open) => { setMoreOpen(open); if (open) p.onOptionsOpenChange(false); }}
        >
          <HudPopoverTrigger asChild>
            <button type="button" className={cn(ICON_BTN, moreOpen && ICON_BTN_ACTIVE)}
              title={t('spaceSketch.bar.moreTitle')} aria-label={t('spaceSketch.bar.moreTitle')}
              data-testid={p.measuring ? undefined : 'spaceSketch-more-trigger'}>
              <MoreHorizontal aria-hidden className={ICON} />
            </button>
          </HudPopoverTrigger>
          <HudPopoverContent align="end" className="w-64">
            <MorePopover
              canUndo={p.canUndo} canRedo={p.canRedo} onUndo={p.onUndo} onRedo={p.onRedo}
              snapToBuilding={p.snapToBuilding} onToggleSnap={p.onToggleSnap}
            />
          </HudPopoverContent>
        </HudPopover>
      ) : (
        <>
          <button type="button" className={ICON_BTN} onClick={p.onUndo} disabled={!p.canUndo} title={t('spaceSketch.tools.undoTitle')}>
            <Undo2 aria-hidden className={ICON} />
          </button>
          <button type="button" className={ICON_BTN} onClick={p.onRedo} disabled={!p.canRedo} title={t('spaceSketch.tools.redoTitle')}>
            <Redo2 aria-hidden className={ICON} />
          </button>
          <Divider />
          <button type="button" className={cn(ICON_BTN, p.snapToBuilding && ICON_BTN_ACTIVE)}
            onClick={p.onToggleSnap} aria-pressed={p.snapToBuilding}
            title={p.snapToBuilding ? t('spaceSketch.tools.snapOnTitle') : t('spaceSketch.tools.snapOffTitle')}>
            <Magnet aria-hidden className={ICON} />
          </button>
        </>
      )}
      <HudPopover open={p.optionsOpen} onOpenChange={p.onOptionsOpenChange}>
        <HudPopoverTrigger asChild>
          <button type="button" className={cn(ICON_BTN, 'relative', p.optionsOpen && ICON_BTN_ACTIVE)}
            title={t('spaceSketch.tools.optionsTitle')}>
            <SlidersHorizontal aria-hidden className={ICON} />
            {p.optionsDirty && <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-overlay-accent" />}
          </button>
        </HudPopoverTrigger>
        <HudPopoverContent align="end" className="w-64">
          <OptionsPopover {...p.options} />
        </HudPopoverContent>
      </HudPopover>
      {!compact && (
        <HudPopover open={p.helpOpen} onOpenChange={p.onHelpOpenChange}>
          <HudPopoverTrigger asChild>
            <button type="button" className={cn(ICON_BTN, p.helpOpen && ICON_BTN_ACTIVE)} title={t('spaceSketch.panel.helpTitle')}>
              <HelpCircle aria-hidden className={ICON} />
            </button>
          </HudPopoverTrigger>
          <HudPopoverContent align="end" className="w-72">
            <HelpPopover />
          </HudPopoverContent>
        </HudPopover>
      )}
      <Divider />
      <button
        type="button"
        className={cn(
          'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm px-2 text-xs font-medium',
          p.needsConfirm
            ? 'bg-overlay-accent text-overlay-halo hover:bg-overlay-accent/90'
            : 'border border-border text-foreground hover:bg-accent',
        )}
        onClick={p.needsConfirm ? p.onConfirm : p.onClose}
        title={p.needsConfirm ? t('spaceSketch.footer.confirmTitle') : t('spaceSketch.footer.closeToolTitle')}
        aria-label={minimal && p.needsConfirm ? confirmLabel : undefined}
      >
        {p.needsConfirm && <Check aria-hidden className={ICON} />}
        {/* Minimal: the count alone; the full label stays the accessible name. */}
        {minimal && p.needsConfirm ? <span className="tabular-nums">{p.pendingRooms}</span> : confirmLabel}
      </button>
      <button type="button" className={ICON_BTN} onClick={p.onMinimize} title={t('spaceSketch.panel.minimizeTitle')}>
        <Minus aria-hidden className={ICON} />
      </button>
      <button type="button" className={ICON_BTN} onClick={p.onClose} title={t('spaceSketch.panel.closeTitle')}>
        <X aria-hidden className={ICON} />
      </button>
    </HudToolbar>
  );
}

export interface SpaceSketchPlanCardProps {
  /** Canvas width in px; the card wraps it with its padding. */
  width: number;
  storeys: { id: number; name: string }[];
  storeyId: number | null;
  onStoreyChange: (id: number) => void;
  /** A model to author spaces into exists (derive-all is enabled). */
  canAuthor: boolean;
  derivingAll: boolean;
  onDeriveAll: () => void;
  roomCount: number;
  totalArea: number;
  canCleanup: boolean;
  onCleanup: () => void;
  canFit: boolean;
  onFit: () => void;
  children: ReactNode;
  unbounded: { count: number; boundaryMode: BoundaryMode } | null;
  diagnostics: { leak: number; failed: number } | null;
  resizeHandlers: Record<string, unknown>;
}

/** The plan canvas as the next top-center HUD item under the bar, with the plan's own controls in its header. */
export function SpaceSketchPlanCard(p: SpaceSketchPlanCardProps) {
  const { t } = useTranslation();
  const { width, children, unbounded, diagnostics, resizeHandlers } = p;
  return (
    <HudItem region="top-center" order={1} className="w-full">
      {/* Nominal width via `maxWidth`, so the HUD's lane cap can shrink the
          card (an explicit `width` would fix its min-content and defeat it). */}
      <HudSurface
        className="relative mx-auto select-none p-2"
        style={{ width: '100%', maxWidth: width + 16 }}
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        data-tool-card="spaceSketch"
      >
        <div className="mb-1.5 flex items-center gap-1 text-xs">
          <select
            className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-transparent px-1 text-xs text-foreground"
            value={p.storeyId ?? ''}
            onChange={(e) => p.onStoreyChange(Number(e.target.value))}
            disabled={!p.storeys.length}
            aria-label={t('spaceSketch.bar.storeyAria')}
          >
            {p.storeys.length
              ? p.storeys.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)
              : <option>{t('spaceSketch.panel.noModelOption')}</option>}
          </select>
          <button type="button" className={ICON_BTN} onClick={p.onDeriveAll} disabled={!p.canAuthor || p.derivingAll}
            title={t('spaceSketch.panel.deriveAllTitle')}>
            <Building2 aria-hidden className={ICON} />
          </button>
          <span className="ml-auto whitespace-nowrap px-1 text-2xs tabular-nums text-muted-foreground">
            {t('spaceSketch.panel.roomCount', { count: p.roomCount })} · {formatArea(p.totalArea)}
          </span>
          <button type="button" className={ICON_BTN} onClick={p.onCleanup} disabled={!p.canCleanup} title={t('spaceSketch.tools.cleanupTitle')}>
            <Eraser aria-hidden className={ICON} />
          </button>
          <button type="button" className={ICON_BTN} onClick={p.onFit} disabled={!p.canFit} title={t('spaceSketch.tools.fitTitle')}>
            <Maximize aria-hidden className={ICON} />
          </button>
        </div>
        {children}
        {unbounded && (
          <div className="mt-1.5 text-2xs leading-tight text-status-warn">
            {t('spaceSketch.footer.unboundedNotice', unbounded)}
          </div>
        )}
        {diagnostics && (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
            <span className="text-status-ok">{t('spaceSketch.footer.diag.bounds')}</span>
            <span className="text-status-danger">{t('spaceSketch.footer.diag.leak', { count: diagnostics.leak })}</span>
            <span className="text-status-danger">{t('spaceSketch.footer.diag.failed', { count: diagnostics.failed })}</span>
          </div>
        )}
        {/* Resize grip — drag to grow/shrink the canvas; the plan stays put (⤢ reframes). */}
        <div
          {...resizeHandlers}
          title={t('spaceSketch.panel.resizeTitle')}
          className="absolute bottom-1 right-1 h-3.5 w-3.5 cursor-nwse-resize text-muted-foreground/50 hover:text-foreground"
          style={{ touchAction: 'none' }}
        >
          <svg viewBox="0 0 10 10" className="h-full w-full" pointerEvents="none" aria-hidden>
            <path d="M9 2 L2 9 M9 6 L6 9" stroke="currentColor" strokeWidth={1.2} fill="none" />
          </svg>
        </div>
      </HudSurface>
    </HudItem>
  );
}

/** The bottom-center line: an in-progress gesture hint, else the live status. */
export function SpaceSketchHint({ text }: { text: string }) {
  if (!text) return null;
  return (
    <HudItem region="bottom-center" order={0}>
      <HudHint className="max-w-2xl text-center">{text}</HudHint>
    </HudItem>
  );
}

/**
 * The minimized state: a parked chip (top-left, where parked tools live)
 * carrying the pending count across every storey, with a resume action.
 * The draft sessions + 3D preview stay live underneath the whole time.
 */
export function SpaceSketchParkedChip({ pendingCount, onReopen }: { pendingCount: number; onReopen: () => void }) {
  const { t } = useTranslation();
  return (
    <HudItem region="top-left" order={3}>
      {/* After the Editing (0), storey (1) and Cesium (2) chips. */}
      <HudChip
        icon={<Layers aria-hidden className={cn(ICON, 'text-muted-foreground')} />}
        resume={{ onClick: onReopen, 'aria-label': t('spaceSketch.parkedChip.resumeTitle'), title: t('spaceSketch.parkedChip.resumeTitle'), icon: <ChevronDown aria-hidden className={ICON} /> }}
      >
        {t('spaceSketch.parkedChip.label')}
        {pendingCount > 0 && (
          <span className="ml-1.5 text-overlay-accent">{t('spaceSketch.parkedChip.toConfirm', { count: pendingCount })}</span>
        )}
      </HudChip>
    </HudItem>
  );
}
