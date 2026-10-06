/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The population an action applies to (U02, #6925): the current selection,
 * the filtered rows, or everything, each with its count. A scope with nothing
 * in it cannot be chosen, so "Selected (0)" never silently means "all".
 *
 * Callers pin the members of each scope when they open the action (an
 * export, a proposal, a batch); a later selection or filter change applies to
 * the next one only.
 */

import { SegmentedControl } from '@/components/ui/segmented-control';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';

export type ResultScope = 'selected' | 'filtered' | 'all';

interface ScopeControlProps {
  value: ResultScope;
  onValueChange: (scope: ResultScope) => void;
  counts: Readonly<Record<ResultScope, number>>;
  className?: string;
}

const SCOPES: readonly ResultScope[] = ['selected', 'filtered', 'all'];
const KEYS = { selected: 'resultScope.selected', filtered: 'resultScope.filtered', all: 'resultScope.all' } as const;

export function ScopeControl({ value, onValueChange, counts, className }: ScopeControlProps) {
  const { t, locale } = useTranslation();
  return (
    <SegmentedControl
      label={t('resultScope.label')}
      size="sm"
      className={className}
      value={value}
      onValueChange={onValueChange}
      options={SCOPES.map((scope) => ({
        value: scope,
        label: t(KEYS[scope], { count: formatLocaleNumber(locale, counts[scope]) }),
        disabled: counts[scope] === 0 && scope !== value,
      }))}
    />
  );
}
