/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun cast-shadow controls for the Environment panel (#2670).
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
import { useTranslation } from '@/i18n';
import { resolve } from '@/i18n/registry';

const RESOLUTIONS = [0, 1024, 2048, 4096] as const;

/** Plain formatting function, not a component — takes the same non-hook
 *  `t: typeof resolve = resolve` default parameter `bulk-property-value.ts`
 *  already uses, so a caller with a live `t` (the component below) can pass
 *  it through and still retranslate on a locale switch. */
function resolutionLabel(r: number, t: typeof resolve = resolve): string {
  if (r === 0) return t('viewportLighting.shadowControls.resolution.auto');
  if (r === 1024) return t('viewportLighting.shadowControls.resolution.low', { resolution: r });
  if (r === 2048) return t('viewportLighting.shadowControls.resolution.medium', { resolution: r });
  return t('viewportLighting.shadowControls.resolution.high', { resolution: r });
}

export function ShadowControls() {
  const enabled = useViewerStore((s) => s.envShadowsEnabled);
  const setEnabled = useViewerStore((s) => s.setEnvShadowsEnabled);
  const sunAngle = useViewerStore((s) => s.envSunAngle);
  const setSunAngle = useViewerStore((s) => s.setEnvSunAngle);
  const resolution = useViewerStore((s) => s.envShadowResolution);
  const setResolution = useViewerStore((s) => s.setEnvShadowResolution);
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1 pt-2 border-t">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('viewportLighting.shadowControls.title')}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={t('viewportLighting.shadowControls.toggleAria')}
        />
      </div>

      {enabled && (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="flex justify-between text-xs uppercase tracking-wider text-muted-foreground">
              <span>{t('viewportLighting.shadowControls.softnessLabel')}</span>
              <button
                type="button"
                onClick={() => setSunAngle(0.53)}
                title={t('viewportLighting.shadowControls.softnessResetTitle')}
                className={cn('tabular-nums transition-colors', Math.abs(sunAngle - 0.53) > 1e-3 && 'text-foreground hover:text-primary')}
              >
                {sunAngle.toFixed(2)}°
              </button>
            </span>
            <input
              type="range"
              aria-label={t('viewportLighting.shadowControls.softnessLabel')}
              min={0.1}
              max={5}
              step={0.05}
              value={sunAngle}
              onChange={(e) => setSunAngle(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>

          <label className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('viewportLighting.shadowControls.qualityLabel')}
            </span>
            <select
              aria-label={t('viewportLighting.shadowControls.qualityAria')}
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value))}
              title={t('viewportLighting.shadowControls.qualityTitle')}
              className="w-full bg-muted/40 rounded px-1.5 py-1 border text-foreground text-xs"
            >
              {RESOLUTIONS.map((r) => (
                <option key={r} value={r}>
                  {resolutionLabel(r, t)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}
