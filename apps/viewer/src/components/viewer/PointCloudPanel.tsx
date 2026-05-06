/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact panel that exposes point cloud rendering controls (color mode,
 * size mode, point size, EDL). Renders only when point cloud assets are
 * loaded — sits over the canvas without affecting layout for IFC-only
 * models.
 */

import { useViewerStore } from '@/store';
import type { PointColorModeUi, PointSizeModeUi } from '@/store/slices/pointCloudSlice';
import { cn } from '@/lib/utils';

const COLOR_MODES: Array<{ value: PointColorModeUi; label: string; hint: string }> = [
  { value: 'rgb',            label: 'RGB',            hint: 'Per-point colour from the source' },
  { value: 'classification', label: 'Classification', hint: 'ASPRS class palette (ground, vegetation, building...)' },
  { value: 'intensity',      label: 'Intensity',      hint: 'Greyscale ramp from per-point intensity' },
  { value: 'height',         label: 'Height',         hint: 'Cool-warm ramp by Y-up world height' },
  { value: 'fixed',          label: 'Solid',          hint: 'Single colour override' },
];

const SIZE_MODES: Array<{ value: PointSizeModeUi; label: string; hint: string }> = [
  { value: 'fixed-px',       label: 'Fixed',    hint: 'Always render at the slider value (in pixels)' },
  { value: 'attenuated',     label: 'Auto',     hint: 'Adaptive (closer = bigger), clamped to the slider as max' },
  { value: 'adaptive-world', label: 'World',    hint: 'Pure world-space radius — splat covers N mm in source space' },
];

export interface PointCloudPanelProps {
  /** Number of currently-loaded point cloud assets — panel hides when 0. */
  assetCount: number;
}

export function PointCloudPanel({ assetCount }: PointCloudPanelProps) {
  const colorMode = useViewerStore((s) => s.pointCloudColorMode);
  const setColorMode = useViewerStore((s) => s.setPointCloudColorMode);
  const sizeMode = useViewerStore((s) => s.pointCloudSizeMode);
  const setSizeMode = useViewerStore((s) => s.setPointCloudSizeMode);
  const pointSize = useViewerStore((s) => s.pointCloudPointSize);
  const setPointSize = useViewerStore((s) => s.setPointCloudPointSize);
  const worldRadius = useViewerStore((s) => s.pointCloudWorldRadius);
  const setWorldRadius = useViewerStore((s) => s.setPointCloudWorldRadius);
  const edlEnabled = useViewerStore((s) => s.pointCloudEdlEnabled);
  const setEdlEnabled = useViewerStore((s) => s.setPointCloudEdlEnabled);
  const edlStrength = useViewerStore((s) => s.pointCloudEdlStrength);
  const setEdlStrength = useViewerStore((s) => s.setPointCloudEdlStrength);

  if (assetCount <= 0) return null;

  return (
    <div className="absolute bottom-4 left-4 z-10 pointer-events-auto bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-2 min-w-[200px]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Point Cloud
        </span>
        <span className="text-[10px] text-muted-foreground">
          {assetCount} asset{assetCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* Color mode */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[9px] uppercase text-muted-foreground tracking-wider">Colour</span>
        {COLOR_MODES.map((mode) => {
          const active = colorMode === mode.value;
          return (
            <button
              key={mode.value}
              aria-pressed={active}
              onClick={() => setColorMode(mode.value)}
              title={mode.hint}
              className={cn(
                'flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors text-left',
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

      {/* Size mode */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[9px] uppercase text-muted-foreground tracking-wider">Size</span>
        <div className="grid grid-cols-3 gap-0.5">
          {SIZE_MODES.map((mode) => {
            const active = sizeMode === mode.value;
            return (
              <button
                key={mode.value}
                aria-pressed={active}
                onClick={() => setSizeMode(mode.value)}
                title={mode.hint}
                className={cn(
                  'px-1.5 py-1 rounded text-[11px] transition-colors',
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
        <label className="flex items-center gap-2 mt-1">
          <span className="text-[10px] text-muted-foreground w-8 shrink-0">{pointSize.toFixed(0)}px</span>
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={pointSize}
            onChange={(e) => setPointSize(Number(e.target.value))}
            className="flex-1 h-1 accent-teal-600 cursor-pointer"
            title="Splat size in pixels (or upper cap in Auto mode)"
          />
        </label>
        {sizeMode !== 'fixed-px' && (
          <label className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-8 shrink-0">
              {(worldRadius * 1000).toFixed(0)}mm
            </span>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={Math.round(worldRadius * 1000)}
              onChange={(e) => setWorldRadius(Number(e.target.value) / 1000)}
              className="flex-1 h-1 accent-teal-600 cursor-pointer"
              title="World-space splat radius in millimetres"
            />
          </label>
        )}
      </div>

      {/* EDL */}
      <div className="flex flex-col gap-0.5">
        <label className="flex items-center justify-between gap-2 cursor-pointer">
          <span className="text-[9px] uppercase text-muted-foreground tracking-wider">EDL</span>
          <input
            type="checkbox"
            checked={edlEnabled}
            onChange={(e) => setEdlEnabled(e.target.checked)}
            className="accent-teal-600"
            title="Eye-Dome Lighting — adds depth perception via screen-space depth gradient"
          />
        </label>
        {edlEnabled && (
          <label className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-8 shrink-0">
              {edlStrength.toFixed(1)}
            </span>
            <input
              type="range"
              min={0}
              max={3}
              step={0.1}
              value={edlStrength}
              onChange={(e) => setEdlStrength(Number(e.target.value))}
              className="flex-1 h-1 accent-teal-600 cursor-pointer"
              title="EDL strength multiplier"
            />
          </label>
        )}
      </div>
    </div>
  );
}
