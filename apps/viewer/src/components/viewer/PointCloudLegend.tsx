/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-mode legend for the point-cloud panel.
 *
 * Renders only when the active colour mode benefits from a legend
 * (classification / intensity / height); RGB and Solid don't need one.
 * The palettes here MUST stay in sync with `point-shader.wgsl.ts` —
 * any colour change in the shader has to come back to this file.
 */

import type { PointColorModeUi } from '@/store/slices/pointCloudSlice';

interface ClassificationEntry {
  id: number;
  label: string;
  rgb: [number, number, number];
}

// ASPRS LAS 1.4 standard classes — ids that don't appear here all
// fall back to the shader's "default" entry (0.65 grey) and are
// shown collectively at the bottom of the legend.
const CLASSIFICATION: ClassificationEntry[] = [
  { id: 0,  label: 'Never classified',  rgb: [0.65, 0.65, 0.65] },
  { id: 1,  label: 'Unclassified',      rgb: [0.65, 0.65, 0.65] },
  { id: 2,  label: 'Ground',            rgb: [0.55, 0.40, 0.25] },
  { id: 3,  label: 'Low vegetation',    rgb: [0.55, 0.85, 0.45] },
  { id: 4,  label: 'Medium vegetation', rgb: [0.30, 0.75, 0.30] },
  { id: 5,  label: 'High vegetation',   rgb: [0.10, 0.45, 0.15] },
  { id: 6,  label: 'Building',          rgb: [0.95, 0.55, 0.20] },
  { id: 7,  label: 'Low point (noise)', rgb: [0.95, 0.20, 0.20] },
  { id: 9,  label: 'Water',             rgb: [0.20, 0.40, 0.95] },
  { id: 10, label: 'Rail',              rgb: [0.55, 0.20, 0.85] },
  { id: 11, label: 'Road surface',      rgb: [0.30, 0.30, 0.30] },
  { id: 13, label: 'Wire — guard',      rgb: [0.95, 0.85, 0.20] },
  { id: 14, label: 'Wire — conductor',  rgb: [0.95, 0.95, 0.50] },
  { id: 15, label: 'Transmission tower', rgb: [0.20, 0.20, 0.55] },
  { id: 16, label: 'Wire-structure',    rgb: [0.30, 0.65, 0.65] },
  { id: 17, label: 'Bridge deck',       rgb: [0.85, 0.70, 0.50] },
  { id: 18, label: 'High noise',        rgb: [0.95, 0.20, 0.20] },
];

const HEIGHT_GRADIENT =
  'linear-gradient(to right, '
  + 'rgb(26,51,217), '   // 0.10, 0.20, 0.85
  + 'rgb(26,217,217), '  // 0.10, 0.85, 0.85
  + 'rgb(51,217,51), '   // 0.20, 0.85, 0.20
  + 'rgb(242,242,51), '  // 0.95, 0.95, 0.20
  + 'rgb(242,51,26))';   // 0.95, 0.20, 0.10

export interface PointCloudLegendProps {
  colorMode: PointColorModeUi;
}

export function PointCloudLegend({ colorMode }: PointCloudLegendProps) {
  if (colorMode === 'classification') {
    return (
      <div className="flex flex-col gap-0.5 mt-1 max-h-40 overflow-y-auto">
        <span className="text-[9px] uppercase text-muted-foreground tracking-wider sticky top-0 bg-background/95 py-0.5">
          Classes (ASPRS LAS 1.4)
        </span>
        {CLASSIFICATION.map((c) => (
          <div key={c.id} className="flex items-center gap-1.5 text-[10px]">
            <span
              className="inline-block h-3 w-3 rounded-sm shrink-0 border border-foreground/10"
              style={{ backgroundColor: rgbCss(c.rgb) }}
              aria-hidden="true"
            />
            <span className="text-muted-foreground tabular-nums w-4 shrink-0">{c.id}</span>
            <span className="text-foreground truncate">{c.label}</span>
          </div>
        ))}
      </div>
    );
  }

  if (colorMode === 'intensity') {
    return (
      <div className="flex flex-col gap-0.5 mt-1">
        <span className="text-[9px] uppercase text-muted-foreground tracking-wider">Intensity</span>
        <div
          className="h-2 rounded-sm border border-foreground/10"
          style={{ background: 'linear-gradient(to right, rgb(0,0,0), rgb(255,255,255))' }}
          aria-label="Intensity ramp from low (black) to high (white)"
        />
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>low</span>
          <span>high</span>
        </div>
      </div>
    );
  }

  if (colorMode === 'height') {
    return (
      <div className="flex flex-col gap-0.5 mt-1">
        <span className="text-[9px] uppercase text-muted-foreground tracking-wider">Height (Y-up)</span>
        <div
          className="h-2 rounded-sm border border-foreground/10"
          style={{ background: HEIGHT_GRADIENT }}
          aria-label="Height ramp from low (blue) to high (red)"
        />
        <div className="flex justify-between text-[9px] text-muted-foreground">
          <span>low</span>
          <span>high</span>
        </div>
      </div>
    );
  }

  return null;
}

function rgbCss([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
