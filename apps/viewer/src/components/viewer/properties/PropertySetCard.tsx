/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property set display component with edit support.
 */

import { useState, useEffect } from 'react';
import { Sparkles, PenLine, Building2 } from 'lucide-react';
import { PropertyEditor, type PropertyEditScope } from '../PropertyEditor';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { decodeIfcString, parsePropertyValue } from './encodingUtils';
import type { PropertySet } from './encodingUtils';
import { PropertyValueType } from '@ifc-lite/data';

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
}

export function PropertySetCard({ pset, modelId, entityId, enableEditing, isTypeProperty, typeEditScope, focusedPropKey }: PropertySetCardProps) {
  // Check if any property in this set is mutated
  const hasMutations = pset.properties.some(p => p.isMutated);
  const isNewPset = pset.isNewPset;

  // Row identity for the bSDD focus flow (issue #1107). The entityId is part of
  // the key so an occurrence pset and an inherited type pset of the SAME name
  // don't collide — only the card the property was actually added to matches.
  const keyFor = (propName: string) => `${entityId ?? ''}:${pset.name}:${propName}`;
  const containsFocused = focusedPropKey != null && pset.properties.some(p => keyFor(p.name) === focusedPropKey);

  // Self-control the collapse so a focused row can't hide inside a pset the user
  // previously collapsed — force it open when this card holds the focus target.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (containsFocused) setOpen(true);
  }, [containsFocused]);

  // Dynamic styling based on mutation state and source
  const borderClass = isNewPset
    ? 'border-2 border-amber-400/50 dark:border-amber-500/30'
    : hasMutations
    ? 'border-2 border-purple-300/50 dark:border-purple-500/30'
    : isTypeProperty
    ? 'border-2 border-indigo-200/60 dark:border-indigo-800/40'
    : 'border-2 border-zinc-200 dark:border-zinc-800';

  const bgClass = isNewPset
    ? 'bg-amber-50/30 dark:bg-amber-950/20'
    : hasMutations
    ? 'bg-purple-50/20 dark:bg-purple-950/10'
    : isTypeProperty
    ? 'bg-indigo-50/20 dark:bg-indigo-950/10'
    : 'bg-white dark:bg-zinc-950';

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`${borderClass} ${bgClass} group w-full max-w-full overflow-hidden`}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full p-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900 text-left transition-colors overflow-hidden">
        {isNewPset && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Sparkles className="h-3.5 w-3.5 text-amber-500 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>New property set (not in original model)</TooltipContent>
          </Tooltip>
        )}
        {hasMutations && !isNewPset && (
          <Tooltip>
            <TooltipTrigger asChild>
              <PenLine className="h-3.5 w-3.5 text-purple-500 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>Has modified properties</TooltipContent>
          </Tooltip>
        )}
        {isTypeProperty && !isNewPset && !hasMutations && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Building2 className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>Inherited from type — edits apply to all instances of this type</TooltipContent>
          </Tooltip>
        )}
        <span className="font-bold text-xs text-zinc-900 dark:text-zinc-100 truncate flex-1 min-w-0">{decodeIfcString(pset.name)}</span>
        <span className="text-[10px] font-mono bg-zinc-100 dark:bg-zinc-900 px-1.5 py-0.5 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">{pset.properties.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t-2 border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-900">
          {pset.properties.map((prop: { name: string; value: unknown; isMutated?: boolean; type?: number }) => {
            const parsed = parsePropertyValue(prop.value);
            const decodedName = decodeIfcString(prop.name);
            const isMutated = prop.isMutated;
            const propKey = keyFor(prop.name);
            const isFocused = focusedPropKey != null && focusedPropKey === propKey;

            return (
              <div
                key={prop.name}
                data-prop-key={propKey}
                className={`flex items-start justify-between gap-2 px-3 py-2 text-xs group/prop transition-colors ${
                  isFocused
                    ? 'bg-amber-100/70 dark:bg-amber-900/40 ring-2 ring-inset ring-amber-400 dark:ring-amber-500 motion-safe:animate-pulse-subtle'
                    : isMutated
                    ? 'bg-purple-50/50 dark:bg-purple-950/30 hover:bg-purple-100/50 dark:hover:bg-purple-900/30'
                    : 'hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50'
                }`}
              >
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  {/* Property name with type tooltip and mutation indicator */}
                  <div className="flex items-center gap-1.5">
                    {isMutated && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="secondary" className="h-4 px-1 text-[9px] bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700">
                            edited
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>This property has been modified</TooltipContent>
                      </Tooltip>
                    )}
                    {parsed.ifcType ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={`font-medium cursor-help break-words ${isMutated ? 'text-purple-600 dark:text-purple-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
                            {decodedName}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-[10px]">
                          <span className="text-zinc-400">{parsed.ifcType}</span>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className={`font-medium break-words ${isMutated ? 'text-purple-600 dark:text-purple-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
                        {decodedName}
                      </span>
                    )}
                  </div>
                  {/* Property value - use PropertyEditor if editing enabled */}
                  {enableEditing && modelId && entityId ? (
                    <PropertyEditor
                      modelId={modelId}
                      entityId={entityId}
                      psetName={pset.name}
                      propName={prop.name}
                      currentValue={prop.value}
                      currentType={prop.type as PropertyValueType | undefined}
                      editScope={typeEditScope}
                    />
                  ) : (
                    <span className={`font-mono select-all break-words ${isMutated ? 'text-purple-900 dark:text-purple-100 font-semibold' : 'text-zinc-900 dark:text-zinc-100'}`}>
                      {parsed.displayValue}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
