/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quantity set display component for IFC element quantities.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { decodeIfcString } from './encodingUtils';
import type { QuantitySet } from './encodingUtils';

/** Maps quantity type to friendly name for tooltip */
const QUANTITY_TYPE_NAMES: Record<number, string> = {
  0: 'Length',
  1: 'Area',
  2: 'Volume',
  3: 'Count',
  4: 'Weight',
  5: 'Time',
};

export function QuantitySetCard({ qset }: { qset: QuantitySet }) {
  const formatValue = (value: number, type: number): string => {
    if (isNaN(value)) return '\u2014'; // em-dash for empty values
    const formatted = value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    switch (type) {
      case 0: return `${formatted} m`;
      case 1: return `${formatted} m\u00B2`;
      case 2: return `${formatted} m\u00B3`;
      case 3: return formatted;
      case 4: return `${formatted} kg`;
      case 5: return `${formatted} s`;
      default: return formatted;
    }
  };

  return (
    <Collapsible defaultOpen className="border-2 border-blue-200 dark:border-blue-800 bg-blue-50/20 dark:bg-blue-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-left transition-colors overflow-hidden">
        <span className="font-bold text-xs text-blue-700 dark:text-blue-400 truncate flex-1 min-w-0">{decodeIfcString(qset.name)}</span>
        <span className="text-[10px] font-mono bg-blue-100 dark:bg-blue-900/50 px-1.5 py-0.5 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 shrink-0">{qset.quantities.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-blue-200 dark:border-blue-800 divide-y divide-blue-100 dark:divide-blue-900/30">
          {qset.quantities.map((q: { name: string; value: number; type: number }, index: number) => {
            const decodedName = decodeIfcString(q.name);
            const typeName = QUANTITY_TYPE_NAMES[q.type];
            return (
              <div key={`${q.name}-${index}`} className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-blue-50/50 dark:hover:bg-blue-900/20">
                {/* Quantity name with type tooltip */}
                {typeName ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-zinc-500 dark:text-zinc-400 font-medium cursor-help break-words">
                        {decodedName}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px]">
                      {/* bg-primary tooltip: derive from primary-foreground so it
                          reads on the blue/purple surface and in dark mode (#1218) */}
                      <span className="text-primary-foreground/80">{typeName}</span>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="text-zinc-500 dark:text-zinc-400 font-medium break-words">
                    {decodedName}
                  </span>
                )}
                {/* Quantity value */}
                <span className="font-mono text-blue-700 dark:text-blue-400 select-all break-words">
                  {formatValue(q.value, q.type)}
                </span>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
