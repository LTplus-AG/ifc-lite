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

import { useCallback, useState } from 'react';
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
import { Rule, type FilterRule } from '@/lib/search/filter-rules';
import { useFilterRuleOptions } from '@/hooks/useFilterRuleOptions';
import { AddRuleMenu, CombinatorToggle, blankRuleOfKind } from './FilterRuleControls';
import {
  loadSavedFilters,
  saveFilter,
  deleteSavedFilter,
  type SavedFilterPreset,
} from '@/lib/search/saved-filters';
import { toast } from '@/components/ui/toast';
import { RuleRow } from './SearchModal.filter.editors';

export function SearchModalFilterBuilder() {
  const {
    filter,
    searchQuery,
    setFilterCombinator,
    setFilterLimit,
    addFilterRule,
    updateFilterRule,
    removeFilterRule,
    clearFilterRules,
    setSearchFilter,
  } = useViewerStore(
    useShallow((s) => ({
      filter: s.searchFilter,
      searchQuery: s.searchQuery,
      setFilterCombinator: s.setFilterCombinator,
      setFilterLimit: s.setFilterLimit,
      addFilterRule: s.addFilterRule,
      updateFilterRule: s.updateFilterRule,
      removeFilterRule: s.removeFilterRule,
      clearFilterRules: s.clearFilterRules,
      setSearchFilter: s.setSearchFilter,
    })),
  );

  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>(() => loadSavedFilters());

  const ruleOptions = useFilterRuleOptions(filter.rules);

  // ── Rule construction ─────────────────────────────────────────────

  const addRuleOfKind = useCallback(
    (kind: FilterRule['kind']) => addFilterRule(blankRuleOfKind(kind)),
    [addFilterRule],
  );

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
    const result = saveFilter(name, filter.combinator, filter.rules);
    setSavedPresets(result.presets);
    // A refused write used to return the in-memory catalog as though saved —
    // the user saw the filter and lost it next session (#2089).
    if (!result.persisted) {
      toast.error('Filter could not be saved — browser storage is unavailable or full.');
    }
  }, [filter.combinator, filter.rules]);

  const handleLoadPreset = useCallback((preset: SavedFilterPreset) => {
    setSearchFilter({
      rules: preset.rules.map((r) => ({ ...r }) as FilterRule),
      combinator: preset.combinator,
      limit: filter.limit,
    });
  }, [filter.limit, setSearchFilter]);

  const handleDeletePreset = useCallback((name: string) => {
    const result = deleteSavedFilter(name);
    setSavedPresets(result.presets);
    if (!result.persisted) {
      toast.error('Filter could not be deleted — browser storage is unavailable or full.');
    }
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
            Add a rule to start filtering — pick by model, storey, IFC type, name,
            property, quantity, material, classification, or elevation.
          </p>
        )}
        {filter.rules.map((rule, i) => (
          <RuleRow
            key={i}
            rule={rule}
            {...ruleOptions}
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
