/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FilterGroupEditor` — the chip-based `FilterGroup[]` editor, lifted out
 * of `SearchModal.filter.builder.tsx` as a CONTROLLED component (#5138 PR
 * 5): group tabs, the AND/OR toggle, the rule list and "Add rule" menu,
 * with no `useViewerStore` subscription of its own for the groups it
 * edits. `SearchModalFilterBuilder` becomes a thin adapter over the search
 * slice so the Filter tab's behaviour is byte-for-byte what it was before
 * this lift (`SearchModal.filter.wiring.test.tsx` / `.groups.test.tsx` /
 * `.promote.test.tsx` stay green unchanged) — the same component now also
 * backs the information-validation rule editor's applicability/requirement
 * blocks (`RuleBlockEditor.tsx`), restricted via `allowedKinds`.
 *
 * `onChange` takes an UPDATER, `(prev) => next`, the same shape React's own
 * `setState(updater)` uses — not the plain next-value pair a first pass at
 * this lift shipped. A store action mounted alongside this editor (a preset
 * load, a rule added from outside this component) can commit between one
 * render and the next; a plain "next value" callback would close over this
 * component's OWN possibly one-render-stale `groups`/`activeGroup` props
 * and silently revert that other write when the user's very next click
 * dispatches (`SearchModal.filter.groups.test.tsx`'s "a rule added after
 * 'Add group' lands in the NEW group" caught this — a direct
 * `addFilterRule()` store call followed immediately by a click). The
 * updater form makes every mutation dispatch through whatever the CALLER
 * considers current at apply time, exactly like the store actions this
 * replaces (`searchSlice.filterGroups.ts`'s `set((state) => …)`).
 *
 * `RuleRow` / `AddRuleMenu` / `CombinatorToggle` /
 * `useFilterRuleOptions` are reused UNCHANGED — this file only owns the
 * layout that used to sit directly in the builder.
 */

import { useCallback } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FilterRule } from '@ifc-lite/rules';
import type { FilterGroup } from '@ifc-lite/rules';
import { useFilterRuleOptions } from '@/hooks/useFilterRuleOptions';
import { AddRuleMenu, CombinatorToggle, blankRuleOfKind } from './FilterRuleControls';
import { RuleRow } from './SearchModal.filter.editors';
import { GroupTabsPanel } from './SearchModal.filter.groupTabs';
import { clampGroupIndex } from '@/store/slices/searchSlice.filterGroups';
import { useTranslation } from '@/i18n';

/** The model identity a chip's `model` rule may target — never a runtime
 *  id when the caller is a persisted validation rule set (`rule-set.ts`'s
 *  `RuleSetTargets` doc: "Never a local model id"). The search builder
 *  passes the same `sourceFingerprint ?? id` fallback it always has; the
 *  validation editor passes only models that HAVE a fingerprint. */
export interface FilterGroupEditorModel {
  id: string;
  name: string;
  sourceFingerprint?: string;
}

export interface FilterGroupEditorState {
  groups: FilterGroup[];
  activeGroup: number;
}

export interface FilterGroupEditorProps {
  groups: FilterGroup[];
  activeGroup: number;
  /** Functional update — see the module docstring for why this is not a
   *  plain `(groups, activeGroup) => void` pair. */
  onChange: (updater: (prev: FilterGroupEditorState) => FilterGroupEditorState) => void;
  /** Hides rule kinds from the "Add rule" menu — e.g. an `element`
   *  requirement block only allows `rule-set-io.ts`'s
   *  `ELEMENT_REQUIREMENT_KINDS`. Every kind is offered when omitted. */
  allowedKinds?: ReadonlySet<FilterRule['kind']>;
  /** The active model's IFC schema version. Not read by the chip editor
   *  itself (only the selector sibling parses text against it) — threaded
   *  through so `RuleBlockEditor` can hold one prop set for both. */
  schemaVersion?: string;
  models: ReadonlyArray<FilterGroupEditorModel>;
}

function updateActiveGroup(
  state: FilterGroupEditorState,
  update: (group: FilterGroup) => FilterGroup,
): FilterGroup[] {
  const index = clampGroupIndex(state.activeGroup, state.groups.length);
  const active = state.groups[index];
  if (!active) return state.groups;
  return state.groups.map((g, i) => (i === index ? update(g) : g));
}

export function FilterGroupEditor({
  groups,
  activeGroup,
  onChange,
  allowedKinds,
  models,
}: FilterGroupEditorProps) {
  const { t } = useTranslation();
  const activeIndex = clampGroupIndex(activeGroup, groups.length);
  const active = groups[activeIndex];
  const activeRules = active?.rules ?? [];
  const ruleOptions = useFilterRuleOptions(activeRules);
  const modelOptions = models
    .filter((m) => m.sourceFingerprint !== undefined)
    .map((m) => ({ label: m.name, value: m.sourceFingerprint as string }));

  const addGroup = useCallback(() => {
    onChange((prev) => {
      const next = [...prev.groups, { rules: [], combinator: 'AND' as const }];
      return { groups: next, activeGroup: next.length - 1 };
    });
  }, [onChange]);

  const removeGroup = useCallback(
    (index: number) => {
      // The SAME logical group the user had open must stay open — mirrors
      // `searchSlice.filterGroups.ts`'s `removeFilterGroup`: clamping the
      // OLD numeric index alone is wrong once a PRECEDING group is removed,
      // because every group after `index` shifts left by one.
      onChange((prev) => {
        if (prev.groups.length <= 1 || index < 0 || index >= prev.groups.length) return prev;
        const next = prev.groups.filter((_, i) => i !== index);
        const nextActive = index < prev.activeGroup ? prev.activeGroup - 1 : prev.activeGroup;
        return { groups: next, activeGroup: clampGroupIndex(nextActive, next.length) };
      });
    },
    [onChange],
  );

  const setActiveGroup = useCallback(
    (index: number) => {
      onChange((prev) => ({ groups: prev.groups, activeGroup: clampGroupIndex(index, prev.groups.length) }));
    },
    [onChange],
  );

  const addRuleOfKind = useCallback(
    (kind: FilterRule['kind']) => {
      onChange((prev) => ({
        groups: updateActiveGroup(prev, (g) => ({ ...g, rules: [...g.rules, blankRuleOfKind(kind)] })),
        activeGroup: prev.activeGroup,
      }));
    },
    [onChange],
  );

  const updateRule = useCallback(
    (ruleIndex: number, next: FilterRule) => {
      onChange((prev) => ({
        groups: updateActiveGroup(prev, (g) => {
          if (ruleIndex < 0 || ruleIndex >= g.rules.length) return g;
          const rules = g.rules.slice();
          rules[ruleIndex] = next;
          return { ...g, rules };
        }),
        activeGroup: prev.activeGroup,
      }));
    },
    [onChange],
  );

  const removeRule = useCallback(
    (ruleIndex: number) => {
      onChange((prev) => ({
        groups: updateActiveGroup(prev, (g) => ({ ...g, rules: g.rules.filter((_, i) => i !== ruleIndex) })),
        activeGroup: prev.activeGroup,
      }));
    },
    [onChange],
  );

  const setCombinator = useCallback(
    (combinator: FilterGroup['combinator']) => {
      onChange((prev) => ({
        groups: updateActiveGroup(prev, (g) => ({ ...g, combinator })),
        activeGroup: prev.activeGroup,
      }));
    },
    [onChange],
  );

  const controls = (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CombinatorToggle value={active?.combinator ?? 'AND'} onChange={setCombinator} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={addGroup}
          className="h-7 gap-1 text-[11px]"
          title={t('filterGroups.addGroupTitle')}
        >
          <Plus className="h-3 w-3" /> {t('filterGroups.addGroup')}
        </Button>
      </div>

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
            modelOptions={modelOptions}
            onChange={(next) => updateRule(i, next)}
            onRemove={() => removeRule(i)}
          />
        ))}
        <AddRuleMenu onAdd={addRuleOfKind} allowedKinds={allowedKinds} />
      </div>
    </>
  );

  return (
    <GroupTabsPanel groups={groups} activeIndex={activeIndex} onSelect={setActiveGroup} onRemove={removeGroup}>
      {controls}
    </GroupTabsPanel>
  );
}
