/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Display-unit converter control (issue #1573 proposal 2) - lets the user
 * retarget the rendered unit for a unit-KIND (e.g. Flow rate: m³/s -> m³/h).
 * Purely a display preference: it never touches the model or any stored
 * value, only what `resolveMeasureDisplay`/`resolveQuantityDisplay` render.
 */

import { Ruler, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { UNIT_ALTERNATIVES, alternativesForUnitType } from '@/lib/units/alternatives';

/** Human-readable label for each curated unit kind. Anything in
 *  `UNIT_ALTERNATIVES` without an entry here falls back to its raw token. */
const UNIT_KIND_LABELS: Record<string, string> = {
  LENGTHUNIT: 'Length',
  AREAUNIT: 'Area',
  VOLUMEUNIT: 'Volume',
  MASSUNIT: 'Mass',
  TIMEUNIT: 'Time',
  PLANEANGLEUNIT: 'Angle',
  VOLUMETRICFLOWRATEUNIT: 'Flow rate',
  MASSFLOWRATEUNIT: 'Mass flow rate',
  PRESSUREUNIT: 'Pressure',
  POWERUNIT: 'Power',
  ENERGYUNIT: 'Energy',
  LINEARVELOCITYUNIT: 'Velocity',
  FREQUENCYUNIT: 'Frequency',
  THERMODYNAMICTEMPERATUREUNIT: 'Temperature',
  MASSDENSITYUNIT: 'Density',
  FORCEUNIT: 'Force',
};

/** Sentinel radio value for "no override" (render the file's declared/SI
 *  default unit). An empty string is a valid Radix radio-group value too,
 *  but this reads unambiguously at call sites. */
const FILE_DEFAULT = '__file__';

/** The unit kinds worth surfacing: every curated kind with more than one
 *  alternative (a kind with a single option has nothing to switch to). */
const KINDS = Object.keys(UNIT_ALTERNATIVES).filter((k) => UNIT_ALTERNATIVES[k].length > 1);

export function UnitDisplayControl() {
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const setUnitDisplayOverride = useViewerStore((s) => s.setUnitDisplayOverride);
  const resetUnitDisplayOverrides = useViewerStore((s) => s.resetUnitDisplayOverrides);

  const hasOverrides = Object.keys(unitDisplayOverrides).length > 0;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={`rounded-none hover:bg-zinc-200 dark:hover:bg-zinc-700 ${hasOverrides ? 'text-primary' : ''}`}
            >
              <Ruler className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Display units</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Display units
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {KINDS.map((unitType) => {
          const options = alternativesForUnitType(unitType);
          const overrideId = unitDisplayOverrides[unitType];
          const current = overrideId ? options.find((o) => o.id === overrideId) : undefined;
          return (
            <DropdownMenuSub key={unitType}>
              <DropdownMenuSubTrigger className="text-xs gap-2">
                <span className="flex-1 truncate">{UNIT_KIND_LABELS[unitType] ?? unitType}</span>
                <span className="text-[10px] font-mono text-zinc-400 dark:text-zinc-500">
                  {current ? current.symbol : options[0].symbol}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={overrideId ?? FILE_DEFAULT}
                  onValueChange={(v) => setUnitDisplayOverride(unitType, v === FILE_DEFAULT ? null : v)}
                >
                  <DropdownMenuRadioItem value={FILE_DEFAULT} className="text-xs">
                    File unit
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {options.map((opt) => (
                    <DropdownMenuRadioItem key={opt.id} value={opt.id} className="text-xs">
                      {opt.symbol}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => resetUnitDisplayOverrides()}
          disabled={!hasOverrides}
          className="text-xs gap-2"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset to file units
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
