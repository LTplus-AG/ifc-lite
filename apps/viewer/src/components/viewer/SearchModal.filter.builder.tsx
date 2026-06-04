/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModalFilterBuilder — chip palette over the unified
 * `FilterRule[]`. Storey / IFC type / Predefined type / Name / Property /
 * Quantity rules with AND/OR + IsSet/IsNotSet, schema-aware dropdowns
 * (storeys + types load eagerly, pset/qto names lazily), and saved
 * preset persistence.
 *
 * UI-only: this component owns rule editing, not run lifecycle. The
 * parent `SearchModalFilter` reads the same slice state and triggers
 * the path-B evaluator from a single Run button.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X, Bookmark, Save } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { COMMON_IFC_TYPES } from '@/lib/search/common-ifc-types';
import {
  Rule,
  type FilterRule,
  type Combinator,
} from '@/lib/search/filter-rules';
import {
  discoverFilterSchema,
  discoverPropertyAndQuantitySchema,
  discoverFilterValues,
} from '@/lib/search/filter-schema';
import {
  loadSavedFilters,
  saveFilter,
  deleteSavedFilter,
  type SavedFilterPreset,
} from '@/lib/search/saved-filters';
import { RuleRow, RULE_KIND_LABEL } from './SearchModal.filter.editors';

export function SearchModalFilterBuilder() {
  const {
    filter,
    schemaMap,
    models,
    activeModelId,
    searchQuery,
    setFilterCombinator,
    setFilterLimit,
    addFilterRule,
    updateFilterRule,
    removeFilterRule,
    clearFilterRules,
    setFilterSchema,
    setFilterPsetQtoSchema,
    setFilterValueSchema,
    setSearchFilter,
  } = useViewerStore(
    useShallow((s) => ({
      filter: s.searchFilter,
      schemaMap: s.searchFilterSchema,
      models: s.models,
      activeModelId: s.activeModelId,
      searchQuery: s.searchQuery,
      setFilterCombinator: s.setFilterCombinator,
      setFilterLimit: s.setFilterLimit,
      addFilterRule: s.addFilterRule,
      updateFilterRule: s.updateFilterRule,
      removeFilterRule: s.removeFilterRule,
      clearFilterRules: s.clearFilterRules,
      setFilterSchema: s.setFilterSchema,
      setFilterPsetQtoSchema: s.setFilterPsetQtoSchema,
      setFilterValueSchema: s.setFilterValueSchema,
      setSearchFilter: s.setSearchFilter,
    })),
  );

  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>(() => loadSavedFilters());

  const activeModel = activeModelId ? models.get(activeModelId) : undefined;
  const activeStore = activeModel?.ifcDataStore ?? null;
  const schemaEntry = activeModelId ? schemaMap.get(activeModelId) : undefined;

  // Cheap schema discovery — runs once per active model.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    if (schemaMap.has(activeModelId)) return;
    setFilterSchema(activeModelId, discoverFilterSchema(activeStore));
  }, [activeModelId, activeStore, schemaMap, setFilterSchema]);

  // Lazy pset/qto schema — fired the first time a property/quantity rule appears.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    const entry = schemaMap.get(activeModelId);
    if (entry?.psetQto) return;
    const needs = filter.rules.some((r) => r.kind === 'property' || r.kind === 'quantity');
    if (!needs) return;
    setFilterPsetQtoSchema(activeModelId, discoverPropertyAndQuantitySchema(activeStore));
  }, [activeModelId, activeStore, filter.rules, schemaMap, setFilterPsetQtoSchema]);

  // Lazy value discovery — distinct material / classification / property
  // values for the chip value suggestions. Fired the first time a rule that
  // benefits from them (property, material, classification) appears.
  useEffect(() => {
    if (!activeModelId || !activeStore) return;
    const entry = schemaMap.get(activeModelId);
    if (entry?.values) return;
    const needs = filter.rules.some(
      (r) => r.kind === 'property' || r.kind === 'material' || r.kind === 'classification',
    );
    if (!needs) return;
    setFilterValueSchema(activeModelId, discoverFilterValues(activeStore));
  }, [activeModelId, activeStore, filter.rules, schemaMap, setFilterValueSchema]);

  const ifcTypeOptions = useMemo<string[]>(() => {
    if (schemaEntry?.basic.ifcTypes && schemaEntry.basic.ifcTypes.length > 0) {
      return schemaEntry.basic.ifcTypes;
    }
    return COMMON_IFC_TYPES.slice();
  }, [schemaEntry]);
  const storeyOptions = schemaEntry?.basic.storeys ?? [];

  // ── Rule construction ─────────────────────────────────────────────

  const addRuleOfKind = useCallback((kind: FilterRule['kind']) => {
    let rule: FilterRule;
    switch (kind) {
      case 'storey':         rule = Rule.storey([], 'in'); break;
      case 'ifcType':        rule = Rule.ifcType([], 'in'); break;
      case 'predefinedType': rule = Rule.predefinedType([], 'in'); break;
      case 'name':           rule = Rule.name('contains', ''); break;
      case 'property':       rule = Rule.property('', '', 'eq', ''); break;
      case 'quantity':       rule = Rule.quantity('', '', 'gt', 0); break;
      case 'material':       rule = Rule.material('contains', ''); break;
      case 'classification': rule = Rule.classification('', 'contains', ''); break;
      case 'elevation':      rule = Rule.elevation('gt', 0); break;
    }
    addFilterRule(rule);
  }, [addFilterRule]);

  const promoteSearchQuery = useCallback(() => {
    const q = searchQuery.trim();
    if (!q) return;
    addFilterRule(Rule.name('contains', q));
  }, [addFilterRule, searchQuery]);

  // ── Preset handlers ─────────────────────────────────────────────────

  const handleSavePreset = useCallback(() => {
    if (filter.rules.length === 0) return;
    // eslint-disable-next-line no-alert
    const name = window.prompt('Save filter as…', '');
    if (!name) return;
    setSavedPresets(saveFilter(name, filter.combinator, filter.rules));
  }, [filter.combinator, filter.rules]);

  const handleLoadPreset = useCallback((preset: SavedFilterPreset) => {
    setSearchFilter({
      rules: preset.rules.map((r) => ({ ...r }) as FilterRule),
      combinator: preset.combinator,
      limit: filter.limit,
    });
  }, [filter.limit, setSearchFilter]);

  const handleDeletePreset = useCallback((name: string) => {
    setSavedPresets(deleteSavedFilter(name));
  }, []);

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* ── Toolbar: AND/OR · Limit · promote-query · Presets · Save · Reset ── */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CombinatorToggle value={filter.combinator} onChange={setFilterCombinator} />

        <div className="ml-1 flex items-center gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Limit
          </label>
          <Input
            type="number"
            min={0}
            value={filter.limit}
            onChange={(e) => setFilterLimit(Number.parseInt(e.target.value, 10) || 0)}
            className="h-7 w-20 text-xs"
          />
          <span className="text-[10px] text-muted-foreground">0 = none</span>
        </div>

        {searchQuery.trim().length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={promoteSearchQuery}
            className="h-7 gap-1 text-[11px]"
            title="Add a Name contains rule from the search bar query"
          >
            <Plus className="h-3 w-3" />
            Add &ldquo;{truncate(searchQuery.trim(), 18)}&rdquo; as rule
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <PresetMenu
            presets={savedPresets}
            onLoad={handleLoadPreset}
            onDelete={handleDeletePreset}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSavePreset}
            disabled={filter.rules.length === 0}
            className="h-7 gap-1 text-[11px]"
            title="Save the current rules as a named preset"
          >
            <Save className="h-3 w-3" /> Save
          </Button>
          {filter.rules.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilterRules}
              className="h-7 gap-1 text-[11px] text-muted-foreground"
            >
              <X className="h-3 w-3" /> Reset
            </Button>
          )}
        </div>
      </div>

      {/* ── Rules list ──────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        {filter.rules.length === 0 && (
          <p className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-center text-xs italic text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/30">
            Add a rule to start filtering — pick by storey, IFC type, name,
            property, quantity, material, classification, or elevation.
          </p>
        )}
        {filter.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            ifcTypeOptions={ifcTypeOptions}
            storeyOptions={storeyOptions}
            psetQto={schemaEntry?.psetQto ?? null}
            valueSchema={schemaEntry?.values ?? null}
            onChange={(next) => updateFilterRule(i, next)}
            onRemove={() => removeFilterRule(i)}
          />
        ))}
        <AddRuleMenu onAdd={addRuleOfKind} />
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function CombinatorToggle({
  value,
  onChange,
}: {
  value: Combinator;
  onChange: (next: Combinator) => void;
}) {
  return (
    <div
      className="inline-flex rounded border border-zinc-200 bg-white p-0.5 text-[11px] dark:border-zinc-800 dark:bg-zinc-950"
      title="AND requires every rule to match. OR matches any rule."
    >
      {(['AND', 'OR'] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`rounded px-2 py-0.5 font-mono font-medium transition-colors ${
            value === c
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function PresetMenu({
  presets,
  onLoad,
  onDelete,
}: {
  presets: SavedFilterPreset[];
  onLoad: (preset: SavedFilterPreset) => void;
  onDelete: (name: string) => void;
}) {
  if (presets.length === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        className="h-7 gap-1 text-[11px] text-muted-foreground"
        title="Save a preset first"
      >
        <Bookmark className="h-3 w-3" /> Presets
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-[11px]"
        >
          <Bookmark className="h-3 w-3" /> Presets
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase">Saved presets</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {presets.map((p) => (
          <DropdownMenuItem
            key={p.name}
            onSelect={() => onLoad(p)}
            className="flex items-start justify-between gap-2"
          >
            <div className="flex flex-col">
              <span className="font-medium">{p.name}</span>
              <span className="text-[10px] text-muted-foreground">
                {p.rules.length} rule{p.rules.length === 1 ? '' : 's'} · {p.combinator}
              </span>
            </div>
            <button
              type="button"
              aria-label={`Delete preset ${p.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(p.name);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-destructive dark:hover:bg-zinc-800"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddRuleMenu({
  onAdd,
}: {
  onAdd: (kind: FilterRule['kind']) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 self-start text-xs">
          <Plus className="h-3 w-3" />
          Add rule
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-[10px] uppercase">Filter dimension</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(Object.keys(RULE_KIND_LABEL) as FilterRule['kind'][]).map((k) => (
          <DropdownMenuItem key={k} onSelect={() => onAdd(k)}>
            {RULE_KIND_LABEL[k]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
