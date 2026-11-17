/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storey display controls, relocated from the toolbar into the hierarchy's
 * Building Storeys section so every "level" concept lives where the user
 * already thinks about storeys.
 *
 * Grouping (#1269): Stacked and Solo are the closely-related "which storeys
 * are shown" pair (all vs one), so they sit together in a single segmented
 * toggle. Exploded does something different: it lifts the storeys apart for
 * a sectioned, drawing-like view, so it reads as a SEPARATE toggle button
 * next to the pair rather than a third equal option.
 *
 * The storey rows below are the Solo picker: clicking a storey solos it and
 * clicking it again returns to Stacked (#1265). The Floorplan button on the
 * right activates a top-down section view of the active storey, folding in
 * the old toolbar Quick-Floorplan dropdown so storey navigation + display sit
 * together.
 *
 * Self-gates: renders only with ≥ 2 storeys (single-storey models have no
 * use for level display modes or floorplan navigation).
 */

import { Layers3, ChevronsUpDown, SquareStack, Building2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { cn } from '@/lib/utils';
import { useTranslation, type TranslationKey } from '@/i18n';
import type { LevelDisplayMode } from '@/store/slices/levelDisplaySlice';
import { styleInterpolatedValues } from '@/i18n/richInterpolate';

/** The related "which storeys show" pair: a single Stacked / Solo toggle. */
const SHOW_MODES: Array<{
  key: Extract<LevelDisplayMode, 'stacked' | 'solo'>;
  labelKey: TranslationKey;
  Icon: typeof Layers3;
  hintKey: TranslationKey;
}> = [
  { key: 'stacked', labelKey: 'hierarchy.storeyControls.stacked', Icon: Layers3, hintKey: 'hierarchy.storeyControls.stackedHint' },
  { key: 'solo', labelKey: 'hierarchy.storeyControls.solo', Icon: SquareStack, hintKey: 'hierarchy.storeyControls.soloHint' },
];

export function StoreyDisplayControls() {
  const { t } = useTranslation();
  const { availableStoreys } = useFloorplanView();
  const levelDisplayMode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const setExplodedGap = useViewerStore((s) => s.setExplodedGap);
  const activeStorey = useViewerStore((s) => s.activeStorey);

  // Stacked / Exploded / Solo only make sense with multiple storeys. The
  // Floorplan action lives in the section header (`StoreyFloorplanButton`),
  // so a single-storey model gets no strip at all (#8802).
  const showModes = availableStoreys.length >= 2;
  if (!showModes) return null;

  const activeInfo = activeStorey
    ? availableStoreys.find((s) => s.modelId === activeStorey.modelId && s.expressId === activeStorey.expressId) ?? null
    : null;

  // One unified transition: Solo isolates the active/top storey via the storey
  // filter; Stacked / Exploded clear that isolation. No second channel to
  // strand. (Solo's default storey is the top one, not the empty basement.)
  const isExploded = levelDisplayMode === 'exploded';
  // Exploded is a separate on/off lens: turning it off returns to Stacked.
  const toggleExploded = () => applyLevelDisplayMode(isExploded ? 'stacked' : 'exploded');

  return (
    <div className="border-b border-border px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {showModes && (
          <>
            {/* Related pair: Stacked / Solo (which storeys are shown). */}
            <div className="inline-flex flex-1 rounded-md bg-muted p-0.5">
              {SHOW_MODES.map(({ key, labelKey, Icon, hintKey }) => {
                // Solo is "active" whenever a storey is isolated; Stacked is the
                // base view (also shown while Exploded, since Exploded lifts the
                // full stack). This keeps the pair truthful next to Exploded.
                const pressed = key === 'solo' ? levelDisplayMode === 'solo' : levelDisplayMode === 'stacked';
                return (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => applyLevelDisplayMode(key)}
                        className={cn(
                          'flex min-h-6 flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-2xs font-medium transition-colors',
                          pressed
                            ? 'bg-background text-card-foreground shadow-sm ring-1 ring-border'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{t(labelKey)}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{t(hintKey)}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>

            {/* Separate lens: Exploded lifts the storeys apart for a sectioned
                view, distinct from "which storeys show", so it stands alone. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-pressed={isExploded}
                  onClick={toggleExploded}
                  className={cn(
                    'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border px-2 text-2xs font-medium transition-colors',
                    isExploded
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" />
                  <span>{t('hierarchy.storeyControls.exploded')}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('hierarchy.storeyControls.explodedHint')}</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {showModes && isExploded && (
        <label className="mt-1.5 flex items-center gap-2 text-2xs text-muted-foreground">
          <span>{t('hierarchy.storeyControls.gapLabel')}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={explodedGap}
            onChange={(e) => {
              const next = e.currentTarget.valueAsNumber;
              if (Number.isFinite(next)) setExplodedGap(next);
            }}
            className="w-16 rounded border border-input bg-background px-1.5 py-0.5 font-mono text-2xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span>{t('hierarchy.storeyControls.gapUnitLabel')}</span>
        </label>
      )}

      {/* Discoverability hint (#1265): the storey rows ARE the Solo picker. */}
      {showModes && !isExploded && (
        <div className="mt-1 text-2xs leading-tight text-muted-foreground">
          {levelDisplayMode === 'solo' ? (
            activeInfo ? (
              styleInterpolatedValues(t, 'hierarchy.storeyControls.soloHintWithStorey', [
                ['name', <span key="name" className="font-medium text-foreground">{activeInfo.name}</span>],
              ])
            ) : (
              t('hierarchy.storeyControls.soloHintNoStorey')
            )
          ) : (
            t('hierarchy.storeyControls.stackedHintClickStorey')
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Floorplan of the active storey (or the only one), as a trailing action of the
 * tree's section header. It folded in the old toolbar Quick-Floorplan.
 */
export function StoreyFloorplanButton() {
  const { t } = useTranslation();
  const { availableStoreys, activateFloorplan } = useFloorplanView();
  const activeStorey = useViewerStore((s) => s.activeStorey);
  if (availableStoreys.length < 1) return null;
  const activeInfo = activeStorey
    ? availableStoreys.find((s) => s.modelId === activeStorey.modelId && s.expressId === activeStorey.expressId) ?? null
    : null;
  // Single-storey models have one obvious target, so floorplan it directly
  // without first requiring a storey pick (matches the old Quick-Floorplan).
  const floorplanTarget = activeInfo ?? (availableStoreys.length === 1 ? availableStoreys[0] : null);
  return (
    <IconButton
      label={t('hierarchy.storeyControls.floorplanAriaLabel')}
      tooltip={floorplanTarget
        ? t('hierarchy.storeyControls.floorplanTooltip', { name: floorplanTarget.name })
        : t('hierarchy.storeyControls.floorplanPickTooltip')}
      tooltipSide="bottom"
      size="icon-xs"
      className="h-6 w-6 text-muted-foreground"
      disabled={!floorplanTarget}
      onClick={() => floorplanTarget && activateFloorplan(floorplanTarget)}
    >
      <Building2 className="h-3.5 w-3.5" />
    </IconButton>
  );
}
