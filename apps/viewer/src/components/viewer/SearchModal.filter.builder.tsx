/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModalFilterBuilder — orchestrator for the chip palette.
 *
 * Owns rule-list state interactions + schema discovery + saved-preset
 * lifecycle. Defers all rendering of the toolbar, per-kind editors,
 * and shared widgets to the dedicated submodules in `./filter/`.
 *
 * UI-only with respect to run lifecycle: this component never invokes
 * the evaluator. The parent `SearchModalFilter` owns the run, reading
 * the same slice state.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { COMMON_IFC_TYPES } from '@/lib/search/common-ifc-types';
import {
  Rule,
  type FilterRule,
} from '@/lib/search/filter-rules';
import {
  discoverFilterSchema,
  discoverPropertyAndQuantitySchema,
} from '@/lib/search/filter-schema';
import {
  loadSavedFilters,
  saveFilter,
  deleteSavedFilter,
  type SavedFilterPreset,
} from '@/lib/search/saved-filters';
import { BuilderToolbar } from './filter/toolbar';
import { AddRuleMenu } from './filter/toolbar';
import { RuleRow } from './filter/rule-editors';

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
      <BuilderToolbar
        combinator={filter.combinator}
        onCombinatorChange={setFilterCombinator}
        limit={filter.limit}
        onLimitChange={setFilterLimit}
        searchQuery={searchQuery}
        onPromoteSearchQuery={promoteSearchQuery}
        presets={savedPresets}
        onLoadPreset={handleLoadPreset}
        onDeletePreset={handleDeletePreset}
        onSavePreset={handleSavePreset}
        canSave={filter.rules.length > 0}
        canReset={filter.rules.length > 0}
        onReset={clearFilterRules}
      />

      <div className="flex flex-col gap-2">
        {filter.rules.length === 0 && (
          <p className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-center text-xs italic text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/30">
            Add a rule to start filtering — pick by storey, IFC type, name, property, or quantity.
          </p>
        )}
        {filter.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            ifcTypeOptions={ifcTypeOptions}
            storeyOptions={storeyOptions}
            psetQto={schemaEntry?.psetQto ?? null}
            onChange={(next) => updateFilterRule(i, next)}
            onRemove={() => removeFilterRule(i)}
          />
        ))}
        <AddRuleMenu onAdd={addRuleOfKind} />
      </div>
    </div>
  );
}
