/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bSDD (buildingSMART Data Dictionary) integration card.
 *
 * Shows schema-defined property sets and properties for the selected
 * IFC entity type, fetched live from the bSDD API.  Users can add
 * properties to the element in one click.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { BookOpen, Plus, Check, Loader2, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useViewerStore } from '@/store';
import { type PropertyValue, PropertyValueType, QuantityType } from '@ifc-lite/data';
import {
  fetchClassInfo,
  bsddDataTypeLabel,
  type BsddClassInfo,
  type BsddClassProperty,
} from '@/services/bsdd';

// ---------------------------------------------------------------------------
// Helpers for Qto_* (quantity set) detection and mapping
// ---------------------------------------------------------------------------

/** Returns true when the property set name denotes a quantity set */
function isQuantitySet(psetName: string): boolean {
  return psetName.startsWith('Qto_');
}

/** Infer QuantityType from bSDD unit strings */
function inferQuantityType(units: string[] | null): QuantityType {
  if (!units || units.length === 0) return QuantityType.Count;
  const u = units[0].toLowerCase();
  if (u === 'm' || u === 'mm' || u === 'cm') return QuantityType.Length;
  if (u.includes('m²') || u.includes('m2')) return QuantityType.Area;
  if (u.includes('m³') || u.includes('m3')) return QuantityType.Volume;
  if (u === 'kg' || u === 'g' || u === 't') return QuantityType.Weight;
  if (u === 's' || u === 'h' || u === 'min') return QuantityType.Time;
  return QuantityType.Count;
}

// ---------------------------------------------------------------------------
// bSDD data type → PropertyValueType mapping
// ---------------------------------------------------------------------------

function toPropertyValueType(bsddType: string | null): PropertyValueType {
  if (!bsddType) return PropertyValueType.String;
  const lower = bsddType.toLowerCase();
  if (lower === 'boolean') return PropertyValueType.Boolean;
  if (lower === 'real' || lower === 'number') return PropertyValueType.Real;
  if (lower === 'integer') return PropertyValueType.Integer;
  if (lower === 'character' || lower === 'string') return PropertyValueType.String;
  return PropertyValueType.Label;
}

function defaultValue(bsddType: string | null): PropertyValue {
  // Boolean gets a concrete default (false) so the value is valid the moment
  // it's added and the inline Switch has a state to toggle. Everything else
  // starts empty for manual entry (issue #1107, item 10).
  if (toPropertyValueType(bsddType) === PropertyValueType.Boolean) return false;
  return '';
}

/** Which inline value control (if any) a bSDD property offers before "Add". */
function inlineControlKind(prop: BsddClassProperty): 'boolean' | 'enum' | null {
  if (toPropertyValueType(prop.dataType) === PropertyValueType.Boolean) return 'boolean';
  if (prop.allowedValues && prop.allowedValues.length > 0) return 'enum';
  return null;
}

/** bSDD properties with null propertySet are IFC entity-level attributes */
const BSDD_ATTRIBUTES_GROUP = 'Attributes';

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface BsddCardProps {
  /** IFC type name of the selected entity, e.g. "IfcWall" */
  entityType: string;
  /** Model ID for mutations */
  modelId: string;
  /** Express ID of the entity to add properties to */
  entityId: number;
  /** Names of property sets already present on the entity */
  existingPsets: string[];
  /** Names of properties already present on the entity (flat list: "PsetName:PropName") */
  existingProps: Set<string>;
  /** Names of quantity sets already present on the entity */
  existingQsets?: string[];
  /** Names of quantities already present (flat list: "QsetName:QuantName") */
  existingQuants?: Set<string>;
  /** Names of entity-level attributes that already have values */
  existingAttributes?: Set<string>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BsddCard({
  entityType,
  modelId,
  entityId,
  existingPsets,
  existingProps,
  existingQsets = [],
  existingQuants = new Set<string>(),
  existingAttributes = new Set<string>(),
}: BsddCardProps) {
  const [classInfo, setClassInfo] = useState<BsddClassInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPsets, setExpandedPsets] = useState<Set<string>>(new Set());
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());
  // Values the user sets inline (boolean/enum) before clicking Add, keyed by
  // `${psetName}:${prop.name}` — issue #1107, item 10.
  const [pendingValues, setPendingValues] = useState<Map<string, PropertyValue>>(new Map());

  const setPendingValue = useCallback((key: string, value: PropertyValue) => {
    setPendingValues((prev) => new Map(prev).set(key, value));
  }, []);

  const setProperty = useViewerStore((s) => s.setProperty);
  const createPropertySet = useViewerStore((s) => s.createPropertySet);
  const setQuantity = useViewerStore((s) => s.setQuantity);
  const createQuantitySet = useViewerStore((s) => s.createQuantitySet);
  const storeSetAttribute = useViewerStore((s) => s.setAttribute);
  const bumpMutationVersion = useViewerStore((s) => s.bumpMutationVersion);

  // Fetch class info from bSDD when entity type changes
  useEffect(() => {
    let cancelled = false;
    setClassInfo(null);
    setError(null);
    setAddedKeys(new Set());

    if (!entityType) return;

    setLoading(true);
    fetchClassInfo(entityType).then(
      (info) => {
        if (cancelled) return;
        setLoading(false);
        if (info && info.classProperties.length > 0) {
          setClassInfo(info);
        } else {
          setClassInfo(null);
        }
      },
      (err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Failed to fetch bSDD data');
      },
    );

    return () => {
      cancelled = true;
    };
  }, [entityType]);

  // Group properties by property set name
  const groupedProps = useMemo(() => {
    if (!classInfo) return new Map<string, BsddClassProperty[]>();
    const map = new Map<string, BsddClassProperty[]>();
    for (const prop of classInfo.classProperties) {
      // Null propertySet → IFC entity attributes (Name, Description, etc.)
      const psetName = prop.propertySet || BSDD_ATTRIBUTES_GROUP;
      let list = map.get(psetName);
      if (!list) {
        list = [];
        map.set(psetName, list);
      }
      list.push(prop);
    }
    return map;
  }, [classInfo]);

  const togglePset = useCallback((name: string) => {
    setExpandedPsets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleAddProperty = useCallback(
    (psetName: string, prop: BsddClassProperty, valueOverride?: PropertyValue) => {
      let normalizedModelId = modelId;
      if (modelId === 'legacy') normalizedModelId = '__legacy__';

      if (psetName === BSDD_ATTRIBUTES_GROUP) {
        // Route entity-level attributes (Name, Description, ObjectType, Tag, etc.)
        storeSetAttribute(normalizedModelId, entityId, prop.name, '');
      } else if (isQuantitySet(psetName)) {
        // Route Qto_* through quantity creation
        const qType = inferQuantityType(prop.units);
        const qsetExists = existingQsets.includes(psetName);

        if (!qsetExists) {
          createQuantitySet(normalizedModelId, entityId, psetName, [
            { name: prop.name, value: NaN, quantityType: qType, unit: prop.units?.[0] },
          ]);
        } else {
          setQuantity(
            normalizedModelId,
            entityId,
            psetName,
            prop.name,
            NaN,
            qType,
            prop.units?.[0],
          );
        }
      } else {
        // Route Pset_* / other through property creation
        const valueType = toPropertyValueType(prop.dataType);
        const value = valueOverride !== undefined ? valueOverride : defaultValue(prop.dataType);
        const psetExists = existingPsets.includes(psetName);

        if (!psetExists) {
          createPropertySet(normalizedModelId, entityId, psetName, [
            { name: prop.name, value, type: valueType },
          ]);
        } else {
          setProperty(
            normalizedModelId,
            entityId,
            psetName,
            prop.name,
            value,
            valueType,
          );
        }
      }

      bumpMutationVersion();
      setAddedKeys((prev) => new Set(prev).add(`${psetName}:${prop.name}`));
    },
    [modelId, entityId, existingPsets, existingQsets, setProperty, createPropertySet, setQuantity, createQuantitySet, storeSetAttribute, bumpMutationVersion],
  );

  const handleAddAllInPset = useCallback(
    (psetName: string, props: BsddClassProperty[]) => {
      let normalizedModelId = modelId;
      if (modelId === 'legacy') normalizedModelId = '__legacy__';

      const isAttrGroup = psetName === BSDD_ATTRIBUTES_GROUP;

      // Determine which "existing" set to check against
      const existingSet = isAttrGroup
        ? existingAttributes
        : isQuantitySet(psetName)
          ? existingQuants
          : existingProps;

      // For attributes, key is just the name; for props/quants, key is "PsetName:PropName"
      const toAdd = props.filter(
        (p) => {
          const key = isAttrGroup ? p.name : `${psetName}:${p.name}`;
          const addedKey = `${psetName}:${p.name}`;
          return !existingSet.has(key) && !addedKeys.has(addedKey);
        },
      );
      if (toAdd.length === 0) return;

      if (isAttrGroup) {
        // Route entity-level attributes
        for (const p of toAdd) {
          storeSetAttribute(normalizedModelId, entityId, p.name, '');
        }
      } else if (isQuantitySet(psetName)) {
        // Route Qto_* through quantity creation
        const qsetExists = existingQsets.includes(psetName);

        if (!qsetExists) {
          createQuantitySet(
            normalizedModelId,
            entityId,
            psetName,
            toAdd.map((p) => ({
              name: p.name,
              value: NaN,
              quantityType: inferQuantityType(p.units),
              unit: p.units?.[0],
            })),
          );
        } else {
          for (const p of toAdd) {
            setQuantity(
              normalizedModelId,
              entityId,
              psetName,
              p.name,
              NaN,
              inferQuantityType(p.units),
              p.units?.[0],
            );
          }
        }
      } else {
        const psetExists = existingPsets.includes(psetName);

        if (!psetExists) {
          createPropertySet(
            normalizedModelId,
            entityId,
            psetName,
            toAdd.map((p) => ({
              name: p.name,
              value: defaultValue(p.dataType),
              type: toPropertyValueType(p.dataType),
            })),
          );
        } else {
          for (const p of toAdd) {
            setProperty(
              normalizedModelId,
              entityId,
              psetName,
              p.name,
              defaultValue(p.dataType),
              toPropertyValueType(p.dataType),
            );
          }
        }
      }

      bumpMutationVersion();
      setAddedKeys((prev) => {
        const next = new Set(prev);
        for (const p of toAdd) next.add(`${psetName}:${p.name}`);
        return next;
      });
    },
    [modelId, entityId, existingPsets, existingQsets, existingProps, existingQuants, existingAttributes, addedKeys, setProperty, createPropertySet, setQuantity, createQuantitySet, storeSetAttribute, bumpMutationVersion],
  );

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-6 text-xs text-zinc-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Loading bSDD data for {entityType}...</span>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="px-3 py-4 text-xs text-red-500/70">
        <p>Could not load bSDD data: {error}</p>
      </div>
    );
  }

  // No data
  if (!classInfo || groupedProps.size === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center px-4 py-8 text-xs text-zinc-400 gap-2">
        <BookOpen className="h-6 w-6 text-zinc-300 dark:text-zinc-600" />
        <p>No bSDD data available for <span className="font-mono font-medium">{entityType}</span></p>
      </div>
    );
  }

  return (
    <div className="space-y-2 w-full min-w-0 overflow-hidden">
      {/* Header with class description */}
      {classInfo.definition && (
        <div className="px-1 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
          {classInfo.definition}
        </div>
      )}

      {/* Property sets from bSDD */}
      {Array.from(groupedProps.entries()).map(([psetName, props]) => {
        const isExpanded = expandedPsets.has(psetName);
        const isAttrGroup = psetName === BSDD_ATTRIBUTES_GROUP;
        const isQto = isQuantitySet(psetName);
        // For attributes, check against existingAttributes (keyed by name only);
        // for quants/props, check against existingQuants/existingProps (keyed by "PsetName:PropName")
        const existingSet = isAttrGroup ? existingAttributes : isQto ? existingQuants : existingProps;
        const makeKey = (p: BsddClassProperty) => isAttrGroup ? p.name : `${psetName}:${p.name}`;
        const allAlreadyExist = props.every(
          (p) =>
            existingSet.has(makeKey(p)) ||
            addedKeys.has(`${psetName}:${p.name}`),
        );
        const psetExistsOnEntity = isAttrGroup
          ? true // Attributes section always exists on the entity
          : isQto
            ? existingQsets.includes(psetName)
            : existingPsets.includes(psetName);
        const addableCount = props.filter(
          (p) =>
            !existingSet.has(makeKey(p)) &&
            !addedKeys.has(`${psetName}:${p.name}`),
        ).length;

        return (
          <div
            key={psetName}
            className="border-2 border-sky-200/60 dark:border-sky-800/40 bg-sky-50/20 dark:bg-sky-950/10 w-full overflow-hidden"
          >
            {/* Pset header */}
            <button
              className="flex items-center gap-1.5 w-full p-2 hover:bg-sky-50 dark:hover:bg-sky-900/20 text-left transition-colors overflow-hidden"
              onClick={() => togglePset(psetName)}
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3 text-sky-500 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 text-sky-500 shrink-0" />
              )}
              <span className="font-bold text-xs text-sky-800 dark:text-sky-300 truncate flex-1 min-w-0">
                {psetName}
              </span>
              <span className="text-[10px] font-mono bg-sky-100 dark:bg-sky-900/50 px-1 py-0.5 border border-sky-200 dark:border-sky-800 text-sky-600 dark:text-sky-400 shrink-0">
                {props.length}
              </span>
              {addableCount > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 p-0 shrink-0 hover:bg-sky-200 dark:hover:bg-sky-800"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddAllInPset(psetName, props);
                      }}
                    >
                      <Plus className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Add all {addableCount} properties</TooltipContent>
                </Tooltip>
              )}
              {allAlreadyExist && (
                <Check className="h-3 w-3 text-emerald-500 shrink-0" />
              )}
            </button>

            {/* Properties */}
            {isExpanded && (
              <div className="border-t-2 border-sky-200/60 dark:border-sky-800/40 divide-y divide-sky-100 dark:divide-sky-900/30">
                {props.map((prop) => {
                  const existKey = makeKey(prop);
                  const addedKey = `${psetName}:${prop.name}`;
                  const alreadyExists = existingSet.has(existKey) || addedKeys.has(addedKey);

                  return (
                    <div
                      key={prop.name}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs overflow-hidden ${
                        alreadyExists
                          ? 'bg-emerald-50/30 dark:bg-emerald-950/10'
                          : 'hover:bg-sky-50/50 dark:hover:bg-sky-900/20'
                      }`}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-medium text-zinc-600 dark:text-zinc-400 cursor-help truncate flex-1 min-w-0">
                            {prop.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-[10px]">
                          <p className="font-medium">{prop.name}</p>
                          {prop.description && <p className="mt-0.5 text-zinc-400">{prop.description}</p>}
                          {prop.dataType && <p className="mt-0.5 text-sky-400">{bsddDataTypeLabel(prop.dataType)}</p>}
                        </TooltipContent>
                      </Tooltip>
                      {/* Inline value control for boolean / enum so a value can
                          be set before adding (issue #1107, item 10). */}
                      {!alreadyExists && inlineControlKind(prop) === 'boolean' && (
                        <Switch
                          checked={pendingValues.get(addedKey) === true}
                          onCheckedChange={(v) => setPendingValue(addedKey, v)}
                          className="shrink-0"
                          aria-label={`Set ${prop.name}`}
                        />
                      )}
                      {!alreadyExists && inlineControlKind(prop) === 'enum' && (
                        <Select
                          value={typeof pendingValues.get(addedKey) === 'string' ? (pendingValues.get(addedKey) as string) : undefined}
                          onValueChange={(v) => setPendingValue(addedKey, v)}
                        >
                          <SelectTrigger className="h-6 w-28 shrink-0 px-2 text-[11px]">
                            <SelectValue placeholder="Value…" />
                          </SelectTrigger>
                          <SelectContent>
                            {prop.allowedValues!.filter((av) => av.value).map((av) => (
                              <SelectItem key={av.value} value={av.value} className="text-xs">
                                {av.value}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {/* Add button - always visible on right */}
                      {alreadyExists ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 p-0 shrink-0 hover:bg-sky-200 dark:hover:bg-sky-800"
                              onClick={() => handleAddProperty(psetName, prop, pendingValues.get(addedKey))}
                            >
                              <Plus className="h-3 w-3 text-sky-600 dark:text-sky-400" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Add to element</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Footer link */}
      <div className="flex items-center justify-center pt-1 pb-1">
        <a
          href={`https://search.bsdd.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/${entityType}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[10px] text-sky-500/70 hover:text-sky-600 transition-colors"
        >
          <ExternalLink className="h-2.5 w-2.5" />
          View on bSDD
        </a>
      </div>
    </div>
  );
}
