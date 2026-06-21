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
import { useViewerStore } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { cn } from '@/lib/utils';
import type { LevelDisplayMode } from '@/store/slices/levelDisplaySlice';

/** The related "which storeys show" pair: a single Stacked / Solo toggle. */
const SHOW_MODES: Array<{ key: Extract<LevelDisplayMode, 'stacked' | 'solo'>; label: string; Icon: typeof Layers3; hint: string }> = [
  { key: 'stacked', label: 'Stacked', Icon: Layers3, hint: 'Show every storey at its real elevation (the default view)' },
  { key: 'solo', label: 'Solo', Icon: SquareStack, hint: 'Show only one storey, click a storey below to pick it' },
];

export function StoreyDisplayControls() {
  const { availableStoreys, activateFloorplan } = useFloorplanView();
  const levelDisplayMode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const setExplodedGap = useViewerStore((s) => s.setExplodedGap);
  const activeStorey = useViewerStore((s) => s.activeStorey);

  // Nothing storey-related to offer without a storey at all.
  if (availableStoreys.length < 1) return null;

  // Stacked / Exploded / Solo only make sense with multiple storeys; Floorplan
  // works for a single storey too (it replaced the toolbar Quick-Floorplan).
  const showModes = availableStoreys.length >= 2;

  const activeInfo = activeStorey
    ? availableStoreys.find((s) => s.modelId === activeStorey.modelId && s.expressId === activeStorey.expressId) ?? null
    : null;
  // Single-storey models have one obvious target, so floorplan it directly
  // without first requiring a storey pick (matches the old Quick-Floorplan).
  const floorplanTarget = activeInfo ?? (availableStoreys.length === 1 ? availableStoreys[0] : null);

  // One unified transition: Solo isolates the active/top storey via the storey
  // filter; Stacked / Exploded clear that isolation. No second channel to
  // strand. (Solo's default storey is the top one, not the empty basement.)
  const isExploded = levelDisplayMode === 'exploded';
  // Exploded is a separate on/off lens: turning it off returns to Stacked.
  const toggleExploded = () => applyLevelDisplayMode(isExploded ? 'stacked' : 'exploded');

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-950/40 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        {showModes && (
          <>
            {/* Related pair: Stacked / Solo (which storeys are shown). */}
            <div className="inline-flex flex-1 rounded-md border border-zinc-200 dark:border-zinc-800 p-0.5">
              {SHOW_MODES.map(({ key, label, Icon, hint }) => {
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
                          'flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                          pressed
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{label}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">{hint}</TooltipContent>
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
                    'inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors',
                    isExploded
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-zinc-200 dark:border-zinc-800 text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" />
                  <span>Exploded</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Lift each storey apart vertically for a sectioned, drawing-like view</TooltipContent>
            </Tooltip>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!floorplanTarget}
              aria-label="Floorplan the active storey"
              onClick={() => floorplanTarget && activateFloorplan(floorplanTarget)}
              className={cn(
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-800 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40',
                !showModes && 'ml-auto',
              )}
            >
              <Building2 className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {floorplanTarget ? `Top-down floorplan of ${floorplanTarget.name}` : 'Pick a storey to floorplan it'}
          </TooltipContent>
        </Tooltip>
      </div>

      {showModes && isExploded && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Gap</span>
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
            className="w-16 rounded border border-zinc-300 bg-white px-1.5 py-0.5 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-primary dark:border-zinc-700 dark:bg-zinc-950"
          />
          <span>m between levels</span>
        </div>
      )}

      {/* Discoverability hint (#1265): the storey rows ARE the Solo picker. */}
      {showModes && !isExploded && (
        <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
          {levelDisplayMode === 'solo' ? (
            activeInfo ? (
              <>
                Showing only <span className="font-medium text-foreground">{activeInfo.name}</span> · click another storey to switch, or click it again for all
              </>
            ) : (
              'Click a storey below to show only it'
            )
          ) : (
            'Click a storey below to show only that level'
          )}
        </div>
      )}
    </div>
  );
}
