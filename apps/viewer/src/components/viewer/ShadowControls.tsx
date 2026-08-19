/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun cast-shadow controls for the Sun & Sky panel (#2670).
 *
 * A toggle that turns the sun shadow pass on, a "Sun angle" slider that sets
 * the physical shadow softness (the sun's angular size in degrees — Blender's
 * Sun lamp `Angle`, ~0.53° for a clear sky; larger = softer penumbra), and a
 * shadow-map resolution select (a cost-vs-fidelity Quality dial).
 *
 * Rendered only in standalone (WebGPU) mode; in world-context Cesium casts its
 * own shadows, so the caller gates this on `!cesiumEnabled`.
 */

import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';

const RESOLUTIONS = [1024, 2048, 4096] as const;

export function ShadowControls() {
  const enabled = useViewerStore((s) => s.envShadowsEnabled);
  const setEnabled = useViewerStore((s) => s.setEnvShadowsEnabled);
  const sunAngle = useViewerStore((s) => s.envSunAngle);
  const setSunAngle = useViewerStore((s) => s.setEnvSunAngle);
  const resolution = useViewerStore((s) => s.envShadowResolution);
  const setResolution = useViewerStore((s) => s.setEnvShadowResolution);

  return (
    <div className="flex flex-col gap-1 pt-2 border-t">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Cast shadows
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Toggle sun cast shadows"
        />
      </div>

      {enabled && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
              <span>Softness</span>
              <button
                type="button"
                onClick={() => setSunAngle(0.53)}
                title="Reset shadow softness — the sun's angular size (degrees). Larger = softer, blurrier shadow edges (crisp ~0.53° clear sky). It does NOT move the sun; use Time of day for that."
                className={cn('tabular-nums transition-colors', Math.abs(sunAngle - 0.53) > 1e-3 && 'text-foreground hover:text-teal-600')}
              >
                {sunAngle.toFixed(2)}°
              </button>
            </span>
            <input
              type="range"
              min={0.1}
              max={5}
              step={0.05}
              value={sunAngle}
              onChange={(e) => setSunAngle(Number(e.target.value))}
              className="w-full accent-teal-600"
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
              Shadow quality
            </span>
            <select
              aria-label="Shadow map resolution"
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value))}
              title="Shadow-map resolution — higher is sharper but costs more GPU"
              className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-[10px]"
            >
              {RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {r === 1024 ? 'Low' : r === 2048 ? 'Medium' : 'High'} ({r}px)
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
