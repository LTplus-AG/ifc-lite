/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The read options of a `property` / `quantity` chip (`SubjectReadOptions`
 * in `@ifc-lite/rules`): whether its number is in SI units (#5225), and
 * where a missing value may be inherited from (#5433). Shared
 * by both editors, and kept out of `SearchModal.filter.editors.tsx` for size.
 */

import { useTranslation } from '@/i18n';
import type { FilterRule } from '@ifc-lite/rules';
import { cn } from '@/lib/utils';
import { InheritSelect } from './InheritSelect';

type MeasureRule = Extract<FilterRule, { kind: 'property' | 'quantity' }>;

export function ReadOptionControls({ rule, onChange }: { rule: MeasureRule; onChange: (next: FilterRule) => void }) {
  const { t } = useTranslation();
  const si = rule.valueUnit === 'si';
  return (
    <>
      <InheritSelect
        value={rule.inherit}
        offered={rule.kind === 'quantity' ? ['type', 'aggregation'] : ['aggregation']}
        onChange={(inherit) => onChange({ ...rule, inherit })}
      />
      <button
        type="button"
        aria-pressed={si}
        title={t('searchModal.filterEditors.siUnitsTitle')}
        onClick={() => onChange({ ...rule, valueUnit: si ? undefined : 'si' })}
        className={cn(
          'h-7 rounded border px-1.5 text-[10px] font-medium',
          si ? 'border-primary bg-primary text-primary-foreground' : 'border-zinc-300 text-muted-foreground dark:border-zinc-700',
        )}
      >
        {t('searchModal.filterEditors.siUnits')}
      </button>
    </>
  );
}
