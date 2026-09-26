/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FoldedGroupEditor` — the same chip editing `FilterGroupEditor` provides,
 * with an adjacent `gte`+`lte` pair on one subject displayed as a single
 * "between" range chip (#5138 plan §6's operator table; fold/unfold lives
 * in `@ifc-lite/rules's between-chip.ts`, its own pure-function test). Used
 * only by `RuleBlockEditor` for an `element` requirement's block —
 * applicability and `groupBy.universe` blocks render through
 * `FilterGroupEditor` directly, where two independent bounds on the same
 * subject are not a "between" the operator table offers.
 *
 * `RuleRow` / `AddRuleMenu` / `CombinatorToggle` are reused
 * unchanged; only the rule-list loop differs from `FilterGroupEditor`.
 */

import { useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FilterRule } from '@ifc-lite/rules';
import type { FilterGroup } from '@ifc-lite/rules';
import { useFilterRuleOptions } from '@/hooks/useFilterRuleOptions';
import { AddRuleMenu, CombinatorToggle, blankRuleOfKind } from '../FilterRuleControls';
import { RuleRow } from '../SearchModal.filter.editors';
import { GroupTabsPanel } from '../SearchModal.filter.groupTabs';
import { clampGroupIndex } from '@/store/slices/searchSlice.filterGroups';
import { foldBetweenPairs, unfoldBetweenChips, isBetweenChip, type FoldedRule } from '@ifc-lite/rules';
import type { FilterGroupEditorModel, FilterGroupEditorState } from '../FilterGroupEditor';
import { useTranslation } from '@/i18n';

export interface FoldedGroupEditorProps {
  groups: FilterGroup[];
  activeGroup: number;
  onChange: (updater: (prev: FilterGroupEditorState) => FilterGroupEditorState) => void;
  allowedKinds?: ReadonlySet<FilterRule['kind']>;
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

export function FoldedGroupEditor({ groups, activeGroup, onChange, allowedKinds, models }: FoldedGroupEditorProps) {
  const { t } = useTranslation();
  const activeIndex = clampGroupIndex(activeGroup, groups.length);
  const active = groups[activeIndex];
  const activeRules = active?.rules ?? [];
  const folded = foldBetweenPairs(activeRules);
  const ruleOptions = useFilterRuleOptions(activeRules);
  const modelOptions = models
    .filter((m) => m.sourceFingerprint !== undefined)
    .map((m) => ({ label: m.name, value: m.sourceFingerprint as string }));

  const replaceFolded = useCallback(
    (next: FoldedRule[]) => {
      onChange((prev) => ({
        groups: updateActiveGroup(prev, (g) => ({ ...g, rules: unfoldBetweenChips(next) })),
        activeGroup: prev.activeGroup,
      }));
    },
    [onChange],
  );

  const addGroup = useCallback(() => {
    onChange((prev) => {
      const next = [...prev.groups, { rules: [], combinator: 'AND' as const }];
      return { groups: next, activeGroup: next.length - 1 };
    });
  }, [onChange]);

  const removeGroup = useCallback(
    (index: number) => {
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

  const setCombinator = useCallback(
    (combinator: FilterGroup['combinator']) => {
      onChange((prev) => ({
        groups: updateActiveGroup(prev, (g) => ({ ...g, combinator })),
        activeGroup: prev.activeGroup,
      }));
    },
    [onChange],
  );

  const addRuleOfKind = useCallback(
    (kind: FilterRule['kind']) => replaceFolded([...folded, blankRuleOfKind(kind)]),
    [folded, replaceFolded],
  );

  return (
    <GroupTabsPanel groups={groups} activeIndex={activeIndex} onSelect={setActiveGroup} onRemove={removeGroup}>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <CombinatorToggle value={active?.combinator ?? 'AND'} onChange={setCombinator} />
        <Button type="button" variant="ghost" size="sm" onClick={addGroup} className="h-7 gap-1 text-2xs">
          <Plus className="h-3 w-3" /> {t('filterGroups.addGroup')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {folded.length === 0 && (
          <p className="rounded border border-dashed border-zinc-300 bg-zinc-50 px-3 py-3 text-center text-xs italic text-muted-foreground dark:border-zinc-800 dark:bg-zinc-900/30">
            {t('searchModal.filterBuilder.emptyRulesHint')}
          </p>
        )}
        {folded.map((row, i) =>
          isBetweenChip(row) ? (
            <BetweenChipRow
              key={i}
              chip={row}
              onChange={(next) => replaceFolded(folded.map((r, j) => (j === i ? next : r)))}
              onRemove={() => replaceFolded(folded.filter((_, j) => j !== i))}
            />
          ) : (
            <RuleRow
              key={i}
              rule={row}
              {...ruleOptions}
              modelOptions={modelOptions}
              onChange={(next) => replaceFolded(folded.map((r, j) => (j === i ? next : r)))}
              onRemove={() => replaceFolded(folded.filter((_, j) => j !== i))}
            />
          ),
        )}
        <AddRuleMenu onAdd={addRuleOfKind} allowedKinds={allowedKinds} />
      </div>
    </GroupTabsPanel>
  );
}

/** A folded `gte`+`lte` pair: one subject label, a min and a max number
 *  input, one remove button for the pair. */
function BetweenChipRow({
  chip,
  onChange,
  onRemove,
}: {
  chip: Extract<FoldedRule, { kind: 'between' }>;
  onChange: (next: FoldedRule) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const label = subjectLabel(chip.min);
  const setMin = (raw: string) => {
    const min = chip.min.kind === 'quantity' ? { ...chip.min, value: Number.parseFloat(raw) || 0 } : { ...chip.min, value: raw };
    onChange({ ...chip, min });
  };
  const setMax = (raw: string) => {
    const max = chip.max.kind === 'quantity' ? { ...chip.max, value: Number.parseFloat(raw) || 0 } : { ...chip.max, value: raw };
    onChange({ ...chip, max });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded border border-zinc-200 bg-white px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {t('validationEditor.betweenChip.label')}
      </span>
      <span className="font-mono text-xs">{label}</span>
      <Input
        type="number"
        aria-label={t('validationEditor.betweenChip.minAriaLabel')}
        value={String(chip.min.value)}
        onChange={(e) => setMin(e.target.value)}
        className="h-7 w-24 text-xs font-mono"
      />
      <span className="text-muted-foreground">{t('validationEditor.betweenChip.and')}</span>
      <Input
        type="number"
        aria-label={t('validationEditor.betweenChip.maxAriaLabel')}
        value={String(chip.max.value)}
        onChange={(e) => setMax(e.target.value)}
        className="h-7 w-24 text-xs font-mono"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('searchModal.filterEditors.removeRuleAriaLabel')}
        className="ml-auto rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function subjectLabel(rule: Extract<FoldedRule, { kind: 'between' }>['min']): string {
  if (rule.kind === 'quantity') return `${rule.setName}.${rule.quantityName}`;
  if (rule.kind === 'property') return `${rule.setName}.${rule.propertyName}`;
  return rule.name;
}
