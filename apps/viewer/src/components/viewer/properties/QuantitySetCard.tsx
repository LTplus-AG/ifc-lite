/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quantity set display component for IFC element quantities.
 */

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { QuantitySet } from './encodingUtils';
import type { ProjectUnits } from '@ifc-lite/parser';
import { resolveQuantityDisplay } from '@/lib/units/display';
import { setDisplayName } from './setDisplayName';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { PropertySearchHighlight } from './PropertySearchHighlight';
import { usePersistentDisclosure } from './usePersistentDisclosure';

/** Maps quantity type to friendly name for tooltip */
const QUANTITY_TYPE_KEYS: Record<number, TranslationKey> = {
  0: 'properties.quantitySet.type.length',
  1: 'properties.quantitySet.type.area',
  2: 'properties.quantitySet.type.volume',
  3: 'properties.quantitySet.type.count',
  4: 'properties.quantitySet.type.weight',
  5: 'properties.quantitySet.type.time',
};

export interface QuantitySetCardProps {
  qset: QuantitySet;
  projectUnits: ProjectUnits;
  /** Per-unit-type display-unit overrides (issue #1573 proposal 2). See
   *  `PropertySetCardProps.unitDisplayOverrides`. */
  unitDisplayOverrides?: Record<string, string>;
  searchQuery?: string;
}

export function QuantitySetCard({ qset, projectUnits, unitDisplayOverrides, searchQuery }: QuantitySetCardProps) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = usePersistentDisclosure(`qset:${qset.name}`);
  const formatValue = (value: number, type: number): string => {
    if (isNaN(value)) return '\u2014'; // em-dash for empty values
    const disp = resolveQuantityDisplay(value, type, projectUnits, unitDisplayOverrides ?? {});
    const formatted = formatLocaleNumber(locale, disp.converted ?? value, {
      maximumFractionDigits: disp.converted !== null ? 4 : 3,
    });
    return disp.unit ? `${formatted} ${disp.unit}` : formatted;
  };

  return (
    <Collapsible open={open || !!searchQuery} onOpenChange={searchQuery ? undefined : setOpen} className="border-2 border-blue-200 dark:border-blue-800 bg-blue-50/20 dark:bg-blue-950/20 w-full max-w-full overflow-hidden">
      <CollapsibleTrigger className="group/disclosure flex items-center gap-2 w-full p-2.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-left transition-colors overflow-hidden">
        <span className="font-bold text-xs text-blue-700 dark:text-blue-400 truncate flex-1 min-w-0"><PropertySearchHighlight text={setDisplayName(qset.name, t('properties.quantitySet.unnamed'))} query={searchQuery} /></span>
        <span className="text-[10px] font-mono bg-blue-100 dark:bg-blue-900/50 px-1.5 py-0.5 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 shrink-0">{formatLocaleNumber(locale, qset.quantities.length)}</span>
        <ChevronDown className="size-3 shrink-0 transition-transform group-data-[state=closed]/disclosure:-rotate-90" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-blue-200 dark:border-blue-800 divide-y divide-blue-100 dark:divide-blue-900/30">
          {qset.quantities.map((q: { name: string; value: number; type: number }, index: number) => {
            // Names render VERBATIM: the parse path already decoded them
            // (see the note on `parsePropertyValue`), and decoding a second
            // time collapses `\\` twice.
            const typeKey = QUANTITY_TYPE_KEYS[q.type];
            return (
              <div key={`${q.name}-${index}`} className="flex flex-col gap-0.5 px-3 py-2 text-xs hover:bg-blue-50/50 dark:hover:bg-blue-900/20">
                {/* Quantity name with type tooltip */}
                {typeKey ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-zinc-500 dark:text-zinc-400 font-medium cursor-help break-words">
                          <PropertySearchHighlight text={q.name} query={searchQuery} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[10px]">
                      {/* TooltipContent uses the neutral popover surface (#4767);
                          secondary text uses its semantic muted token instead
                          of a hardcoded primary-foreground opacity tier. */}
                      <span className="text-muted-foreground">{t(typeKey)}</span>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span className="text-zinc-500 dark:text-zinc-400 font-medium break-words">
                    <PropertySearchHighlight text={q.name} query={searchQuery} />
                  </span>
                )}
                {/* Quantity value */}
                <span className="font-mono text-blue-700 dark:text-blue-400 select-all break-words">
                  <PropertySearchHighlight text={formatValue(q.value, q.type)} query={searchQuery} />
                </span>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
