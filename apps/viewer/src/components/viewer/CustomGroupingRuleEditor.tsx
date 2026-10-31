/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `customGrouping` chip editor (#8425), shared by every `RuleRow` host:
 * search filter, clash set filters, list scope, validation, Lens rules. The
 * groupings are the saved rule-based Lenses, read straight from the store so
 * no host has to pass them down. Op and group values reuse the generic set
 * editor; an unresolved grouping or group is shown, never hidden, because
 * the evaluator matches nothing for it.
 */

import { useMemo } from 'react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import {
  Rule, normalizeModelTagName as nameKey, resolveCustomGrouping, unresolvedCustomGrouping,
  type CustomGroupingRule, type FilterRule,
} from '@ifc-lite/rules';
import { customGroupingsFromLenses } from '@/lib/lens/custom-groupings';
import { SetRuleEditor } from './SearchModal.filter.editors.shared';

const NO_MODELS: [] = [];

export function CustomGroupingRuleEditor({ rule, onChange }: { rule: CustomGroupingRule; onChange: (next: FilterRule) => void }) {
  const { t } = useTranslation();
  const lenses = useViewerStore((s) => s.savedLenses);
  // Names only: the editor never evaluates, so captured scopes stay unresolved.
  const groupings = useMemo(() => customGroupingsFromLenses(lenses, NO_MODELS), [lenses]);
  const current = resolveCustomGrouping(rule.grouping, groupings);
  const unresolved = unresolvedCustomGrouping(rule, groupings);
  const groupOptions = useMemo(() => {
    const seen = new Set<string>();
    return (current?.members ?? []).filter((m) => {
      const key = nameKey(m.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((m) => ({ label: m.name, value: m.name }));
  }, [current]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" aria-label={t('customGrouping.pickGroupingAriaLabel')}>
            {current?.name ?? (rule.grouping.name || t('customGrouping.pickGroupingPlaceholder'))}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          {groupings.length === 0 && (
            <DropdownMenuItem disabled className="text-muted-foreground italic">{t('customGrouping.noGroupingsYet')}</DropdownMenuItem>
          )}
          {groupings.map((g) => (
            <DropdownMenuItem key={g.id} onSelect={() => onChange(Rule.customGrouping({ id: g.id, name: g.name }, rule.op, []))}>
              <span className="mr-2 inline-block w-3 text-center">{current?.id === g.id ? '✓' : ''}</span>
              {g.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {current && (
        <SetRuleEditor
          values={rule.values}
          op={rule.op}
          options={groupOptions}
          onChange={(values, op) => onChange(Rule.customGrouping(rule.grouping, op, values))}
        />
      )}
      {unresolved && rule.grouping.name && (
        <span role="alert" className="text-2xs text-amber-600 dark:text-amber-400">
          {'grouping' in unresolved
            ? t('customGrouping.unresolvedGrouping', { name: rule.grouping.name })
            : t('customGrouping.unresolvedGroups', { count: unresolved.groups.length, names: unresolved.groups.join(', ') })}
        </span>
      )}
    </>
  );
}
