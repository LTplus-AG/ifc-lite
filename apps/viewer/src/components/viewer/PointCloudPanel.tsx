/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact panel that exposes point cloud rendering controls (color mode,
 * fixed-color override). Renders only when point cloud assets are loaded.
 *
 * Pulled into ViewportOverlays so it sits over the canvas without
 * affecting layout for IFC-only models.
 */

import { useViewerStore } from '@/store';
import type { PointColorModeUi } from '@/store/slices/pointCloudSlice';
import { cn } from '@/lib/utils';

const MODES: Array<{ value: PointColorModeUi; label: string; hint: string }> = [
  { value: 'rgb',            label: 'RGB',            hint: 'Per-point colour from the source' },
  { value: 'classification', label: 'Classification', hint: 'ASPRS class palette (ground, vegetation, building...)' },
  { value: 'intensity',      label: 'Intensity',      hint: 'Greyscale ramp from per-point intensity' },
  { value: 'height',         label: 'Height',         hint: 'Cool-warm ramp by Y-up world height' },
  { value: 'fixed',          label: 'Solid',          hint: 'Single colour override' },
];

export interface PointCloudPanelProps {
  /** Number of currently-loaded point cloud assets — panel hides when 0. */
  assetCount: number;
}

export function PointCloudPanel({ assetCount }: PointCloudPanelProps) {
  const colorMode = useViewerStore((s) => s.pointCloudColorMode);
  const setColorMode = useViewerStore((s) => s.setPointCloudColorMode);

  if (assetCount <= 0) return null;

  return (
    <div className="absolute bottom-4 left-4 z-10 pointer-events-auto bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-1 min-w-[160px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Point Cloud
        </span>
        <span className="text-[10px] text-muted-foreground">{assetCount} asset{assetCount === 1 ? '' : 's'}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {MODES.map((mode) => {
          const active = colorMode === mode.value;
          return (
            <button
              key={mode.value}
              onClick={() => setColorMode(mode.value)}
              title={mode.hint}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors text-left',
                active
                  ? 'bg-teal-600 text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {mode.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
