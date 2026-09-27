/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual "time of day" sun control for the Environment panel (#2670).
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
import { useTranslation } from '@/i18n';

export function SunTimeControls() {
  const enabled = useViewerStore((s) => s.envSunTimeEnabled);
  const setEnabled = useViewerStore((s) => s.setEnvSunTimeEnabled);
  const time = useViewerStore((s) => s.envSunTime);
  const setTime = useViewerStore((s) => s.setEnvSunTime);
  const solarActive = useViewerStore((s) => s.solarEnabled);
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1 pt-2 border-t">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('viewportLighting.sunTimeControls.title')}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('viewportLighting.sunTimeControls.toggleAria')}
        />
      </div>

      {enabled && (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="flex justify-between text-xs uppercase tracking-wider text-muted-foreground">
              <span>{t('viewportLighting.sunTimeControls.sunTimeLabel')}</span>
              <button
                type="button"
                onClick={() => setTime(13)}
                title={t('viewportLighting.sunTimeControls.resetTitle')}
                className={cn('tabular-nums transition-colors', Math.abs(time - 13) > 1e-3 && 'text-foreground hover:text-primary')}
              >
                {formatHourOfDay(time)}
              </button>
            </span>
            <input
              type="range"
              aria-label={t('viewportLighting.sunTimeControls.sunTimeLabel')}
              min={SUN_DAY_START}
              max={SUN_DAY_END}
              step={0.25}
              value={time}
              onChange={(e) => setTime(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>
          {solarActive && (
            <span className="text-xs text-muted-foreground">
              {t('viewportLighting.sunTimeControls.overriddenHint')}
            </span>
          )}
        </>
      )}
    </div>
  );
}
