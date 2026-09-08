/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual "time of day" sun control for the Sun & Sky panel (#2670).
 *
 * A toggle plus a time slider that sweeps the sun along an east→west arc, so
 * shadows can be moved on ANY model without georeference. When a real
 * georeferenced solar study is active it takes precedence (Viewport resolves
 * it), so this is the fallback sun for a plain model.
 *
 * Standalone WebGPU only; gated on `!cesiumEnabled` by the caller.
 */

import { useViewerStore } from '@/store';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { formatHourOfDay, SUN_DAY_START, SUN_DAY_END } from '@/lib/sun-time-of-day';

export function SunTimeControls() {
  const enabled = useViewerStore((s) => s.envSunTimeEnabled);
  const setEnabled = useViewerStore((s) => s.setEnvSunTimeEnabled);
  const time = useViewerStore((s) => s.envSunTime);
  const setTime = useViewerStore((s) => s.setEnvSunTime);
  const solarActive = useViewerStore((s) => s.solarEnabled);

  return (
    <div className="flex flex-col gap-1 pt-2 border-t">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Time of day
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Toggle manual time-of-day sun"
        />
      </div>

      {enabled && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="flex justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
              <span>Sun time</span>
              <button
                type="button"
                onClick={() => setTime(13)}
                title="Reset to early afternoon"
                className={cn('tabular-nums transition-colors', Math.abs(time - 13) > 1e-3 && 'text-foreground hover:text-teal-600')}
              >
                {formatHourOfDay(time)}
              </button>
            </span>
            <input
              type="range"
              min={SUN_DAY_START}
              max={SUN_DAY_END}
              step={0.25}
              value={time}
              onChange={(e) => setTime(Number(e.target.value))}
              className="w-full accent-teal-600"
            />
          </label>
          {solarActive && (
            <span className="text-[9px] text-muted-foreground">
              Overridden by the georeferenced sun study.
            </span>
          )}
        </>
      )}
    </div>
  );
}
