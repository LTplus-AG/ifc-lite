/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Small badge in the GeoreferencingPanel header that tells the user
 * whether their CRS is using a precision NTv2/GeoTIFF datum-shift grid
 * (sub-decimeter accuracy) or the +towgs84 fallback (up to ~120 m error
 * for Bessel-based national grids like RD/NL, OSGB/UK, MGI/AT).
 *
 * Re-checks on a short interval so it flips from "loading" → "loaded"
 * after the grid finishes downloading without forcing the parent to
 * re-render.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  PRECISION_GRIDS,
  hasFailedPrecisionGrid,
  hasLoadedPrecisionGrid,
} from '@/lib/geo/precision-grids';
import { useTranslation } from '@/i18n';

interface PrecisionGridBadgeProps {
  crsName: string | undefined;
}

function extractEpsgCode(crsName: string | undefined): string | null {
  if (!crsName) return null;
  const match = crsName.match(/EPSG[:\s]*(\d+)/i);
  return match ? match[1] : null;
}

type BadgeState = 'loading' | 'loaded' | 'failed';

export function PrecisionGridBadge({ crsName }: PrecisionGridBadgeProps) {
  const { t } = useTranslation();
  const code = extractEpsgCode(crsName);
  const spec = code ? PRECISION_GRIDS[code] : undefined;
  const [state, setState] = useState<BadgeState>(() => {
    if (!spec) return 'loading';
    if (hasLoadedPrecisionGrid(code!)) return 'loaded';
    if (hasFailedPrecisionGrid(code!)) return 'failed';
    return 'loading';
  });

  useEffect(() => {
    if (!spec || state !== 'loading') return;
    // Poll every 250ms until the grid loader settles (success or failure).
    // Cheap — PRECISION_GRIDS lookup is O(1) and most CRSs never trigger
    // this path. Stops as soon as the grid resolves or the component
    // unmounts.
    const id = setInterval(() => {
      if (hasLoadedPrecisionGrid(code!)) {
        setState('loaded');
      } else if (hasFailedPrecisionGrid(code!)) {
        setState('failed');
      }
    }, 250);
    return () => clearInterval(id);
  }, [spec, state, code]);

  // CRS without a registered precision grid — accuracy depends entirely on
  // whether its +towgs84 is good (ETRS89/WGS84-aligned CRSs: yes; old
  // Bessel/Airy national grids: no). Don't show a badge for these.
  if (!spec) return null;

  if (state === 'loaded') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium border border-emerald-300/60 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 shrink-0">
            <CheckCircle2 className="h-2.5 w-2.5" />
            {t('properties.precisionGrid.loadedBadge')}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs max-w-xs">
          <div>{t('properties.precisionGrid.loadedTooltip', { region: spec.region })}</div>
          <div className="mt-1 text-2xs opacity-80">
            {t('properties.precisionGrid.loadedDetail', { filename: spec.filename })}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (state === 'failed') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium border border-red-300/60 dark:border-red-700/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" />
            {t('properties.precisionGrid.failedBadge')}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs max-w-xs">
          <div>{t('properties.precisionGrid.failedTooltip', { region: spec.region })}</div>
          <div className="mt-1 text-2xs opacity-80">
            {t('properties.precisionGrid.failedDetail', { host: 'cdn.proj.org' })}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs font-medium border border-amber-300/60 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 shrink-0">
          <Spinner className="h-2.5 w-2.5" />
          {t('properties.precisionGrid.loadingBadge')}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs max-w-xs">
        <div>{t('properties.precisionGrid.loadingTooltip', { region: spec.region })}</div>
        <div className="mt-1 text-2xs opacity-80">
          {t('properties.precisionGrid.loadingDetail')}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
