/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Layers, ArrowUpDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface SpatialLocationInfo {
  storeyName: string;
  elevation?: number;
  height?: number;
}

/** The selected entity's containing storey, with elevation/height readouts.
 *  Extracted out of PropertiesPanel.tsx as a plain presentational sibling —
 *  it owns no state of its own, it only renders `spatialInfo`. */
export function SpatialLocationBadge({ spatialInfo }: { spatialInfo: SpatialLocationInfo | null }) {
  if (!spatialInfo) return null;

  return (
    <div className="flex items-center gap-2 text-xs border border-emerald-500/30 bg-emerald-50/50 dark:bg-emerald-900/10 px-2 py-1.5 text-emerald-800 dark:text-emerald-400 min-w-0">
      <Layers className="h-3.5 w-3.5 shrink-0" />
      <span className="font-bold uppercase tracking-wide truncate min-w-0 flex-1">{spatialInfo.storeyName}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        {spatialInfo.elevation !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-emerald-600/70 dark:text-emerald-500/70 font-mono whitespace-nowrap">
                {spatialInfo.elevation >= 0 ? '+' : ''}{spatialInfo.elevation.toFixed(2)}m
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Elevation: {spatialInfo.elevation >= 0 ? '+' : ''}{spatialInfo.elevation.toFixed(2)}m from ground</p>
            </TooltipContent>
          </Tooltip>
        )}
        {spatialInfo.height !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 text-emerald-500/60 dark:text-emerald-400/60 font-mono text-[10px] whitespace-nowrap">
                <ArrowUpDown className="h-2.5 w-2.5 shrink-0" />
                <span className="hidden sm:inline">{spatialInfo.height.toFixed(2)}m</span>
                <span className="sm:hidden">{spatialInfo.height.toFixed(1)}m</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs">Height: {spatialInfo.height.toFixed(2)}m to next storey</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
