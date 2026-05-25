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
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  PRECISION_GRIDS,
  hasFailedPrecisionGrid,
  hasLoadedPrecisionGrid,
} from '@/lib/geo/precision-grids';

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
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium border border-emerald-300/60 dark:border-emerald-700/60 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 shrink-0">
            <CheckCircle2 className="h-2.5 w-2.5" />
            grid
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs max-w-xs">
          <div>Precision NTv2/GeoTIFF grid loaded for {spec.region}.</div>
          <div className="mt-1 text-[10px] opacity-80">
            Sub-decimeter datum-shift accuracy via{' '}
            <code className="font-mono">{spec.filename}</code>.
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  if (state === 'failed') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium border border-red-300/60 dark:border-red-700/60 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 shrink-0">
            <AlertTriangle className="h-2.5 w-2.5" />
            grid failed
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs max-w-xs">
          <div>Precision grid fetch failed for {spec.region}.</div>
          <div className="mt-1 text-[10px] opacity-80">
            Falling back to +towgs84 approximation. Check network access to{' '}
            <code className="font-mono">cdn.proj.org</code>.
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium border border-amber-300/60 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 shrink-0">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          loading grid
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs max-w-xs">
        <div>Fetching precision grid for {spec.region}…</div>
        <div className="mt-1 text-[10px] opacity-80">
          Until it arrives, placement uses the +towgs84 approximation (off by
          up to ~120 m for this CRS).
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
