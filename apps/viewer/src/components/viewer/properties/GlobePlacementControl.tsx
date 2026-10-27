/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Globe placement: Auto / Anchor / Exact" for the Cesium world view
 * (`lib/geo/globe-placement.ts`), with the anchor-error estimate the bridge
 * published. Lazy-loaded by the Georeferencing panel's world-view section.
 */

import { SegmentedControl } from '@/components/ui/segmented-control';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { GlobePlacementMode } from '@/lib/geo/globe-placement';

export default function GlobePlacementControl() {
  const { t, locale } = useTranslation();
  const mode = useViewerStore((s) => s.cesiumGlobePlacement);
  const setMode = useViewerStore((s) => s.setCesiumGlobePlacement);
  const status = useViewerStore((s) => s.cesiumGlobePlacementStatus);
  const options: Array<{ value: GlobePlacementMode; label: string }> = [
    { value: 'auto', label: t('properties.georef.globePlacement.auto') },
    { value: 'anchor', label: t('properties.georef.globePlacement.anchor') },
    { value: 'exact', label: t('properties.georef.globePlacement.exact') },
  ];
  const errorCm = status?.anchorErrorMetres;
  return (
    <div className="ml-5 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1">{t('properties.georef.globePlacement.label')}</span>
        <SegmentedControl size="sm" label={t('properties.georef.globePlacement.label')} value={mode} options={options} onValueChange={setMode} />
      </div>
      {status && (
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {status.mode === 'exact' ? t('properties.georef.globePlacement.resolvedExact') : t('properties.georef.globePlacement.resolvedAnchor')}
          {errorCm != null && (
            <span className="ml-1 font-mono">
              {t('properties.georef.globePlacement.estimate', {
                value: formatLocaleNumber(locale, errorCm * 100, { maximumFractionDigits: errorCm < 0.1 ? 1 : 0 }),
              })}
            </span>
          )}
        </div>
      )}
      <div className="text-xs text-zinc-400 dark:text-zinc-500">{t('properties.georef.globePlacement.help')}</div>
    </div>
  );
}
