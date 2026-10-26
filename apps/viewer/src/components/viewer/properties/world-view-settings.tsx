/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Georeferencing panel's world-view section (Cesium overlay active): the
 * sampled surface height with its OrthogonalHeight snap, the vertical-datum
 * switch, and the lazy-loaded globe placement control.
 */

import { lazy, Suspense } from 'react';
import { Mountain } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

const GlobePlacementControl = lazy(() => import('./GlobePlacementControl'));

export function WorldViewSettings({ onSetOrthogonalHeight }: {
  /** Snap OrthogonalHeight to the sampled terrain; omitted when the georeference is not editable. */
  onSetOrthogonalHeight?: (terrainSaveHeight: number) => void;
}) {
  const { t, locale } = useTranslation();
  const cesiumTerrainHeight = useViewerStore((s) => s.cesiumTerrainHeight);
  // Geoid-inverted target for snapping OrthogonalHeight to terrain (#1456); the
  // raw cesiumTerrainHeight is still shown to the user.
  const cesiumTerrainSaveHeight = useViewerStore((s) => s.cesiumTerrainSaveHeight);
  const cesiumTerrainSource = useViewerStore((s) => s.cesiumTerrainSource);
  const heightsAreEllipsoidal = useViewerStore((s) => s.cesiumHeightsAreEllipsoidal);
  const setHeightsAreEllipsoidal = useViewerStore((s) => s.setCesiumHeightsAreEllipsoidal);
  const terrainHeight = cesiumTerrainHeight !== null
    ? formatLocaleNumber(locale, cesiumTerrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
    : null;
  return (
    <div className="px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-900 space-y-1">
      <div className="flex items-center gap-2">
        <Mountain className="h-3 w-3 text-teal-500 shrink-0" />
        <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1">{t('properties.georef.visibleSurfaceHeight')}</span>
        {terrainHeight !== null ? (
          <span className="text-xs font-mono text-teal-500" title={cesiumTerrainSource ?? undefined}>
            {t('properties.georef.heightMeters', { value: terrainHeight })}
          </span>
        ) : (
          <span className="text-xs font-mono text-zinc-400">{t('properties.georef.queryingEllipsis')}</span>
        )}
      </div>
      {cesiumTerrainSource && (
        <div className="ml-5 text-xs text-zinc-500 dark:text-zinc-400">
          {t('properties.georef.sampledVia', { source: cesiumTerrainSource })}
        </div>
      )}
      {terrainHeight !== null && cesiumTerrainSaveHeight !== null && onSetOrthogonalHeight && (
        <div className="flex items-center gap-1 ml-5">
          <button
            onClick={() => onSetOrthogonalHeight(cesiumTerrainSaveHeight)}
            className="text-xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors flex items-center gap-0.5"
          >
            <Mountain className="h-2.5 w-2.5" />
            {t('properties.georef.setOrthogonalHeightButton', { value: terrainHeight })}
          </button>
        </div>
      )}
      {/* Vertical-datum interpretation: OrthogonalHeight is orthometric by
          spec, so we add the geoid undulation N to convert it to the
          ellipsoidal height Cesium expects (default). Allow opting out for
          the rare file whose heights are already ellipsoidal (#1355). */}
      <Checkbox
        checked={heightsAreEllipsoidal}
        onCheckedChange={setHeightsAreEllipsoidal}
        containerClassName="ml-5"
        className="mt-0.5 h-3 w-3"
        label={<span className="text-xs text-zinc-600 dark:text-zinc-400">{t('properties.georef.heightsEllipsoidalLabel')}</span>}
        description={<span className="text-xs text-zinc-400 dark:text-zinc-500">{t('properties.georef.heightsEllipsoidalHelp')}</span>}
      />
      <Suspense fallback={null}><GlobePlacementControl /></Suspense>
    </div>
  );
}
