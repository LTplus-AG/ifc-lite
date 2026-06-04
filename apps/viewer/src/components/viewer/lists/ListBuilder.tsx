/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ListBuilder - Configure a list by selecting entity types, columns, and conditions
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Play,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { IfcTypeEnum } from '@ifc-lite/data';
import type {
  ListDataProvider,
  ListDefinition,
  ColumnDefinition,
  DiscoveredColumns,
  PropertyCondition,
  ConditionOperator,
} from '@ifc-lite/lists';
import { discoverColumns, ENTITY_ATTRIBUTES } from '@ifc-lite/lists';

// Building element types available for selection
const SELECTABLE_TYPES: { type: IfcTypeEnum; label: string }[] = [
  { type: IfcTypeEnum.IfcWall, label: 'Walls' },
  { type: IfcTypeEnum.IfcWallStandardCase, label: 'Walls (Standard)' },
  { type: IfcTypeEnum.IfcDoor, label: 'Doors' },
  { type: IfcTypeEnum.IfcWindow, label: 'Windows' },
  { type: IfcTypeEnum.IfcSlab, label: 'Slabs' },
  { type: IfcTypeEnum.IfcColumn, label: 'Columns' },
  { type: IfcTypeEnum.IfcBeam, label: 'Beams' },
  { type: IfcTypeEnum.IfcStair, label: 'Stairs' },
  { type: IfcTypeEnum.IfcRamp, label: 'Ramps' },
  { type: IfcTypeEnum.IfcRoof, label: 'Roofs' },
  { type: IfcTypeEnum.IfcCovering, label: 'Coverings' },
  { type: IfcTypeEnum.IfcCurtainWall, label: 'Curtain Walls' },
  { type: IfcTypeEnum.IfcRailing, label: 'Railings' },
  { type: IfcTypeEnum.IfcSpace, label: 'Spaces' },
  { type: IfcTypeEnum.IfcBuildingStorey, label: 'Storeys' },
  { type: IfcTypeEnum.IfcDistributionElement, label: 'MEP Distribution' },
  { type: IfcTypeEnum.IfcFlowTerminal, label: 'MEP Terminals' },
  { type: IfcTypeEnum.IfcFlowSegment, label: 'MEP Segments' },
  { type: IfcTypeEnum.IfcFlowFitting, label: 'MEP Fittings' },
];

// Fixed semantic / spatial columns (not name-discovered like psets/qtos).
const SEMANTIC_COLUMNS: { id: string; source: ColumnDefinition['source']; label: string }[] = [
  { id: 'col-material', source: 'material', label: 'Material' },
  { id: 'col-classification', source: 'classification', label: 'Classification' },
  { id: 'col-storey', source: 'spatial', label: 'Storey' },
];

interface ListBuilderProps {
  providers: ListDataProvider[];
  initial: ListDefinition | null;
  onSave: (definition: ListDefinition) => void;
  onCancel: () => void;
  onExecute: (definition: ListDefinition) => void;
}

export function ListBuilder({ providers, initial, onSave, onCancel, onExecute }: ListBuilderProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selectedTypes, setSelectedTypes] = useState<Set<IfcTypeEnum>>(
    new Set(initial?.entityTypes ?? [])
  );
  const [columns, setColumns] = useState<ColumnDefinition[]>(initial?.columns ?? []);
  const [conditions, setConditions] = useState<PropertyCondition[]>(initial?.conditions ?? []);
  const [columnsExpanded, setColumnsExpanded] = useState(true);
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  // Count entities per type across all providers
  const typeCounts = useMemo(() => {
    const counts = new Map<IfcTypeEnum, number>();
    for (const { type } of SELECTABLE_TYPES) {
      let total = 0;
      for (const p of providers) {
        total += p.getEntitiesByType(type).length;
      }
      if (total > 0) counts.set(type, total);
    }
    return counts;
  }, [providers]);

  // Discover available columns whenever selected types change (across all
  // providers). With no types selected the list targets every element, so
  // discovery returns the built-in attributes only (pset/qto discovery needs
  // a type to sample) — that's enough to pick Name/Class/etc. columns.
  const discovered = useMemo<DiscoveredColumns>(() => {
    return discoverColumns(providers, Array.from(selectedTypes));
  }, [providers, selectedTypes]);

  const toggleType = useCallback((type: IfcTypeEnum) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const addColumn = useCallback((col: ColumnDefinition) => {
    setColumns(prev => {
      if (prev.some(c => c.id === col.id)) return prev;
      return [...prev, col];
    });
  }, []);

  const removeColumn = useCallback((id: string) => {
    setColumns(prev => prev.filter(c => c.id !== id));
  }, []);

  const moveColumn = useCallback((idx: number, direction: -1 | 1) => {
    setColumns(prev => {
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[idx];
      next[idx] = next[target];
      next[target] = tmp;
      return next;
    });
  }, []);

  const addCondition = useCallback((condition: PropertyCondition) => {
    setConditions(prev => [...prev, condition]);
  }, []);

  const updateCondition = useCallback((idx: number, condition: PropertyCondition) => {
    setConditions(prev => prev.map((c, i) => (i === idx ? condition : c)));
  }, []);

  const removeCondition = useCallback((idx: number) => {
    setConditions(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const buildDefinition = useCallback((): ListDefinition => {
    return {
      id: initial?.id ?? crypto.randomUUID(),
      name: name || 'Untitled List',
      description: description || undefined,
      createdAt: initial?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      entityTypes: Array.from(selectedTypes),
      conditions,
      columns,
    };
  }, [initial, name, description, selectedTypes, conditions, columns]);

  const handleSave = useCallback(() => {
    onSave(buildDefinition());
  }, [buildDefinition, onSave]);

  const handleRun = useCallback(() => {
    const def = buildDefinition();
    onExecute(def);
  }, [buildDefinition, onExecute]);

  const selectedColumnIds = useMemo(() => new Set(columns.map(c => c.id)), [columns]);

  const totalSelectedEntities = useMemo(() => {
    let count = 0;
    for (const type of selectedTypes) {
      count += typeCounts.get(type) ?? 0;
    }
    return count;
  }, [selectedTypes, typeCounts]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Name & Description */}
          <div className="space-y-2">
            <Input
              placeholder="List name..."
              value={name}
              onChange={e => setName(e.target.value)}
              className="h-8 text-sm"
            />
            <Input
              placeholder="Description (optional)"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          <Separator />

          {/* Entity Type Selection */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Entity Types
              </span>
              {selectedTypes.size > 0 && (
                <Badge variant="secondary" className="text-xs h-5">
                  {totalSelectedEntities} entities
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {SELECTABLE_TYPES.map(({ type, label }) => {
                const count = typeCounts.get(type);
                if (!count) return null; // Don't show types not in model
                const selected = selectedTypes.has(type);
                return (
                  <button
                    key={type}
                    onClick={() => toggleType(type)}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
                      selected
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-border hover:bg-muted'
                    }`}
                  >
                    {label}
                    <span className={selected ? 'opacity-75' : 'text-muted-foreground'}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Filters / Conditions */}
          <ConditionsSection
            conditions={conditions}
            expanded={filtersExpanded}
            onToggle={() => setFiltersExpanded((v) => !v)}
            onAdd={addCondition}
            onUpdate={updateCondition}
            onRemove={removeCondition}
          />

          <Separator />

          {selectedTypes.size === 0 && (
            <p className="text-[11px] text-muted-foreground">
              No entity types selected — this list targets <strong>all model elements</strong>
              {' '}(everything with geometry). Add filters above (e.g. Name, Material,
              Classification, Storey) to narrow it.
            </p>
          )}

          {/* Column Selection */}
          <div>
                <button
                  className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider w-full"
                  onClick={() => setColumnsExpanded(!columnsExpanded)}
                >
                  {columnsExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Columns ({columns.length} selected)
                </button>

                {columnsExpanded && (
                  <div className="mt-2 space-y-2">
                    {/* Selected columns (reorderable) */}
                    {columns.length > 0 && (
                      <div className="space-y-0.5 mb-2">
                        {columns.map((col, idx) => (
                          <div
                            key={col.id}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-muted/50 text-xs"
                          >
                            <span className="text-muted-foreground w-4 text-right">{idx + 1}</span>
                            <span className="flex-1 truncate">
                              {col.label ?? col.propertyName}
                              {col.psetName && (
                                <span className="text-muted-foreground ml-1">({col.psetName})</span>
                              )}
                            </span>
                            <button
                              onClick={() => moveColumn(idx, -1)}
                              disabled={idx === 0}
                              className={`${idx === 0 ? 'text-muted-foreground/30' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                              <ChevronUp className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => moveColumn(idx, 1)}
                              disabled={idx === columns.length - 1}
                              className={`${idx === columns.length - 1 ? 'text-muted-foreground/30' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => removeColumn(col.id)}
                              className="text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Available columns */}
                    <ColumnPicker
                      discovered={discovered}
                      selectedIds={selectedColumnIds}
                      onAdd={addColumn}
                    />
                  </div>
                )}
              </div>
        </div>
      </ScrollArea>

      {/* Bottom Actions */}
      <div className="flex items-center gap-2 px-3 py-2 border-t">
        <Button
          variant="default"
          size="sm"
          onClick={handleRun}
          disabled={columns.length === 0}
          className="text-xs h-7"
        >
          <Play className="h-3 w-3 mr-1" />
          Run
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSave}
          disabled={columns.length === 0}
          className="text-xs h-7"
        >
          <Save className="h-3 w-3 mr-1" />
          Save
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-xs h-7">
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Column Picker
// ============================================================================

interface ColumnPickerProps {
  discovered: DiscoveredColumns;
  selectedIds: Set<string>;
  onAdd: (col: ColumnDefinition) => void;
}

function ColumnPicker({ discovered, selectedIds, onAdd }: ColumnPickerProps) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['attributes']));

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  return (
    <div className="space-y-1 text-xs">
      {/* Attributes */}
      <CollapsibleSection
        title="Attributes"
        expanded={expandedSections.has('attributes')}
        onToggle={() => toggleSection('attributes')}
      >
        {discovered.attributes.map(attr => {
          const id = `attr-${attr.toLowerCase()}`;
          const isSelected = selectedIds.has(id);
          return (
            <PickerItem
              key={id}
              label={attr}
              selected={isSelected}
              onClick={() => {
                if (!isSelected) {
                  onAdd({ id, source: 'attribute', propertyName: attr });
                }
              }}
            />
          );
        })}
      </CollapsibleSection>

      {/* Spatial & materials (fixed columns, not name-discovered) */}
      <CollapsibleSection
        title="Spatial & Materials"
        expanded={expandedSections.has('semantics')}
        onToggle={() => toggleSection('semantics')}
      >
        {SEMANTIC_COLUMNS.map(({ id, source, label }) => {
          const isSelected = selectedIds.has(id);
          return (
            <PickerItem
              key={id}
              label={label}
              selected={isSelected}
              onClick={() => {
                if (!isSelected) {
                  onAdd({ id, source, propertyName: label, label });
                }
              }}
            />
          );
        })}
      </CollapsibleSection>

      {/* Property Sets */}
      {Array.from(discovered.properties.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([psetName, propNames]) => (
          <CollapsibleSection
            key={`pset-${psetName}`}
            title={psetName}
            badge="P"
            expanded={expandedSections.has(`pset-${psetName}`)}
            onToggle={() => toggleSection(`pset-${psetName}`)}
          >
            {propNames.map(propName => {
              const id = `prop-${psetName}-${propName}`.toLowerCase().replace(/\s+/g, '-');
              const isSelected = selectedIds.has(id);
              return (
                <PickerItem
                  key={id}
                  label={propName}
                  selected={isSelected}
                  onClick={() => {
                    if (!isSelected) {
                      onAdd({ id, source: 'property', psetName, propertyName: propName, label: propName });
                    }
                  }}
                />
              );
            })}
          </CollapsibleSection>
        ))}

      {/* Quantity Sets */}
      {Array.from(discovered.quantities.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([qsetName, quantNames]) => (
          <CollapsibleSection
            key={`qset-${qsetName}`}
            title={qsetName}
            badge="Q"
            expanded={expandedSections.has(`qset-${qsetName}`)}
            onToggle={() => toggleSection(`qset-${qsetName}`)}
          >
            {quantNames.map(quantName => {
              const id = `quant-${qsetName}-${quantName}`.toLowerCase().replace(/\s+/g, '-');
              const isSelected = selectedIds.has(id);
              return (
                <PickerItem
                  key={id}
                  label={quantName}
                  selected={isSelected}
                  onClick={() => {
                    if (!isSelected) {
                      onAdd({ id, source: 'quantity', psetName: qsetName, propertyName: quantName, label: quantName });
                    }
                  }}
                />
              );
            })}
          </CollapsibleSection>
        ))}
    </div>
  );
}

function CollapsibleSection({
  title,
  badge,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  badge?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        className="flex items-center gap-1 w-full px-1 py-0.5 rounded hover:bg-muted/50 text-xs"
        onClick={onToggle}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium truncate">{title}</span>
        {badge && (
          <span className="ml-auto text-[10px] bg-muted px-1 rounded">{badge}</span>
        )}
      </button>
      {expanded && <div className="pl-4 space-y-0">{children}</div>}
    </div>
  );
}

function PickerItem({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1 w-full px-1 py-0.5 rounded text-xs ${
        selected
          ? 'text-muted-foreground cursor-default'
          : 'hover:bg-muted/50 cursor-pointer'
      }`}
      onClick={onClick}
      disabled={selected}
    >
      <Plus className={`h-2.5 w-2.5 ${selected ? 'invisible' : ''}`} />
      <span className="truncate">{label}</span>
      {selected && <span className="ml-auto text-[10px] text-muted-foreground">added</span>}
    </button>
  );
}

// ============================================================================
// Conditions (filters)
// ============================================================================

type ConditionSource = PropertyCondition['source'];

const CONDITION_SOURCES: { source: ConditionSource; label: string }[] = [
  { source: 'attribute', label: 'Attribute' },
  { source: 'property', label: 'Property' },
  { source: 'quantity', label: 'Quantity' },
  { source: 'material', label: 'Material' },
  { source: 'classification', label: 'Classification' },
  { source: 'spatial', label: 'Storey' },
];

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  equals: '=',
  notEquals: '≠',
  contains: 'contains',
  gt: '>',
  lt: '<',
  gte: '≥',
  lte: '≤',
  exists: 'is set',
};

function operatorsFor(source: ConditionSource): ConditionOperator[] {
  switch (source) {
    case 'quantity':
      return ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte', 'exists'];
    case 'material':
    case 'classification':
      return ['contains', 'equals', 'notEquals', 'exists'];
    default:
      return ['equals', 'notEquals', 'contains', 'exists'];
  }
}

function defaultConditionFor(source: ConditionSource): PropertyCondition {
  switch (source) {
    case 'property':
      return { source, psetName: '', propertyName: '', operator: 'equals', value: '' };
    case 'quantity':
      return { source, psetName: '', propertyName: '', operator: 'gt', value: '' };
    case 'material':
      return { source, propertyName: 'Material', operator: 'contains', value: '' };
    case 'classification':
      return { source, propertyName: 'Classification', operator: 'contains', value: '' };
    case 'spatial':
      return { source, propertyName: 'Storey', operator: 'equals', value: '' };
    case 'attribute':
    default:
      return { source: 'attribute', propertyName: 'Name', operator: 'contains', value: '' };
  }
}

const SELECT_CLASS =
  'h-6 rounded border border-border bg-background px-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring';

interface ConditionsSectionProps {
  conditions: PropertyCondition[];
  expanded: boolean;
  onToggle: () => void;
  onAdd: (condition: PropertyCondition) => void;
  onUpdate: (idx: number, condition: PropertyCondition) => void;
  onRemove: (idx: number) => void;
}

function ConditionsSection({
  conditions,
  expanded,
  onToggle,
  onAdd,
  onUpdate,
  onRemove,
}: ConditionsSectionProps) {
  return (
    <div>
      <button
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider w-full"
        onClick={onToggle}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Filters ({conditions.length})
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {conditions.map((condition, idx) => (
            <ConditionRow
              key={idx}
              condition={condition}
              onChange={(next) => onUpdate(idx, next)}
              onRemove={() => onRemove(idx)}
            />
          ))}
          <button
            onClick={() => onAdd(defaultConditionFor('attribute'))}
            className="flex items-center gap-1 px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" /> Add filter
          </button>
        </div>
      )}
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: PropertyCondition;
  onChange: (next: PropertyCondition) => void;
  onRemove: () => void;
}) {
  const ops = operatorsFor(condition.source);
  const showValue = condition.operator !== 'exists';
  const showSetFields = condition.source === 'property' || condition.source === 'quantity';

  const valuePlaceholder =
    condition.source === 'spatial'
      ? 'storey name'
      : condition.source === 'material'
        ? 'material'
        : condition.source === 'classification'
          ? 'code or name'
          : 'value';

  return (
    <div className="flex flex-wrap items-center gap-1 rounded bg-muted/50 px-2 py-1 text-xs">
      <select
        value={condition.source}
        onChange={(e) => onChange(defaultConditionFor(e.target.value as ConditionSource))}
        className={SELECT_CLASS}
        aria-label="Filter dimension"
      >
        {CONDITION_SOURCES.map((s) => (
          <option key={s.source} value={s.source}>{s.label}</option>
        ))}
      </select>

      {condition.source === 'attribute' && (
        <select
          value={condition.propertyName}
          onChange={(e) => onChange({ ...condition, propertyName: e.target.value })}
          className={SELECT_CLASS}
          aria-label="Attribute"
        >
          {ENTITY_ATTRIBUTES.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      )}

      {showSetFields && (
        <>
          <Input
            value={condition.psetName ?? ''}
            placeholder={condition.source === 'quantity' ? 'Qto_…' : 'Pset_…'}
            onChange={(e) => onChange({ ...condition, psetName: e.target.value })}
            className="h-6 w-28 text-xs"
          />
          <Input
            value={condition.propertyName}
            placeholder="name"
            onChange={(e) => onChange({ ...condition, propertyName: e.target.value })}
            className="h-6 w-24 text-xs"
          />
        </>
      )}

      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as ConditionOperator })}
        className={SELECT_CLASS}
        aria-label="Operator"
      >
        {ops.map((op) => (
          <option key={op} value={op}>{OPERATOR_LABEL[op]}</option>
        ))}
      </select>

      {showValue && (
        <Input
          value={String(condition.value ?? '')}
          placeholder={valuePlaceholder}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
          className="h-6 flex-1 min-w-[6rem] text-xs"
        />
      )}

      <button
        onClick={onRemove}
        aria-label="Remove filter"
        className="ml-auto text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}
