/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU shading trim controls for the Sun & Sky panel: Exposure, Light
 * hardness and Terminator softness. All three are user trims composed onto the
 * active lighting preset (the preset supplies the base; switching preset
 * changes the base, the trims persist), so they share one control shape — a
 * labelled slider whose value doubles as a reset-to-neutral button.
 *
 * Rendered only in standalone (WebGPU) mode; in world-context the model is lit
 * by Cesium, so the caller gates this on `!cesiumEnabled`.
 */

import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';

function TrimSlider({ label, resetTitle, value, min, max, onChange }: {
  label: string;
  resetTitle: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => onChange(1)}
          title={resetTitle}
          className={cn('tabular-nums transition-colors', value !== 1 && 'text-foreground hover:text-teal-600')}
        >
          {value.toFixed(2)}×
        </button>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-teal-600"
      />
    </label>
  );
}

export function LightingTrimControls() {
  const exposure = useViewerStore((s) => s.envExposure);
  const setExposure = useViewerStore((s) => s.setEnvExposure);
  const hardness = useViewerStore((s) => s.envHardness);
  const setHardness = useViewerStore((s) => s.setEnvHardness);
  const softness = useViewerStore((s) => s.envSoftness);
  const setSoftness = useViewerStore((s) => s.setEnvSoftness);

  return (
    <>
      <TrimSlider
        label="Exposure"
        resetTitle="Reset exposure"
        value={exposure}
        min={0.4}
        max={2}
        onChange={setExposure}
      />
      <TrimSlider
        label="Light hardness"
        resetTitle="Reset light hardness — higher deepens shadows by cutting ambient fill"
        value={hardness}
        min={0.5}
        max={2}
        onChange={setHardness}
      />
      <TrimSlider
        label="Terminator softness"
        resetTitle="Reset shadow softness — lower crisps the light/shadow edge, higher softens it"
        value={softness}
        min={0}
        max={2}
        onChange={setSoftness}
      />
    </>
  );
}
