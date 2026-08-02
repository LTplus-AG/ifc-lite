/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistent in-viewport indicator for a non-default level display mode.
 *
 * Replaces the 1.5px toolbar dot that used to be the only signal an
 * Exploded / Solo view was active — easy to miss, and the control itself
 * has now moved into the hierarchy. A small chip in the viewport tells the
 * user at a glance "you are isolated to storey X" / "levels are exploded",
 * with a one-click return to Stacked.
 *
 * Anchored top-left so it never covers the ViewCube (top-right) or the
 * Sun & Sky panel (top-32 right).
 */

import { ChevronsUpDown, SquareStack, X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { useFloorplanView } from '@/hooks/useFloorplanView';

export function LevelDisplayIndicator() {
  const mode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const activeStorey = useViewerStore((s) => s.activeStorey);
  const { availableStoreys } = useFloorplanView();

  if (mode === 'stacked') return null;

  const Icon = mode === 'exploded' ? ChevronsUpDown : SquareStack;
  const soloName = activeStorey
    ? availableStoreys.find((s) => s.modelId === activeStorey.modelId && s.expressId === activeStorey.expressId)?.name
    : undefined;
  const label =
    mode === 'exploded'
      ? `Exploded · ${explodedGap} m gap`
      : `Solo · ${soloName ?? 'storey'}`;

  return (
    <div className="absolute top-4 left-4 z-10 flex items-center gap-1.5 rounded-md border border-purple-300/60 bg-background/90 px-2 py-1 text-xs font-medium text-foreground shadow-sm backdrop-blur dark:border-purple-500/40">
      <Icon className="h-3.5 w-3.5 text-purple-500" />
      <span className="tabular-nums">{label}</span>
      <button
        type="button"
        onClick={() => applyLevelDisplayMode('stacked')}
        title="Back to stacked"
        aria-label="Back to stacked view"
        className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
