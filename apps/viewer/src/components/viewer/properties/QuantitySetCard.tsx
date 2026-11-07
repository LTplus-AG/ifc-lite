/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quantity set display component for IFC element quantities.
 */

import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { QuantitySet } from './encodingUtils';
import type { ProjectUnits } from '@ifc-lite/parser';
import { setDisplayName } from './setDisplayName';
import { useTranslation, type TranslationKey } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import { PropertySearchHighlight } from './PropertySearchHighlight';
import { usePersistentDisclosure } from './usePersistentDisclosure';
import { quantityDisplayValue } from './propertyDisplayValue';
import { INSPECTOR_ROWS, INSPECTOR_SECTION, InspectorRow, InspectorSectionTrigger } from './inspector-ui';
import { QuantitySetSourceBadge, type QuantityEntityRef } from './edited-quantities';

/** The Quantities tab's switch sits above these cards. */
export { EditedQuantitiesSwitch } from './edited-quantities';

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
  projectUnitsAvailable?: boolean;
  /** Per-unit-type display-unit overrides (issue #1573 proposal 2). See
   *  `PropertySetCardProps.unitDisplayOverrides`. */
  unitDisplayOverrides?: Record<string, string>;
  searchQuery?: string;
  /** The element the set is on, when it is the selection's own: its card then says when the set was updated from edited geometry. */
  entity?: QuantityEntityRef | null;
}

export function QuantitySetCard({ qset, projectUnits, projectUnitsAvailable = true, unitDisplayOverrides, searchQuery, entity }: QuantitySetCardProps) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = usePersistentDisclosure(`qset:${qset.name}`);
  return (
    <Collapsible open={open || !!searchQuery} onOpenChange={searchQuery ? undefined : setOpen} className={INSPECTOR_SECTION}>
      <InspectorSectionTrigger
        title={<PropertySearchHighlight text={setDisplayName(qset.name, t('properties.quantitySet.unnamed'))} query={searchQuery} />}
        count={formatLocaleNumber(locale, qset.quantities.length)}
        trailing={entity ? <QuantitySetSourceBadge entity={entity} qsetName={qset.name} /> : undefined}
      />
      <CollapsibleContent>
        <div className={INSPECTOR_ROWS}>
          {qset.quantities.map((q, index: number) => {
            // Names render VERBATIM: the parse path already decoded them
            // (see the note on `parsePropertyValue`), and decoding a second
            // time collapses `\\` twice.
            const typeKey = QUANTITY_TYPE_KEYS[q.type];
            const display = quantityDisplayValue(q, projectUnits, unitDisplayOverrides ?? {}, locale, projectUnitsAvailable);
            const nameNode = typeKey ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="min-w-0 truncate cursor-help text-muted-foreground" title={q.name}>
                    <PropertySearchHighlight text={q.name} query={searchQuery} />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-2xs">
                  {/* TooltipContent uses the neutral popover surface (#4767);
                      secondary text uses its semantic muted token instead
                      of a hardcoded primary-foreground opacity tier. */}
                  <span className="text-muted-foreground">{t(typeKey)}</span>
                </TooltipContent>
              </Tooltip>
            ) : <span className="min-w-0 truncate text-muted-foreground" title={q.name}><PropertySearchHighlight text={q.name} query={searchQuery} /></span>;
            return (
              <InspectorRow key={`${q.name}-${index}`} label={q.name} labelCell={nameNode} value={display} mono className="hover:bg-muted/50">
                <PropertySearchHighlight text={display} query={searchQuery} />
              </InspectorRow>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
