/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property set display component with edit support.
 */

import { Sparkles, PenLine, Building2 } from 'lucide-react';
import { PropertyEditor, type PropertyEditScope } from '../PropertyEditor';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import type { PropertySet } from './encodingUtils';
import { setDisplayName } from './setDisplayName';
import { PropertyValueType } from '@ifc-lite/data';
import type { ProjectUnits } from '@ifc-lite/parser';
import { useTranslation } from '@/i18n';
import { usePersistentDisclosure } from './usePersistentDisclosure';
import { PropertySearchHighlight } from './PropertySearchHighlight';
import { propertyDisplayValue } from './propertyDisplayValue';
import { cn } from '@/lib/utils';
import { INSPECTOR_ROWS, INSPECTOR_SECTION, InspectorRow, InspectorSectionTrigger, isNumericDisplay } from './inspector-ui';

export interface PropertySetCardProps {
  pset: PropertySet;
  modelId?: string;
  entityId?: number;
  enableEditing?: boolean;
  /** Whether this property set is inherited from the type entity */
  isTypeProperty?: boolean;
  typeEditScope?: PropertyEditScope;
  /** `"PsetName:PropName"` of a row to transiently highlight + scroll to
   *  (the bSDD "jump to added property" flow, issue #1107). */
  focusedPropKey?: string | null;
  /** The file's declared units, for rendering a unit suffix next to measure
   *  values (issue #1573). */
  projectUnits: ProjectUnits;
  projectUnitsAvailable?: boolean;
  /** Per-unit-type display-unit overrides (issue #1573 proposal 2) when a
   *  property's measure type maps to an overridden unit kind, its value
   *  renders CONVERTED into that unit instead of the file's raw value.
   *  Omitted (or empty) keeps the existing unconverted-file-unit display. */
  unitDisplayOverrides?: Record<string, string>;
  searchQuery?: string;
  sectionScope?: string;
}

export function PropertySetCard({ pset, modelId, entityId, enableEditing, isTypeProperty, typeEditScope, focusedPropKey, projectUnits, projectUnitsAvailable = true, unitDisplayOverrides, searchQuery, sectionScope = 'default' }: PropertySetCardProps) {
  const { t } = useTranslation();
  // Check if any property in this set is mutated
  const hasMutations = pset.properties.some(p => p.isMutated);
  const isNewPset = pset.isNewPset;

  // Row identity for the bSDD focus flow (issue #1107). The entityId is part of
  // the key so an occurrence pset and an inherited type pset of the SAME name
  // don't collide — only the card the property was actually added to matches.
  const keyFor = (propName: string) => `${entityId ?? ''}:${pset.name}:${propName}`;
  const containsFocused = focusedPropKey != null && pset.properties.some(p => keyFor(p.name) === focusedPropKey);

  // Focus and search only override the rendered state. Neither gesture changes
  // the user's saved disclosure preference (#5899).
  const [open, setOpen] = usePersistentDisclosure(`pset:${sectionScope}:${pset.name}`);

  // Source and edit state stay semantic (#8802): a quiet left bar marks a new
  // or edited set, and the header icon says why. The card itself is neutral.
  const accentClass = isNewPset
    ? 'border-l-2 border-l-status-warn'
    : hasMutations
    ? 'border-l-2 border-l-overlay-accent'
    : '';

  return (
    <Collapsible open={open || !!searchQuery || containsFocused} onOpenChange={searchQuery || containsFocused ? undefined : setOpen} className={cn(INSPECTOR_SECTION, accentClass, 'group')}>
      <InspectorSectionTrigger
        title={<PropertySearchHighlight text={setDisplayName(pset.name, t('properties.propertySet.unnamed'))} query={searchQuery} />}
        count={pset.properties.length}
        icon={<>
          {isNewPset && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Sparkles className="h-3.5 w-3.5 text-status-warn shrink-0" />
              </TooltipTrigger>
              <TooltipContent>{t('properties.propertySetCard.newPsetTooltip')}</TooltipContent>
            </Tooltip>
          )}
          {hasMutations && !isNewPset && (
            <Tooltip>
              <TooltipTrigger asChild>
                <PenLine className="h-3.5 w-3.5 text-overlay-accent shrink-0" />
              </TooltipTrigger>
              <TooltipContent>{t('properties.propertySetCard.hasMutationsTooltip')}</TooltipContent>
            </Tooltip>
          )}
          {isTypeProperty && !isNewPset && !hasMutations && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              </TooltipTrigger>
              <TooltipContent>{t('properties.propertySetCard.inheritedFromTypeTooltip')}</TooltipContent>
            </Tooltip>
          )}
        </>}
      />
      <CollapsibleContent>
        <div className={INSPECTOR_ROWS}>
          {pset.properties.map((prop: { name: string; value: unknown; isMutated?: boolean; type?: number; dataType?: string }, index: number) => {
            const display = propertyDisplayValue(prop, projectUnits, unitDisplayOverrides ?? {}, projectUnitsAvailable);
            const { parsed, unit } = display;
            // Names render VERBATIM: the parse path already decoded them (see
            // the note on `parsePropertyValue`), and decoding a second time
            // collapses `\\` twice.
            const isMutated = prop.isMutated;
            const propKey = keyFor(prop.name);
            const isFocused = focusedPropKey != null && focusedPropKey === propKey;
            const editing = Boolean(enableEditing && modelId && entityId && !searchQuery);
            const nameClass = cn('min-w-0 truncate', isMutated ? 'text-foreground' : 'text-muted-foreground');
            const nameText = <PropertySearchHighlight text={prop.name} query={searchQuery} />;
            const nameTrigger = parsed.ifcType ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn(nameClass, 'cursor-help')} title={prop.name}>{nameText}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-2xs">
                  {/* TooltipContent uses the neutral popover surface (#4767);
                      secondary text uses its semantic muted token instead
                      of a hardcoded primary-foreground opacity tier. */}
                  <span className="text-muted-foreground">{parsed.ifcType}</span>
                </TooltipContent>
              </Tooltip>
            ) : <span className={nameClass} title={prop.name}>{nameText}</span>;
            // An edited row puts its badge before the name; the name stays the
            // tooltip trigger itself.
            const nameCell = isMutated ? (
              <span className="flex min-w-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="secondary" className="h-4 shrink-0 px-1 text-2xs bg-overlay-accent-soft text-foreground border-overlay-accent/40">
                      {t('properties.propertySetCard.editedBadge')}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>{t('properties.propertySetCard.propertyModifiedTooltip')}</TooltipContent>
                </Tooltip>
                {nameTrigger}
              </span>
            ) : nameTrigger;
            return (
              <InspectorRow
                // A property set's own property list may repeat a name (the same
                // slack the pset-name uniqueness comment above documents, one
                // level down); index disambiguates the React key.
                key={`${prop.name}-${index}`}
                label={prop.name}
                labelCell={nameCell}
                value={display.full}
                mono={isNumericDisplay(display.value)}
                rowProps={{ 'data-prop-key': propKey }}
                className={cn(
                  'group/prop transition-colors',
                  editing && 'items-start py-0.5',
                  isFocused
                    ? 'bg-amber-100/70 dark:bg-amber-900/40 ring-2 ring-inset ring-amber-400 dark:ring-amber-500 motion-safe:animate-pulse-subtle'
                    : isMutated
                    ? 'bg-overlay-accent-soft hover:bg-overlay-accent/20'
                    : 'hover:bg-muted/50',
                )}
                valueClassName={cn(editing && 'overflow-visible whitespace-normal', isMutated && 'font-semibold')}
              >
                {/* Property value - use PropertyEditor if editing enabled */}
                {/* Search shows the converted display text so a value hit can be highlighted. */}
                {editing && modelId && entityId ? (
                  <PropertyEditor
                    modelId={modelId}
                    entityId={entityId}
                    psetName={pset.name}
                    propName={prop.name}
                    currentValue={prop.value}
                    currentType={prop.type as PropertyValueType | undefined}
                    editScope={typeEditScope}
                  />
                ) : searchQuery ? <PropertySearchHighlight text={display.full} query={searchQuery} /> : <>
                  {display.value}
                  {unit && <span className="ml-1 text-muted-foreground">{unit}</span>}
                </>}
              </InspectorRow>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
