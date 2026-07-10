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
import { Play, Plus, Trash2, ChevronDown, ChevronRight, ChevronUp, Save, Check, GripVertical, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ComboInput } from '@/components/ui/combo-input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { IfcTypeEnum } from '@ifc-lite/data';
import { collectSpatialContainerNames } from '@/utils/spatialHierarchy';
import type { IfcDataStore } from '@ifc-lite/parser';
import {
  discoverFilterValues,
  discoverFilterSchema,
  propValueKey,
} from '@/lib/search/filter-schema';
import type {
  ListDataProvider,
  ListDefinition,
  ColumnDefinition,
  DiscoveredColumns,
  PropertyCondition,
  ConditionOperator,
} from '@ifc-lite/lists';
import { discoverColumns, ENTITY_ATTRIBUTES } from '@ifc-lite/lists';
import { collectScopeTypes } from '@/lib/lists/scope-types';
import {
  isEditableColumn,
  draftFromColumn,
  columnFromDraft,
  columnDefKey,
  draftDefKey,
  updateColumnInPlace,
  type ColumnDraft,
} from '@/lib/lists/column-edit';
import { previewSetPattern, formatMatchHint } from './pattern-preview';

const NO_OPTIONS: readonly string[] = [];

/**
 * Distinct model values used to suggest condition values in the chip editors.
 * Storeys are intentionally NOT here — they come cheaply from the spatial
 * index, whereas these require sampling element property/material data.
 */
interface ListConditionValues {
  materials: string[];
  classifications: string[];
  /** propValueKey(pset, prop) → distinct values. */
  propertyValues: Map<string, string[]>;
}

/**
 * Merge per-store value discovery into one suggestion set. This is the
 * EXPENSIVE pass (samples element property/material/classification data), so
 * it's only run when a property/material/classification condition exists —
 * never for storey-only filters (storeys come from `discoverFilterSchema`).
 */
function discoverConditionValues(stores: IfcDataStore[]): ListConditionValues {
  const materials = new Set<string>();
  const classifications = new Set<string>();
  const propertyValues = new Map<string, Set<string>>();
  for (const store of stores) {
    const v = discoverFilterValues(store);
    v.materials.forEach((m) => materials.add(m));
    v.classifications.forEach((c) => classifications.add(c));
    for (const [k, arr] of v.propertyValues) {
      let bucket = propertyValues.get(k);
      if (!bucket) { bucket = new Set(); propertyValues.set(k, bucket); }
      for (const val of arr) bucket.add(val);
    }
  }
  const sort = (s: Set<string>) => Array.from(s).sort();
  const pv = new Map<string, string[]>();
  for (const [k, s] of propertyValues) pv.set(k, sort(s));
  return { materials: sort(materials), classifications: sort(classifications), propertyValues: pv };
}

/** Column descriptor shared by the quick-add grid. */
interface CommonColumn { id: string; source: ColumnDefinition['source']; propertyName: string; label: string }

/** Spatial-container levels a `spatial` column / filter can target, fine to
 *  coarse: Container is the element's IMMEDIATE container (any level); Storey
 *  is the default (back-compat). */
const SPATIAL_LEVELS = ['Container', 'Storey', 'Building', 'Site', 'Project'] as const;

/**
 * The first-class columns: built-in attributes plus the spatial / semantic
 * columns. Surfaced as a flat grid so Material / Classification / Container /
 * Storey / Site / Building / Project / Model are as reachable as Name / Class —
 * not buried in a collapsed group. Container is the element's IMMEDIATE spatial
 * container (Bonsai's "container"): the direct IfcRelContainedInSpatialStructure
 * parent, at whatever level — the storey, or for bridges/roads the
 * IfcBridgePart / IfcRoadPart / IfcSpatialZone it sits in. Site / Building /
 * Project / Model identify which federated file (and where in its spatial tree)
 * each row comes from, so a list over several models can be grouped and sorted
 * by source (issue #1591).
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
  { id: 'col-container', source: 'spatial', propertyName: 'Container', label: 'Container' },
  { id: 'col-storey', source: 'spatial', propertyName: 'Storey', label: 'Storey' },
  { id: 'col-building', source: 'spatial', propertyName: 'Building', label: 'Building' },
  { id: 'col-site', source: 'spatial', propertyName: 'Site', label: 'Site' },
  { id: 'col-project', source: 'spatial', propertyName: 'Project', label: 'Project' },
  { id: 'col-model', source: 'model', propertyName: 'Model', label: 'Model' },
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
  /** Backing stores for value discovery (condition value suggestions). */
  stores: IfcDataStore[];
  initial: ListDefinition | null;
  onSave: (definition: ListDefinition) => void;
  onCancel: () => void;
  onExecute: (definition: ListDefinition) => void;
}

export function ListBuilder({ providers, stores, initial, onSave, onCancel, onExecute }: ListBuilderProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selectedTypes, setSelectedTypes] = useState<Set<IfcTypeEnum>>(
    new Set(initial?.entityTypes ?? [])
  );
  const [columns, setColumns] = useState<ColumnDefinition[]>(initial?.columns ?? []);
  const [conditions, setConditions] = useState<PropertyCondition[]>(initial?.conditions ?? []);
  // Lazily-discovered distinct values for condition suggestions. This is the
  // EXPENSIVE sampling pass, so only run it when a property / material /
  // classification condition exists — storey-only filters never trigger it.
  const [conditionValues, setConditionValues] = useState<ListConditionValues | null>(null);
  React.useEffect(() => {
    if (conditionValues || stores.length === 0) return;
    const needs = conditions.some(
      (c) => c.source === 'property' || c.source === 'material' || c.source === 'classification',
    );
    if (!needs) return;
    setConditionValues(discoverConditionValues(stores));
  }, [conditions, stores, conditionValues]);

  // Storey names come cheaply from the spatial index (no element sampling),
  // so they're always available without the expensive value pass above.
  const storeyNames = useMemo<string[]>(() => {
    if (stores.length === 0) return [];
    const set = new Set<string>();
    for (const store of stores) {
      for (const [name] of discoverFilterSchema(store).storeys) set.add(name);
    }
    return Array.from(set).sort();
  }, [stores]);

  // Spatial-filter value suggestions per level. Storey reuses the index-derived
  // names above; Building / Site / Project come from a cheap spatial-tree walk
  // (only the handful of container nodes, no element sampling).
  const spatialNamesByLevel = useMemo<Record<string, string[]>>(() => {
    const building = new Set<string>();
    const site = new Set<string>();
    const project = new Set<string>();
    const container = new Set<string>();
    // Reuse the shared collector so the site / building-like / project /
    // container classification can't drift from the column resolver (#1591 review).
    for (const store of stores) {
      const names = collectSpatialContainerNames(store.spatialHierarchy, (id) => store.entities.getName(id));
      names.sites.forEach((n) => site.add(n));
      names.buildings.forEach((n) => building.add(n));
      names.projects.forEach((n) => project.add(n));
      names.containers.forEach((n) => container.add(n));
    }
    const sorted = (s: Set<string>) => Array.from(s).sort();
    return {
      Container: sorted(container),
      Storey: storeyNames,
      Building: sorted(building),
      Site: sorted(site),
      Project: sorted(project),
    };
  }, [stores, storeyNames]);

  // Loaded model / file names — value suggestions for a `Model` filter, and the
  // discriminator the Model column surfaces (issue #1591).
  const modelNames = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const p of providers) { const n = p.getModelName?.(); if (n) set.add(n); }
    return Array.from(set).sort();
  }, [providers]);
  const [groupByColumnId, setGroupByColumnId] = useState<string>(initial?.grouping?.columnId ?? '');
  const [sumColumnIds, setSumColumnIds] = useState<Set<string>>(
    new Set(initial?.grouping?.sumColumnIds ?? [])
  );

  // Scope classes offered as chips: every element class actually present in
  // the loaded model(s), with instance counts. Derived from the models rather
  // than a curated allowlist, so a present class the curator never listed —
  // e.g. IfcDuctSegment / IfcPipeSegment — is still selectable (#1662).
  const scopeTypes = useMemo(() => collectScopeTypes(stores), [stores]);
  const typeCounts = useMemo(() => {
    const counts = new Map<IfcTypeEnum, number>();
    for (const { type, count } of scopeTypes) counts.set(type, count);
    return counts;
  }, [scopeTypes]);

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

  // Edit a column's definition IN PLACE — same array position, same id, so the
  // column order and the results table's per-id width / index-based sort survive
  // (issue #1591 follow-up). The list is re-run from the existing Run action.
  const updateColumn = useCallback((id: string, next: ColumnDefinition) => {
    setColumns(prev => updateColumnInPlace(prev, id, next));
  }, []);

  const toggleColumn = useCallback((col: ColumnDefinition) => {
    setColumns(prev => (prev.some(c => c.id === col.id) ? prev.filter(c => c.id !== col.id) : [...prev, col]));
  }, []);

  // Would `draft` duplicate an EXISTING column's definition? Keyed by content
  // (source + set + property), not by column id, so the guard still fires after
  // an in-place edit drifted a column's definition away from its (stable) id.
  // `excludeId` skips the slot being edited, so re-saving a column unchanged
  // isn't flagged as a self-duplicate.
  const isDuplicateColumn = useCallback(
    (draft: ColumnDraft, excludeId?: string): boolean => {
      const key = draftDefKey(draft);
      return columns.some((c) => c.id !== excludeId && columnDefKey(c) === key);
    },
    [columns],
  );

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
    const sumCols = columns.filter(c => sumColumnIds.has(c.id)).map(c => c.id);
    // Keep grouping when there's a valid group column OR any sum column — sums
    // alone still produce grand totals, and may have been set from the table.
    const grouping = (groupValid || sumCols.length > 0)
      ? { columnId: groupValid ? groupByColumnId : '', sumColumnIds: sumCols }
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
                  {scopeTypes.map(({ type, label, count }) => (
                    <Chip
                      key={type}
                      selected={selectedTypes.has(type)}
                      onClick={() => toggleType(type)}
                      trailing={count.toLocaleString()}
                    >
                      {label}
                    </Chip>
                  ))}
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
              discovered={discovered}
              values={conditionValues}
              spatialNames={spatialNamesByLevel}
              modelNames={modelNames}
              onAdd={addCondition}
              onUpdate={updateCondition}
              onRemove={removeCondition}
            />
          </Section>

          {/* Columns */}
          <Section label="Columns" hint={columns.length > 0 ? `${columns.length}` : undefined}>
            {columns.length > 0 && (
              <SelectedColumns
                columns={columns}
                discovered={discovered}
                onMove={moveColumn}
                onRemove={removeColumn}
                onUpdate={updateColumn}
                isDuplicate={isDuplicateColumn}
              />
            )}
            <ColumnPicker
              discovered={discovered}
              selectedIds={selectedColumnIds}
              onAdd={addColumn}
              onToggle={toggleColumn}
              isDuplicate={isDuplicateColumn}
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
  discovered,
  onMove,
  onRemove,
  onUpdate,
  isDuplicate,
}: {
  columns: ColumnDefinition[];
  discovered: DiscoveredColumns;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, next: ColumnDefinition) => void;
  isDuplicate: (draft: ColumnDraft, excludeId?: string) => boolean;
}) {
  // Which column's inline editor is open (one at a time). Cleared when the
  // edited column is removed or after a save.
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="mb-3 space-y-1">
      {columns.map((col, idx) => {
        const editing = editingId === col.id;
        const editable = isEditableColumn(col);
        return (
          <div key={col.id} className="space-y-1">
            <div className="group flex items-center gap-1.5 rounded-md border border-border/60 bg-card px-2 py-1 text-xs">
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
              <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{idx + 1}</span>
              <span className="flex-1 truncate font-medium">
                {col.label ?? col.propertyName}
                {col.psetName && <span className="ml-1 font-normal text-muted-foreground">· {col.psetName}</span>}
              </span>
              <ColSourceTag col={col} />
              {editable && (
                <button
                  onClick={() => setEditingId(editing ? null : col.id)}
                  aria-label={editing ? 'Close editor' : 'Edit column'}
                  aria-pressed={editing}
                  className={cn(
                    'shrink-0 hover:text-foreground',
                    editing ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
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
                onClick={() => { if (editing) setEditingId(null); onRemove(col.id); }}
                aria-label="Remove column"
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {editing && editable && (
              <ColumnEditorPanel
                mode="edit"
                discovered={discovered}
                initial={draftFromColumn(col)}
                isDuplicate={(draft) => isDuplicate(draft, col.id)}
                onSubmit={(draft) => { onUpdate(col.id, columnFromDraft(draft, col.id, col)); setEditingId(null); }}
                onClose={() => setEditingId(null)}
              />
            )}
          </div>
        );
      })}
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
  model: 'model',
};

/** A `spatial` column's tag reflects its level (storey / building / site /
 *  project); everything else uses the flat per-source tag. */
function colSourceTag(col: ColumnDefinition): string {
  if (col.source === 'spatial') return (col.propertyName || 'Storey').toLowerCase();
  return SOURCE_TAG[col.source];
}

function ColSourceTag({ col }: { col: ColumnDefinition }) {
  return (
    <span className="shrink-0 rounded bg-muted px-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
      {colSourceTag(col)}
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
  isDuplicate: (draft: ColumnDraft, excludeId?: string) => boolean;
}

function ColumnPicker({ discovered, selectedIds, onAdd, onToggle, isDuplicate }: ColumnPickerProps) {
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

      {/* Custom / pattern column: type a set + property name directly, with
          `/regex/` support so one column pulls a value across matching sets
          (issue #1591 follow-up). Progressive disclosure keeps the picker
          uncluttered until a power user reaches for it. */}
      <CustomColumnEntry discovered={discovered} onAdd={onAdd} isDuplicate={isDuplicate} />
    </div>
  );
}

// ============================================================================
// Custom / pattern column entry — free-text set + property, regex-aware
// ============================================================================

function CustomColumnEntry({
  discovered,
  onAdd,
  isDuplicate,
}: {
  discovered: DiscoveredColumns;
  onAdd: (col: ColumnDefinition) => void;
  isDuplicate: (draft: ColumnDraft, excludeId?: string) => boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" /> Custom column
        <span className="ml-auto font-mono text-[10px] opacity-70">Pset/Qto or /regex/</span>
      </button>
    );
  }

  return (
    <ColumnEditorPanel
      mode="add"
      discovered={discovered}
      initial={{ source: 'property', setName: '', propName: '' }}
      isDuplicate={(draft) => isDuplicate(draft)}
      onSubmit={(draft) =>
        onAdd({
          id: customColumnId(draft),
          source: draft.source,
          psetName: draft.setName,
          propertyName: draft.propName,
          label: draft.propName,
        })
      }
      onClose={() => setOpen(false)}
    />
  );
}

/**
 * Id for a custom / pattern column. Slugified like the discovered-column ids
 * (collapse whitespace) but case-PRESERVING: regex patterns are case-sensitive,
 * so `/A/` and `/a/` are distinct sets and must not collapse to one id.
 */
function customColumnId(draft: ColumnDraft): string {
  return `custom-${draft.source}-${draft.setName}-${draft.propName}`.replace(/\s+/g, '-');
}

/**
 * The shared property/quantity column editor — the same UI for ADDING a custom
 * column and for EDITING an existing one in place (issue #1591 follow-up), so
 * the two never drift. `mode` only changes the primary action (Add keeps the
 * panel open to add several in a row and clears just the property; Save applies
 * and lets the parent close). Set + property names accept Bonsai-style
 * `/regex/`, with the same live match preview and invalid-pattern guard.
 */
function ColumnEditorPanel({
  mode,
  discovered,
  initial,
  onSubmit,
  onClose,
  isDuplicate,
}: {
  mode: 'add' | 'edit';
  discovered: DiscoveredColumns;
  initial: ColumnDraft;
  onSubmit: (draft: ColumnDraft) => void;
  onClose: () => void;
  isDuplicate?: (draft: ColumnDraft) => boolean;
}) {
  const [source, setSource] = useState<'property' | 'quantity'>(initial.source);
  const [setName, setSetName] = useState(initial.setName);
  const [propName, setPropName] = useState(initial.propName);

  const setOptions = useMemo<string[]>(
    () => Array.from((source === 'quantity' ? discovered.quantities : discovered.properties).keys()).sort(),
    [discovered, source],
  );
  // Suggest property names only when the typed set is an exact discovered set
  // (a `/regex/` set has no single property list to offer).
  const propOptions = useMemo<string[]>(
    () => [...((source === 'quantity' ? discovered.quantities : discovered.properties).get(setName.trim()) ?? [])],
    [discovered, source, setName],
  );

  const set = setName.trim();
  const prop = propName.trim();
  // Live preview: which discovered sets a `/regex/` set field matches, so a
  // power user sees "matches 2 sets: ..." before saving, and a malformed pattern
  // is flagged rather than silently kept as a dead literal (issue #1591).
  const preview = useMemo(() => previewSetPattern(set, setOptions), [set, setOptions]);
  const draft: ColumnDraft = { source, setName: set, propName: prop };
  const duplicate = isDuplicate?.(draft) ?? false;
  const canSubmit = set.length > 0 && prop.length > 0 && !preview.isInvalid && !duplicate;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(draft);
    // Adding keeps the set + source so several properties from the same
    // (pattern) set can be added in a row; editing is a one-shot apply.
    if (mode === 'add') setPropName('');
  };

  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-card p-2.5">
      <div className="flex items-center gap-1.5">
        <Chip selected={source === 'property'} onClick={() => setSource('property')}>Property</Chip>
        <Chip selected={source === 'quantity'} onClick={() => setSource('quantity')}>Quantity</Chip>
        {preview.isPattern && (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
            regex
          </span>
        )}
        <button
          onClick={onClose}
          aria-label={mode === 'add' ? 'Close custom column' : 'Close editor'}
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1.5">
        <ComboInput
          value={setName}
          options={setOptions}
          placeholder={source === 'quantity' ? 'Qto_… or /Qto_.*/' : 'Pset_… or /Pset_.*/'}
          className="h-7 min-w-0 flex-1 text-xs"
          onChange={setSetName}
        />
        <ComboInput
          value={propName}
          options={propOptions}
          placeholder={source === 'quantity' ? 'NetVolume' : 'FireRating'}
          className="h-7 min-w-0 flex-1 text-xs"
          onChange={setPropName}
        />
        <Button
          size="sm"
          onClick={submit}
          disabled={!canSubmit}
          aria-label={mode === 'add' ? 'Add custom column' : 'Save column'}
          className="h-7 shrink-0 px-2"
        >
          {mode === 'add' ? <Plus className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {preview.isInvalid ? (
        <p className="text-[11px] leading-relaxed text-destructive">
          Invalid pattern. It would be matched as a literal name, so it likely hits nothing.
        </p>
      ) : preview.isPattern ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {formatMatchHint(preview.matches)}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Type an exact set name, or wrap a pattern in{' '}
          <code className="rounded bg-muted px-1 font-mono text-[10px]">/…/</code> to pull one value across every
          matching set, e.g. <code className="rounded bg-muted px-1 font-mono text-[10px]">/Qto_.*BaseQuantities/</code>.
        </p>
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
  { source: 'spatial', label: 'Spatial' },
  { source: 'model', label: 'Model' },
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
    case 'model':
      return { source, propertyName: 'Model', operator: 'equals', value: '' };
    case 'attribute':
    default:
      return { source: 'attribute', propertyName: 'Name', operator: 'contains', value: '' };
  }
}

const SELECT_CLASS =
  'h-7 rounded-md border border-border bg-background px-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring';

function ConditionsBody({
  conditions,
  discovered,
  values,
  spatialNames,
  modelNames,
  onAdd,
  onUpdate,
  onRemove,
}: {
  conditions: PropertyCondition[];
  discovered: DiscoveredColumns;
  values: ListConditionValues | null;
  spatialNames: Record<string, string[]>;
  modelNames: string[];
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
          discovered={discovered}
          values={values}
          spatialNames={spatialNames}
          modelNames={modelNames}
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
  discovered,
  values,
  spatialNames,
  modelNames,
  onChange,
  onRemove,
}: {
  condition: PropertyCondition;
  discovered: DiscoveredColumns;
  values: ListConditionValues | null;
  spatialNames: Record<string, string[]>;
  modelNames: string[];
  onChange: (next: PropertyCondition) => void;
  onRemove: () => void;
}) {
  const ops = operatorsFor(condition.source);
  const showValue = condition.operator !== 'exists';
  const isProperty = condition.source === 'property';
  const isQuantity = condition.source === 'quantity';
  const isSpatial = condition.source === 'spatial';
  const showSetFields = isProperty || isQuantity;

  const setNameOptions = useMemo<string[]>(() => {
    if (isProperty) return Array.from(discovered.properties.keys()).sort();
    if (isQuantity) return Array.from(discovered.quantities.keys()).sort();
    return [];
  }, [discovered, isProperty, isQuantity]);

  const propNameOptions = useMemo<string[]>(() => {
    const set = condition.psetName ?? '';
    if (isProperty) return [...(discovered.properties.get(set) ?? [])];
    if (isQuantity) return [...(discovered.quantities.get(set) ?? [])];
    return [];
  }, [discovered, condition.psetName, isProperty, isQuantity]);

  const valueOptions = useMemo<readonly string[]>(() => {
    switch (condition.source) {
      case 'property':
        return values?.propertyValues.get(propValueKey(condition.psetName ?? '', condition.propertyName)) ?? NO_OPTIONS;
      case 'material': return values?.materials ?? NO_OPTIONS;
      case 'classification': return values?.classifications ?? NO_OPTIONS;
      case 'spatial': return spatialNames[condition.propertyName] ?? spatialNames.Storey ?? NO_OPTIONS;
      case 'model': return modelNames;
      default: return NO_OPTIONS;
    }
  }, [condition.source, condition.psetName, condition.propertyName, values, spatialNames, modelNames]);

  const valuePlaceholder =
    condition.source === 'spatial' ? `${(condition.propertyName || 'Storey').toLowerCase()} name`
      : condition.source === 'model' ? 'model / file'
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

      {isSpatial && (
        <select
          value={condition.propertyName || 'Storey'}
          onChange={(e) => onChange({ ...condition, propertyName: e.target.value, value: '' })}
          className={SELECT_CLASS}
          aria-label="Spatial level"
        >
          {SPATIAL_LEVELS.map((level) => (
            <option key={level} value={level}>{level}</option>
          ))}
        </select>
      )}

      {showSetFields && (
        <>
          <ComboInput
            value={condition.psetName ?? ''}
            options={setNameOptions}
            placeholder={isQuantity ? 'Qto_…' : 'Pset_…'}
            className="h-7 w-32 text-xs"
            onChange={(v) => onChange({ ...condition, psetName: v })}
          />
          <ComboInput
            value={condition.propertyName}
            options={propNameOptions}
            placeholder="name"
            className="h-7 w-28 text-xs"
            onChange={(v) => onChange({ ...condition, propertyName: v })}
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
        <ComboInput
          value={String(condition.value ?? '')}
          options={valueOptions}
          placeholder={valuePlaceholder}
          className="h-7 w-44 text-xs"
          onChange={(v) => onChange({ ...condition, value: v })}
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
