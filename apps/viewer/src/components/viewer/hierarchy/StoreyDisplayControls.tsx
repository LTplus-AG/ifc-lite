/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storey display controls — Stacked / Exploded / Solo, relocated from the
 * toolbar into the hierarchy's Building Storeys section so every "level"
 * concept lives where the user already thinks about storeys.
 *
 * The storey rows are the picker: Solo isolates the shared `activeStorey`
 * (set when a storey row is clicked), so there's no separate storey dropdown
 * and no lowest-storey cold-start surprise. The Floorplan button on the right
 * activates a top-down section view of the active storey — folding in the
 * old toolbar Quick-Floorplan dropdown so storey navigation + display sit
 * together.
 *
 * Self-gates: renders only with ≥ 2 storeys (single-storey models have no
 * use for level display modes or floorplan navigation).
 */

import { Layers3, ChevronsUpDown, SquareStack, Building2 } from 'lucide-react';
import { useViewerStore } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { useFloorplanView } from '@/hooks/useFloorplanView';
import { cn } from '@/lib/utils';
import type { LevelDisplayMode } from '@/store/slices/levelDisplaySlice';

const MODES: Array<{ key: LevelDisplayMode; label: string; Icon: typeof Layers3; hint: string }> = [
  { key: 'stacked', label: 'Stacked', Icon: Layers3, hint: 'Every storey at its real elevation (default)' },
  { key: 'exploded', label: 'Exploded', Icon: ChevronsUpDown, hint: 'Lift each storey apart vertically' },
  { key: 'solo', label: 'Solo', Icon: SquareStack, hint: 'Show only the active storey' },
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
  const handleMode = (mode: LevelDisplayMode) => applyLevelDisplayMode(mode);

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-950/40 px-2 py-1.5">
      <div className="flex items-center gap-1">
        {showModes && (
          <div className="inline-flex flex-1 rounded-md border border-zinc-200 dark:border-zinc-800 p-0.5">
            {MODES.map(({ key, label, Icon, hint }) => (
              <button
                key={key}
                type="button"
                title={hint}
                aria-pressed={levelDisplayMode === key}
                onClick={() => handleMode(key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded px-1.5 py-1 text-[11px] font-medium transition-colors',
                  levelDisplayMode === key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          disabled={!floorplanTarget}
          title={floorplanTarget ? `Floorplan: ${floorplanTarget.name}` : 'Pick a storey to floorplan it'}
          aria-label="Floorplan the active storey"
          onClick={() => floorplanTarget && activateFloorplan(floorplanTarget)}
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-200 dark:border-zinc-800 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40',
            !showModes && 'ml-auto',
          )}
        >
          <Building2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {showModes && levelDisplayMode === 'exploded' && (
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

      {showModes && levelDisplayMode === 'solo' && (
        <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
          {activeInfo ? (
            <>
              Showing <span className="font-medium text-foreground">{activeInfo.name}</span> · click a storey to switch
            </>
          ) : (
            'Click a storey to solo it'
          )}
        </div>
      )}
    </div>
  );
}
