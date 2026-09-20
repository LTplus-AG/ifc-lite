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
import { totalRuleCount } from '@/lib/search/filter-groups';
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
import { SearchModalFilterSelector, useActiveSchemaVersion } from './SearchModal.filter.selector';
import { readSelector } from '@/lib/search/selector-to-rules';
import { GroupTabs } from './SearchModal.filter.groupTabs';
import { useTranslation } from '@/i18n';

export function SearchModalFilterBuilder() {
  const { t } = useTranslation();
  const {
    filter,
    activeGroupIndex,
    searchQuery,
    setFilterCombinator,
    setFilterLimit,
    addFilterRule,
    updateFilterRule,
    removeFilterRule,
    clearFilterRules,
    addFilterGroup,
    removeFilterGroup,
    setActiveFilterGroup,
    setSearchFilter,
  } = useViewerStore(
    useShallow((s) => ({
      filter: s.searchFilter,
      activeGroupIndex: s.searchFilterActiveGroup,
      searchQuery: s.searchQuery,
      setFilterCombinator: s.setFilterCombinator,
      setFilterLimit: s.setFilterLimit,
      addFilterRule: s.addFilterRule,
      updateFilterRule: s.updateFilterRule,
      removeFilterRule: s.removeFilterRule,
      clearFilterRules: s.clearFilterRules,
      addFilterGroup: s.addFilterGroup,
      removeFilterGroup: s.removeFilterGroup,
      setActiveFilterGroup: s.setActiveFilterGroup,
      setSearchFilter: s.setSearchFilter,
    })),
  );
  const schemaVersion = useActiveSchemaVersion();

  const [savedPresets, setSavedPresets] = useState<SavedFilterPreset[]>(() => loadSavedFilters());

  // The active group — rule edits (add/update/remove, AND/OR toggle) target
  // only this one; `+ Add group` / the group tabs below switch it (#4904).
  const activeGroup = filter.groups[activeGroupIndex] ?? filter.groups[0];
  const activeRules = activeGroup?.rules ?? [];
  const ruleOptions = useFilterRuleOptions(activeRules);
  const totalRules = totalRuleCount(filter.groups);

  // ── Rule construction ─────────────────────────────────────────────

  const addRuleOfKind = useCallback(
    (kind: FilterRule['kind']) => addFilterRule(blankRuleOfKind(kind)),
    [addFilterRule],
  );

  /**
   * The search bar's text as rules, through the same reading the Selector
   * field uses. `IfcWall, Name=/D[0-9]{2}/` becomes a type rule and a Name
   * rule; text that is not a selector at all — a plain `Wand` — stays the
   * `Name contains` it has always been.
   *
   * A selector the adapter can only partly carry now applies the part it can
   * and NAMES the rest. It used to fall through to `Name contains` on the
   * whole string, so `IfcWall, type=WT01` silently added a rule matching zero
   * elements with nothing to read: the defect #4091 reported, reached from the
   * other entry point. Two surfaces reading the same text cannot disagree
   * about whether the user is owed an explanation.
   *
   * The fallback survives for text that PARSES but names nothing — `IFC`,
   * `IFC-Export`, `Level=1`. Those reach here as a successful parse with no
   * rule, and reporting them cost the button its oldest behaviour on the most
   * ordinary input there is: `readsAsPlainText` is how the adapter separates
   * them from a selector whose construct it genuinely cannot run.
   */
  const promoteSearchQuery = useCallback(() => {
    const q = searchQuery.trim();
    if (!q) return;
    const reading = readSelector(q, { schemaVersion });
    if (!reading.ok || reading.readsAsPlainText) {
      addFilterRule(Rule.name('contains', q));
      return;
    }
    if (reading.rules.length === 0) {
      toast.error(t('searchModal.filterBuilder.noRuleMapped', { unsupported: reading.unsupported.join('; ') }));
      return;
    }
    // A `+` union is refused here rather than silently promoting only
    // `groups[0]` — review (PR #4987): this button predates groups and adds
    // into the single ACTIVE one, so a naive promote of "IfcWall + IfcDoor"
    // would add the IfcWall rule and drop the IfcDoor branch with nothing
    // to read, the exact #4091 defect class this whole adapter exists to
    // avoid. The Selector field above (which DOES carry the full union) is
    // where `+` text is meant to go.
    if (reading.groups.length > 1) {
      toast.error(
        t('searchModal.filterBuilder.unionNotSupported', { query: q, groupCount: reading.groups.length }),
      );
      return;
    }
    for (const rule of reading.rules) addFilterRule(rule);
    if (reading.unsupported.length > 0) {
      toast.info(t('searchModal.filterBuilder.addedWithoutParts', { unsupported: reading.unsupported.join('; ') }));
    }
  }, [addFilterRule, schemaVersion, searchQuery]);

  // ── Preset handlers ─────────────────────────────────────────────────

  const handleSavePreset = useCallback(() => {
    if (totalRules === 0) return;
    // eslint-disable-next-line no-alert
    const name = window.prompt(t('searchModal.filterBuilder.saveFilterPrompt'), '');
    if (!name) return;
    const result = saveFilter(name, filter.groups);
    setSavedPresets(result.presets);
    // A refused write used to return the in-memory catalog as though saved —
    // the user saw the filter and lost it next session (#2089).
    if (!result.persisted) {
      toast.error(t('searchModal.filterBuilder.saveFilterFailed'));
    }
  }, [filter.groups, totalRules]);

  const handleLoadPreset = useCallback((preset: SavedFilterPreset) => {
    setSearchFilter({
      groups: preset.groups.map((g) => ({ rules: g.rules.map((r) => ({ ...r }) as FilterRule), combinator: g.combinator })),
      limit: filter.limit,
    });
  }, [filter.limit, setSearchFilter]);

  const handleDeletePreset = useCallback((name: string) => {
    const result = deleteSavedFilter(name);
    setSavedPresets(result.presets);
    if (!result.persisted) {
      toast.error(t('searchModal.filterBuilder.deleteFilterFailed'));
    }
  }, []);

  return (
    <div className="flex flex-col">
      <SearchModalFilterSelector />
      <div className="flex flex-col gap-3 p-4">
        {/* ── Group tabs: which group "+ Add rule" etc. below targets (#4904) ── */}
        {filter.groups.length > 1 && (
          <GroupTabs
            groups={filter.groups}
            activeIndex={activeGroupIndex}
            onSelect={setActiveFilterGroup}
            onRemove={removeFilterGroup}
          />
        )}

        {/* ── Toolbar: AND/OR · Limit · promote-query · Presets · Save · Reset ── */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <CombinatorToggle value={activeGroup?.combinator ?? 'AND'} onChange={setFilterCombinator} />

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addFilterGroup}
            className="h-7 gap-1 text-[11px]"
            title={t('filterGroups.addGroupTitle')}
          >
            <Plus className="h-3 w-3" /> {t('filterGroups.addGroup')}
          </Button>

          <div className="ml-1 flex items-center gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('searchModal.filterBuilder.limitLabel')}
            </label>
            <Input
              type="number"
              min={0}
              value={filter.limit}
              onChange={(e) => setFilterLimit(Number.parseInt(e.target.value, 10) || 0)}
              className="h-7 w-20 text-xs"
            />
            <span className="text-[10px] text-muted-foreground">{t('searchModal.filterBuilder.limitZeroHint')}</span>
          </div>

          {searchQuery.trim().length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={promoteSearchQuery}
              className="h-7 gap-1 text-[11px]"
              title={t('searchModal.filterBuilder.promoteQueryTitle')}
            >
              <Plus className="h-3 w-3" />
              {t('searchModal.filterBuilder.addQueryAsRule', { query: truncate(searchQuery.trim(), 18) })}
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
              disabled={totalRules === 0}
              className="h-7 gap-1 text-[11px]"
              title={t('searchModal.filterBuilder.savePresetTitle')}
            >
              <Save className="h-3 w-3" /> {t('searchModal.filterBuilder.save')}
            </Button>
            {activeRules.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFilterRules}
                className="h-7 gap-1 text-[11px] text-muted-foreground"
              >
                <X className="h-3 w-3" /> {t('searchModal.filterBuilder.reset')}
              </Button>
            )}
          </div>
        </div>

        {/* ── Rules list (active group) ──────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          {activeRules.length === 0 && (
            <p className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-center text-xs italic text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/30">
              {t('searchModal.filterBuilder.emptyRulesHint')}
            </p>
          )}
          {activeRules.map((rule, i) => (
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
  const { t } = useTranslation();
  if (presets.length === 0) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        className="h-7 gap-1 text-[11px] text-muted-foreground"
        title={t('searchModal.filterBuilder.savePresetFirstTitle')}
      >
        <Bookmark className="h-3 w-3" /> {t('searchModal.filterBuilder.presets')}
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
          <Bookmark className="h-3 w-3" /> {t('searchModal.filterBuilder.presets')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase">{t('searchModal.filterBuilder.savedPresets')}</DropdownMenuLabel>
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
                {t('searchModal.filterBuilder.presetRuleCount', { count: totalRuleCount(p.groups) })}
                {' · '}
                {p.groups.length > 1 ? t('filterGroups.groupCountOr', { count: p.groups.length }) : p.combinator}
              </span>
            </div>
            <button
              type="button"
              aria-label={t('searchModal.filterBuilder.deletePresetAriaLabel', { name: p.name })}
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
