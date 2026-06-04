/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ListBuilder — configure a list: scope (entity types + filters), the
 * columns to show, and optional grouping / totals.
 *
 * UI is organised as labelled sections with a consistent header treatment.
 * The most-used columns (attributes + Material / Classification / Storey)
 * are surfaced as a flat chip grid; property/quantity sets — which can be
 * numerous — stay in collapsible groups below.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Play, Plus, Trash2, ChevronDown, ChevronRight, ChevronUp, Save, Check, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
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

/** Column descriptor shared by the quick-add grid. */
interface CommonColumn { id: string; source: ColumnDefinition['source']; propertyName: string; label: string }

/**
 * The first-class columns: built-in attributes plus the spatial / semantic
 * columns. Surfaced as a flat grid so Material / Classification / Storey
 * are as reachable as Name / Class — not buried in a collapsed group.
 */
const COMMON_COLUMNS: CommonColumn[] = [
  ...ENTITY_ATTRIBUTES.map((a): CommonColumn => ({
    id: `attr-${a.toLowerCase()}`,
    source: 'attribute',
    propertyName: a,
    label: a,
  })),
  { id: 'col-material', source: 'material', propertyName: 'Material', label: 'Material' },
  { id: 'col-classification', source: 'classification', propertyName: 'Classification', label: 'Classification' },
  { id: 'col-storey', source: 'spatial', propertyName: 'Storey', label: 'Storey' },
];

/** Union the per-provider complete-discovery results into one column set. */
function mergeDiscovered(parts: DiscoveredColumns[]): DiscoveredColumns {
  const properties = new Map<string, Set<string>>();
  const quantities = new Map<string, Set<string>>();
  const merge = (target: Map<string, Set<string>>, src: Map<string, string[]>) => {
    for (const [k, arr] of src) {
      let b = target.get(k);
      if (!b) { b = new Set(); target.set(k, b); }
      for (const v of arr) b.add(v);
    }
  };
  for (const d of parts) { merge(properties, d.properties); merge(quantities, d.quantities); }
  const toSorted = (m: Map<string, Set<string>>) => {
    const out = new Map<string, string[]>();
    for (const [k, s] of m) out.set(k, Array.from(s).sort());
    return out;
  };
  return { attributes: [...ENTITY_ATTRIBUTES], properties: toSorted(properties), quantities: toSorted(quantities) };
}

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
  const [groupByColumnId, setGroupByColumnId] = useState<string>(initial?.grouping?.columnId ?? '');
  const [sumColumnIds, setSumColumnIds] = useState<Set<string>>(
    new Set(initial?.grouping?.sumColumnIds ?? [])
  );

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

  // Available columns. Prefer COMPLETE, type-independent discovery (every
  // property set / quantity set in the model) so all properties/quantities
  // are addable even with no entity type selected. Fall back to the
  // type-sampled discovery for providers that can't enumerate completely.
  const discovered = useMemo<DiscoveredColumns>(() => {
    const complete = providers.filter((p) => typeof p.discoverAllColumns === 'function');
    if (providers.length > 0 && complete.length === providers.length) {
      return mergeDiscovered(complete.map((p) => p.discoverAllColumns!()));
    }
    return discoverColumns(providers, Array.from(selectedTypes));
  }, [providers, selectedTypes]);

  const toggleType = useCallback((type: IfcTypeEnum) => {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const addColumn = useCallback((col: ColumnDefinition) => {
    setColumns(prev => (prev.some(c => c.id === col.id) ? prev : [...prev, col]));
  }, []);

  const removeColumn = useCallback((id: string) => {
    setColumns(prev => prev.filter(c => c.id !== id));
    // Keep grouping consistent when its column is removed.
    setGroupByColumnId(prev => (prev === id ? '' : prev));
    setSumColumnIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleColumn = useCallback((col: ColumnDefinition) => {
    setColumns(prev => (prev.some(c => c.id === col.id) ? prev.filter(c => c.id !== col.id) : [...prev, col]));
  }, []);

  const moveColumn = useCallback((idx: number, direction: -1 | 1) => {
    setColumns(prev => {
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
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

  const toggleSumColumn = useCallback((id: string) => {
    setSumColumnIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const buildDefinition = useCallback((): ListDefinition => {
    const groupValid = groupByColumnId && columns.some(c => c.id === groupByColumnId);
    const grouping = groupValid
      ? {
          columnId: groupByColumnId,
          sumColumnIds: columns.filter(c => sumColumnIds.has(c.id)).map(c => c.id),
        }
      : undefined;
    return {
      id: initial?.id ?? crypto.randomUUID(),
      name: name || 'Untitled List',
      description: description || undefined,
      createdAt: initial?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      entityTypes: Array.from(selectedTypes),
      // Preserve a filter-snapshot scope (set at creation; not edited here).
      expressIdsByModel: initial?.expressIdsByModel,
      conditions,
      columns,
      grouping,
    };
  }, [initial, name, description, selectedTypes, conditions, columns, groupByColumnId, sumColumnIds]);

  const handleSave = useCallback(() => onSave(buildDefinition()), [buildDefinition, onSave]);
  const handleRun = useCallback(() => onExecute(buildDefinition()), [buildDefinition, onExecute]);

  const selectedColumnIds = useMemo(() => new Set(columns.map(c => c.id)), [columns]);
  const totalSelectedEntities = useMemo(() => {
    let count = 0;
    for (const type of selectedTypes) count += typeCounts.get(type) ?? 0;
    return count;
  }, [selectedTypes, typeCounts]);

  // A snapshot list (from "Create list" in the search filter) is frozen to an
  // explicit element set; the entity-type scope doesn't apply.
  const snapshotCount = initial?.expressIdsByModel
    ? Object.values(initial.expressIdsByModel).reduce((n, ids) => n + ids.length, 0)
    : 0;
  const isSnapshot = snapshotCount > 0;

  const canRun = columns.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <ScrollArea className="flex-1">
        <div className="px-3 py-3 space-y-5">
          {/* Identity */}
          <div className="space-y-2">
            <Input
              placeholder="List name…"
              value={name}
              onChange={e => setName(e.target.value)}
              className="h-9 text-sm font-medium"
            />
            <Input
              placeholder="Description (optional)"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="h-7 text-xs"
            />
          </div>

          {/* Scope: entity types — or a frozen filter snapshot */}
          <Section
            label="Scope"
            hint={isSnapshot
              ? `${snapshotCount.toLocaleString()} elements · snapshot`
              : selectedTypes.size > 0
                ? `${totalSelectedEntities.toLocaleString()} elements`
                : 'All elements'}
          >
            {isSnapshot ? (
              <p className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                <strong className="font-medium text-foreground">Filter snapshot</strong> — frozen to the{' '}
                {snapshotCount.toLocaleString()} elements that matched the search filter. Entity-type scope
                doesn&apos;t apply; configure columns and grouping below.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {SELECTABLE_TYPES.map(({ type, label }) => {
                    const count = typeCounts.get(type);
                    if (!count) return null;
                    return (
                      <Chip
                        key={type}
                        selected={selectedTypes.has(type)}
                        onClick={() => toggleType(type)}
                        trailing={count.toLocaleString()}
                      >
                        {label}
                      </Chip>
                    );
                  })}
                </div>
                {selectedTypes.size === 0 && (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    No type selected — the list targets <strong className="font-medium text-foreground">all model elements</strong>.
                    Use filters to narrow by name, material, classification or storey.
                  </p>
                )}
              </>
            )}
          </Section>

          {/* Filters */}
          <Section label="Filters" hint={conditions.length > 0 ? `${conditions.length}` : undefined}>
            <ConditionsBody
              conditions={conditions}
              onAdd={addCondition}
              onUpdate={updateCondition}
              onRemove={removeCondition}
            />
          </Section>

          {/* Columns */}
          <Section label="Columns" hint={columns.length > 0 ? `${columns.length}` : undefined}>
            {columns.length > 0 && (
              <SelectedColumns columns={columns} onMove={moveColumn} onRemove={removeColumn} />
            )}
            <ColumnPicker
              discovered={discovered}
              selectedIds={selectedColumnIds}
              onAdd={addColumn}
              onToggle={toggleColumn}
            />
          </Section>

          {/* Grouping & totals */}
          {columns.length > 0 && (
            <Section label="Grouping & Totals">
              <GroupingBody
                columns={columns}
                groupByColumnId={groupByColumnId}
                sumColumnIds={sumColumnIds}
                onGroupByChange={setGroupByColumnId}
                onToggleSum={toggleSumColumn}
              />
            </Section>
          )}
        </div>
      </ScrollArea>

      {/* Bottom actions */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-t bg-muted/30">
        <Button size="sm" onClick={handleRun} disabled={!canRun} className="h-8 gap-1.5 text-xs font-medium">
          <Play className="h-3.5 w-3.5" /> Run
        </Button>
        <Button variant="outline" size="sm" onClick={handleSave} disabled={!canRun} className="h-8 gap-1.5 text-xs">
          <Save className="h-3.5 w-3.5" /> Save
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel} className="h-8 text-xs">
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// Section shell — consistent header with an accent rule
// ============================================================================

function Section({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="h-3 w-1 rounded-full bg-primary/70" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {hint !== undefined && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">{hint}</Badge>
        )}
      </div>
      {children}
    </section>
  );
}

function Chip({
  selected,
  onClick,
  trailing,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        selected
          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
          : 'border-border bg-background hover:bg-muted',
      )}
    >
      {children}
      {trailing !== undefined && (
        <span className={cn('tabular-nums', selected ? 'opacity-80' : 'text-muted-foreground')}>{trailing}</span>
      )}
    </button>
  );
}

// ============================================================================
// Selected columns (ordered, reorderable)
// ============================================================================

function SelectedColumns({
  columns,
  onMove,
  onRemove,
}: {
  columns: ColumnDefinition[];
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-3 space-y-1">
      {columns.map((col, idx) => (
        <div
          key={col.id}
          className="group flex items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 py-1 text-xs"
        >
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{idx + 1}</span>
          <span className="flex-1 truncate font-medium">
            {col.label ?? col.propertyName}
            {col.psetName && <span className="ml-1 font-normal text-muted-foreground">· {col.psetName}</span>}
          </span>
          <ColSourceTag source={col.source} />
          <button
            onClick={() => onMove(idx, -1)}
            disabled={idx === 0}
            aria-label="Move up"
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-25"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onMove(idx, 1)}
            disabled={idx === columns.length - 1}
            aria-label="Move down"
            className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-25"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onRemove(col.id)}
            aria-label="Remove column"
            className="shrink-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

const SOURCE_TAG: Record<ColumnDefinition['source'], string> = {
  attribute: 'attr',
  property: 'pset',
  quantity: 'qty',
  material: 'mat',
  classification: 'cls',
  spatial: 'storey',
};

function ColSourceTag({ source }: { source: ColumnDefinition['source'] }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      {SOURCE_TAG[source]}
    </span>
  );
}

// ============================================================================
// Column Picker — flat "common" grid + collapsible pset/qto groups
// ============================================================================

interface ColumnPickerProps {
  discovered: DiscoveredColumns;
  selectedIds: Set<string>;
  onAdd: (col: ColumnDefinition) => void;
  onToggle: (col: ColumnDefinition) => void;
}

function ColumnPicker({ discovered, selectedIds, onAdd, onToggle }: ColumnPickerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleSection = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const psetEntries = useMemo(
    () => Array.from(discovered.properties.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [discovered.properties],
  );
  const qtoEntries = useMemo(
    () => Array.from(discovered.quantities.entries()).sort(([a], [b]) => a.localeCompare(b)),
    [discovered.quantities],
  );

  return (
    <div className="space-y-2">
      {/* Quick-add grid of the first-class columns */}
      <div className="flex flex-wrap gap-1.5">
        {COMMON_COLUMNS.map(({ id, source, propertyName, label }) => {
          const selected = selectedIds.has(id);
          return (
            <Chip
              key={id}
              selected={selected}
              onClick={() => onToggle({ id, source, propertyName, label })}
            >
              {selected && <Check className="h-3 w-3" />}
              {label}
            </Chip>
          );
        })}
      </div>

      {(psetEntries.length > 0 || qtoEntries.length > 0) && (
        <div className="rounded-md border border-border/60">
          {psetEntries.map(([psetName, propNames]) => (
            <PickerGroup
              key={`pset-${psetName}`}
              title={psetName}
              badge="Pset"
              expanded={expanded.has(`pset-${psetName}`)}
              onToggle={() => toggleSection(`pset-${psetName}`)}
            >
              {propNames.map(propName => {
                const id = `prop-${psetName}-${propName}`.toLowerCase().replace(/\s+/g, '-');
                return (
                  <PickerItem
                    key={id}
                    label={propName}
                    selected={selectedIds.has(id)}
                    onAdd={() => onAdd({ id, source: 'property', psetName, propertyName: propName, label: propName })}
                  />
                );
              })}
            </PickerGroup>
          ))}
          {qtoEntries.map(([qsetName, quantNames]) => (
            <PickerGroup
              key={`qset-${qsetName}`}
              title={qsetName}
              badge="Qty"
              expanded={expanded.has(`qset-${qsetName}`)}
              onToggle={() => toggleSection(`qset-${qsetName}`)}
            >
              {quantNames.map(quantName => {
                const id = `quant-${qsetName}-${quantName}`.toLowerCase().replace(/\s+/g, '-');
                return (
                  <PickerItem
                    key={id}
                    label={quantName}
                    selected={selectedIds.has(id)}
                    onAdd={() => onAdd({ id, source: 'quantity', psetName: qsetName, propertyName: quantName, label: quantName })}
                  />
                );
              })}
            </PickerGroup>
          ))}
        </div>
      )}
    </div>
  );
}

function PickerGroup({
  title,
  badge,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  badge: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-muted/50"
        onClick={onToggle}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate font-medium">{title}</span>
        <span className="ml-auto rounded bg-muted px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
          {badge}
        </span>
      </button>
      {expanded && <div className="px-1 pb-1">{children}</div>}
    </div>
  );
}

function PickerItem({
  label,
  selected,
  onAdd,
}: {
  label: string;
  selected: boolean;
  onAdd: () => void;
}) {
  return (
    <button
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-xs',
        selected ? 'cursor-default text-muted-foreground' : 'cursor-pointer hover:bg-muted/60',
      )}
      onClick={onAdd}
      disabled={selected}
    >
      {selected ? <Check className="h-3 w-3 text-primary" /> : <Plus className="h-3 w-3" />}
      <span className="truncate">{label}</span>
      {selected && <span className="ml-auto text-[10px]">added</span>}
    </button>
  );
}

// ============================================================================
// Grouping & totals
// ============================================================================

function GroupingBody({
  columns,
  groupByColumnId,
  sumColumnIds,
  onGroupByChange,
  onToggleSum,
}: {
  columns: ColumnDefinition[];
  groupByColumnId: string;
  sumColumnIds: Set<string>;
  onGroupByChange: (id: string) => void;
  onToggleSum: (id: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border/60 bg-card p-2.5">
      <label className="flex items-center gap-2 text-xs">
        <span className="w-16 shrink-0 text-muted-foreground">Group by</span>
        <select
          value={groupByColumnId}
          onChange={(e) => onGroupByChange(e.target.value)}
          className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">— None (flat list) —</option>
          {columns.map((c) => (
            <option key={c.id} value={c.id}>{c.label ?? c.propertyName}</option>
          ))}
        </select>
      </label>
      <div>
        <div className="mb-1 text-[11px] text-muted-foreground">
          Σ Totals — sum these columns per group and overall
        </div>
        <div className="flex flex-wrap gap-1.5">
          {columns.map((c) => (
            <Chip key={c.id} selected={sumColumnIds.has(c.id)} onClick={() => onToggleSum(c.id)}>
              <span className="font-mono">Σ</span> {c.label ?? c.propertyName}
            </Chip>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Filters (conditions)
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
  'h-7 rounded-md border border-border bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring';

function ConditionsBody({
  conditions,
  onAdd,
  onUpdate,
  onRemove,
}: {
  conditions: PropertyCondition[];
  onAdd: (condition: PropertyCondition) => void;
  onUpdate: (idx: number, condition: PropertyCondition) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="space-y-1.5">
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
        className="flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> Add filter
      </button>
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
    condition.source === 'spatial' ? 'storey name'
      : condition.source === 'material' ? 'material'
        : condition.source === 'classification' ? 'code or name'
          : 'value';

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 py-1.5 text-xs">
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
            className="h-7 w-28 text-xs"
          />
          <Input
            value={condition.propertyName}
            placeholder="name"
            onChange={(e) => onChange({ ...condition, propertyName: e.target.value })}
            className="h-7 w-24 text-xs"
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
          className="h-7 flex-1 min-w-[6rem] text-xs"
        />
      )}

      <button
        onClick={onRemove}
        aria-label="Remove filter"
        className="ml-auto shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
