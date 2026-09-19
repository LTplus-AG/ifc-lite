/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The Space Sketch disclosure popovers — kept out of the default panel flow:
 *  Options (set-once settings) and Help (the full gesture legend). */

import type { BoundaryMode } from '@ifc-lite/create';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';

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

export function OptionsPopover(props: OptionsPopoverProps) {
  const { t } = useTranslation();
  const {
    boundaryMode, onBoundaryMode, hasWallData, snapDelta, usedTol, snapDisabled,
    onSnap, snapTol, showBuilding, onToggleBuilding, showDiagnostics, onToggleDiagnostics,
  } = props;
  return (
    <div className="absolute right-3 top-12 z-20 w-64 space-y-3 rounded-lg border bg-popover p-3 text-[11px] text-muted-foreground shadow-xl">
      <div className="space-y-1.5">
        <div className="font-medium text-foreground">{t('spaceSketch.options.boundaryHeading')}</div>
        <div className="inline-flex rounded-md border p-0.5">
          {(['center', 'inner', 'outer'] as BoundaryMode[]).map((m) => {
            const noWallData = !hasWallData && m !== 'center';
            return (
              <button key={m}
                className={`rounded px-2 py-0.5 transition-colors disabled:opacity-40 ${boundaryMode === m ? 'bg-primary text-primary-foreground' : 'hover:text-foreground'}`}
                onClick={() => onBoundaryMode(m)} disabled={noWallData}
                title={noWallData ? t('spaceSketch.options.boundary.noWallData') : t(BOUNDARY_MODE_LABEL_KEY[m])}>{t(BOUNDARY_MODE_SHORT_LABEL_KEY[m])}</button>
            );
          })}
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-foreground" title={t('spaceSketch.options.weldToleranceTitle')}>{t('spaceSketch.options.weldToleranceLabel')}</span>
          {snapDelta && (
            <span className={`tabular-nums ${snapDelta.to === 0 ? 'text-red-500' : snapDelta.to < snapDelta.from ? 'text-amber-500' : 'text-emerald-500'}`}
              title={t('spaceSketch.options.roomsBeforeAfterTitle')}>{snapDelta.from} → {snapDelta.to}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <input type="range" min={0.05} max={1} step={0.05} value={usedTol} className="flex-1 accent-primary"
            disabled={snapDisabled} onChange={(e) => onSnap(Number(e.target.value))} />
          <input type="number" min={0.05} max={1} step={0.05} value={usedTol} aria-label={t('spaceSketch.options.weldToleranceAriaLabel')}
            className="w-12 rounded border bg-background px-1 py-0.5 tabular-nums disabled:opacity-40"
            disabled={snapDisabled}
            onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) onSnap(Math.min(1, Math.max(0.05, v))); }} />
          <button className="rounded px-1 hover:text-foreground disabled:opacity-40" onClick={() => onSnap(null)}
            disabled={snapDisabled}
            title={snapTol == null ? t('spaceSketch.options.snapDefaultTitle') : t('spaceSketch.options.snapResetTitle')}>{snapTol == null ? t('spaceSketch.options.snapAuto') : t('spaceSketch.options.snapReset')}</button>
        </div>
      </div>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-foreground">{t('spaceSketch.options.showBuilding')}</span>
        <input type="checkbox" className="accent-primary" checked={showBuilding} onChange={onToggleBuilding} />
      </label>
      <label className="flex cursor-pointer items-center justify-between">
        <span className="text-foreground">{t('spaceSketch.options.leakDiagnostics')}</span>
        <input type="checkbox" className="accent-primary" checked={showDiagnostics} disabled={!hasWallData} onChange={onToggleDiagnostics} />
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
    <div className="absolute right-3 top-12 z-20 w-72 space-y-1.5 rounded-lg border bg-popover p-3 text-[11px] shadow-xl">
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
