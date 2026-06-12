/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Environment panel — sky + lighting controls for the viewport.
 *
 * One "Sky" switch covers both rendering paths: the WebGPU procedural sky
 * in standalone mode, and Cesium's atmosphere/sun when the 3D world context
 * is active (the WebGPU sky pass stays off there so the two never fight).
 * Lighting presets feed the renderer's environment uniforms; when the solar
 * study is running, its computed sun can override the preset sun so daylight
 * is truthful to the studied date/time and site.
 */

import { X } from 'lucide-react';
import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { LIGHTING_PRESETS, LIGHTING_PRESET_ORDER } from '@/lib/lighting-presets';

export function EnvironmentPanel() {
  const open = useViewerStore((s) => s.envPanelOpen);
  const setOpen = useViewerStore((s) => s.setEnvPanelOpen);
  const preset = useViewerStore((s) => s.envPreset);
  const setPreset = useViewerStore((s) => s.setEnvPreset);
  const skyEnabled = useViewerStore((s) => s.envSkyEnabled);
  const setSkyEnabled = useViewerStore((s) => s.setEnvSkyEnabled);
  const sunFollowsSolar = useViewerStore((s) => s.envSunFollowsSolar);
  const setSunFollowsSolar = useViewerStore((s) => s.setEnvSunFollowsSolar);
  const exposure = useViewerStore((s) => s.envExposure);
  const setExposure = useViewerStore((s) => s.setEnvExposure);

  const solarEnabled = useViewerStore((s) => s.solarEnabled);
  const cesiumEnabled = useViewerStore((s) => s.cesiumEnabled);

  if (!open) return null;

  return (
    <div className="pointer-events-auto w-60 bg-background/90 backdrop-blur-sm rounded-lg border shadow-lg p-2 flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Environment
        </span>
        <button
          type="button"
          aria-label="Close environment panel"
          onClick={() => setOpen(false)}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Lighting preset */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Lighting</span>
        <div className="grid grid-cols-3 gap-1">
          {LIGHTING_PRESET_ORDER.map((id) => (
            <button
              key={id}
              type="button"
              title={LIGHTING_PRESETS[id].hint}
              aria-pressed={preset === id}
              onClick={() => setPreset(id)}
              className={cn(
                'px-1.5 py-1 rounded text-[10px] transition-colors',
                preset === id
                  ? 'bg-teal-600 text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {LIGHTING_PRESETS[id].label}
            </button>
          ))}
        </div>
      </div>

      {/* Sky + solar-sun toggles */}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setSkyEnabled(!skyEnabled)}
          aria-pressed={skyEnabled}
          title={cesiumEnabled
            ? 'Sky atmosphere + sun in the 3D world context'
            : 'Procedural sky background behind the model'}
          className={cn(
            'flex-1 px-2 py-1 rounded text-[10px] font-semibold uppercase transition-colors',
            skyEnabled ? 'bg-teal-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          Sky
        </button>
        <button
          type="button"
          onClick={() => setSunFollowsSolar(!sunFollowsSolar)}
          aria-pressed={sunFollowsSolar}
          title="Drive the sun from the sun-path study's date, time and site"
          className={cn(
            'flex-1 px-2 py-1 rounded text-[10px] font-semibold uppercase transition-colors',
            sunFollowsSolar && solarEnabled
              ? 'bg-amber-500 text-zinc-950'
              : sunFollowsSolar
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          Solar sun
        </button>
      </div>
      {sunFollowsSolar && !solarEnabled && (
        <p className="text-[9px] leading-snug text-muted-foreground">
          Enable the sun-path study to drive the sun from a real date, time and site.
        </p>
      )}

      {/* Exposure */}
      <label className="flex flex-col gap-0.5">
        <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
          <span>Exposure</span>
          <button
            type="button"
            onClick={() => setExposure(1)}
            title="Reset exposure"
            className={cn('tabular-nums transition-colors', exposure !== 1 && 'text-foreground hover:text-teal-600')}
          >
            {exposure.toFixed(2)}×
          </button>
        </span>
        <input
          type="range"
          min={0.4}
          max={2}
          step={0.05}
          value={exposure}
          onChange={(e) => setExposure(Number(e.target.value))}
          className="w-full accent-teal-600"
        />
      </label>
    </div>
  );
}
