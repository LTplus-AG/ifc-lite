/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Mountain } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

/** Small button to apply Cesium terrain height to OrthogonalHeight field */
export function TerrainHeightButton({ modelId, editable, onApply }: {
  modelId?: string;
  editable?: boolean;
  onApply: (height: number) => void;
}) {
  const { t, locale } = useTranslation();
  const cesiumEnabled = useViewerStore(s => s.cesiumEnabled);
  const terrainHeight = useViewerStore(s => s.cesiumTerrainHeight);
  // Geoid-inverted snap target (#1456); display still uses terrainHeight.
  const terrainSaveHeight = useViewerStore(s => s.cesiumTerrainSaveHeight);
  const terrainSource = useViewerStore(s => s.cesiumTerrainSource);
  const sourceModelId = useViewerStore(s => s.cesiumSourceModelId);

  // Only the active Cesium model, once the geoid-corrected snap target is ready (#1456).
  if (!cesiumEnabled || terrainHeight === null || terrainSaveHeight === null || !editable || !modelId || modelId !== sourceModelId) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onApply(terrainSaveHeight);
          }}
          className="flex items-center gap-0.5 text-2xs text-teal-500 hover:text-teal-700 dark:hover:text-teal-300 transition-colors mt-0.5"
        >
          <Mountain className="h-2.5 w-2.5" />
          <span>{t('properties.georef.heightMeters', { value: formatLocaleNumber(locale, terrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {terrainSource
          ? t('properties.georef.setOrthogonalHeightTooltipViaSource', { value: formatLocaleNumber(locale, terrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), source: terrainSource })
          : t('properties.georef.setOrthogonalHeightTooltip', { value: formatLocaleNumber(locale, terrainHeight, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}
      </TooltipContent>
    </Tooltip>
  );
}
