/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Space Sketch disclosure popovers' BODIES — Options (set-once
 *  settings), Help (the full gesture legend) and More (#5975: history, snap
 *  and Help collapsed together below the bar's compact width threshold).
 *  `SpaceSketchBar` mounts each inside a `HudPopoverContent` (#5503), which
 *  owns the card surface and placement; nothing here positions itself. */

import { Undo2, Redo2, Magnet } from 'lucide-react';
import type { BoundaryMode } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { HudSegmented } from '../../../viewport-ui/hud';

const MORE_ROW = 'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-foreground hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent';
const MORE_ICON = 'h-3.5 w-3.5 shrink-0 text-muted-foreground';

export interface OptionsPopoverProps {
  boundaryMode: BoundaryMode;
  onBoundaryMode: (m: BoundaryMode) => void;
  /** Whether this derive carried wall thickness — without it only `center` works. */
  hasWallData: boolean;
  snapDelta: { from: number; to: number } | null;
  usedTol: number;
  /** The weld-tolerance control is disabled until a storey is derived. */
  snapDisabled: boolean;
  onSnap: (tol: number | null) => void;
  snapTol: number | null;
  showBuilding: boolean;
  onToggleBuilding: () => void;
  showDiagnostics: boolean;
  onToggleDiagnostics: () => void;
}

const BOUNDARY_MODE_LABEL_KEY: Record<BoundaryMode, TranslationKey> = {
  center: 'spaceSketch.options.boundary.centerTitle',
  inner: 'spaceSketch.options.boundary.innerTitle',
  outer: 'spaceSketch.options.boundary.outerTitle',
};

// Short button-body label, distinct from the longer tooltip text above
// (#4918 review, PR #5001): the button previously rendered the raw
// `BoundaryMode` enum value (`center`/`inner`/`outer`) as its own text,
// which stayed English in every locale even once the tooltip translated.
const BOUNDARY_MODE_SHORT_LABEL_KEY: Record<BoundaryMode, TranslationKey> = {
  center: 'spaceSketch.options.boundary.centerLabel',
  inner: 'spaceSketch.options.boundary.innerLabel',
  outer: 'spaceSketch.options.boundary.outerLabel',
};

const BOUNDARY_MODES: BoundaryMode[] = ['center', 'inner', 'outer'];

export function OptionsPopover(props: OptionsPopoverProps) {
  const { t } = useTranslation();
  const {
    boundaryMode, onBoundaryMode, hasWallData, snapDelta, usedTol, snapDisabled,
    onSnap, snapTol, showBuilding, onToggleBuilding, showDiagnostics, onToggleDiagnostics,
  } = props;
  // Inner/Outer need wall thickness from the derive; without it the choice
  // is refused in the change handler (and says why on hover), rather than
  // rendered as a disabled segment the user can't learn the reason for.
  const boundaryOptions = BOUNDARY_MODES.map((m) => ({
    value: m,
    label: <span title={!hasWallData && m !== 'center' ? t('spaceSketch.options.boundary.noWallData') : t(BOUNDARY_MODE_LABEL_KEY[m])}>{t(BOUNDARY_MODE_SHORT_LABEL_KEY[m])}</span>,
  }));
  return (
    <div className="space-y-3 text-2xs text-muted-foreground">
      <div className="space-y-1.5">
        <div className="font-medium text-foreground">{t('spaceSketch.options.boundaryHeading')}</div>
        <HudSegmented<BoundaryMode>
          aria-label={t('spaceSketch.options.boundaryHeading')}
          value={boundaryMode}
          onChange={(m) => { if (hasWallData || m === 'center') onBoundaryMode(m); }}
          options={boundaryOptions}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-foreground" title={t('spaceSketch.options.weldToleranceTitle')}>{t('spaceSketch.options.weldToleranceLabel')}</span>
          {snapDelta && (
            <span className={cn('tabular-nums', snapDelta.to === 0 ? 'text-status-danger' : snapDelta.to < snapDelta.from ? 'text-status-warn' : 'text-status-ok')}
              title={t('spaceSketch.options.roomsBeforeAfterTitle')}>{snapDelta.from} → {snapDelta.to}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input type="range" min={0.05} max={1} step={0.05} value={usedTol} className="flex-1 accent-overlay-accent"
            disabled={snapDisabled} onChange={(e) => onSnap(Number(e.target.value))} />
          <input type="number" min={0.05} max={1} step={0.05} value={usedTol} aria-label={t('spaceSketch.options.weldToleranceAriaLabel')}
            className="w-12 rounded-sm border border-border bg-background px-1 py-0.5 tabular-nums disabled:opacity-40"
            disabled={snapDisabled}
            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) onSnap(Math.min(1, Math.max(0.05, v))); }} />
          <button type="button" className="rounded-sm px-1 hover:text-foreground disabled:opacity-40" onClick={() => onSnap(null)}
            disabled={snapDisabled}
            title={snapTol == null ? t('spaceSketch.options.snapDefaultTitle') : t('spaceSketch.options.snapResetTitle')}>{snapTol == null ? t('spaceSketch.options.snapAuto') : t('spaceSketch.options.snapReset')}</button>
        </div>
      </div>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-foreground">{t('spaceSketch.options.showBuilding')}</span>
        <input type="checkbox" className="accent-overlay-accent" checked={showBuilding} onChange={onToggleBuilding} />
      </label>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-foreground">{t('spaceSketch.options.leakDiagnostics')}</span>
        <input type="checkbox" className="accent-overlay-accent" checked={showDiagnostics} disabled={!hasWallData} onChange={onToggleDiagnostics} />
      </label>
    </div>
  );
}

const HELP_ROWS: [TranslationKey, TranslationKey][] = [
  ['spaceSketch.help.rectangleTool.label', 'spaceSketch.help.rectangleTool.desc'],
  ['spaceSketch.help.footprint.label', 'spaceSketch.help.footprint.desc'],
  ['spaceSketch.help.dragNode.label', 'spaceSketch.help.dragNode.desc'],
  ['spaceSketch.help.clickWallThenAnother.label', 'spaceSketch.help.clickWallThenAnother.desc'],
  ['spaceSketch.help.clickEmptySpace.label', 'spaceSketch.help.clickEmptySpace.desc'],
  ['spaceSketch.help.removeNode.label', 'spaceSketch.help.removeNode.desc'],
  ['spaceSketch.help.mergeWall.label', 'spaceSketch.help.mergeWall.desc'],
  ['spaceSketch.help.panZoom.label', 'spaceSketch.help.panZoom.desc'],
];

export function HelpPopover() {
  const { t } = useTranslation();
  return (
    <div className="space-y-1.5 text-2xs">
      <div className="mb-1 font-medium text-foreground">{t('spaceSketch.help.heading')}</div>
      {HELP_ROWS.map(([k, v]) => (
        <div key={k} className="flex gap-2">
          <span className="shrink-0 font-medium text-foreground">{t(k)}</span>
          <span className="text-muted-foreground">— {t(v)}</span>
        </div>
      ))}
    </div>
  );
}

export interface MorePopoverProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  snapToBuilding: boolean;
  onToggleSnap: () => void;
}

/** History + snap + the Help legend, together, behind the bar's compact-mode
 *  `MoreHorizontal` trigger (#5975) — the same actions the full bar shows
 *  inline, just stacked instead of laid out in a row. */
export function MorePopover(p: MorePopoverProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 text-2xs">
      <div className="space-y-0.5">
        <button type="button" className={MORE_ROW} onClick={p.onUndo} disabled={!p.canUndo}>
          <Undo2 aria-hidden className={MORE_ICON} />{t('spaceSketch.tools.undoTitle')}
        </button>
        <button type="button" className={MORE_ROW} onClick={p.onRedo} disabled={!p.canRedo}>
          <Redo2 aria-hidden className={MORE_ICON} />{t('spaceSketch.tools.redoTitle')}
        </button>
        <label className={cn(MORE_ROW, 'cursor-pointer justify-between')}>
          <span className="flex items-center gap-2">
            <Magnet aria-hidden className={MORE_ICON} />{t('spaceSketch.tools.snapLabel')}
          </span>
          <input type="checkbox" className="accent-overlay-accent" checked={p.snapToBuilding} onChange={p.onToggleSnap} />
        </label>
      </div>
      <div className="border-t border-border pt-2">
        <HelpPopover />
      </div>
    </div>
  );
}
