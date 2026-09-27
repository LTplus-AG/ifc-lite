/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a property or quantity value may be inherited from (#5433), for the
 * rule chips and the list condition rows alike. `offered` lists the choices
 * that change anything in the caller's context: a property already reads
 * its type, and a list condition always falls back to the type, so neither
 * offers `'type'`.
 */

import { useTranslation } from '@/i18n';

export type InheritChoice = 'type' | 'aggregation';

export function InheritSelect({
  value,
  offered,
  onChange,
  className,
}: {
  value: InheritChoice | undefined;
  offered: readonly InheritChoice[];
  onChange: (next: InheritChoice | undefined) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const labels: Record<InheritChoice, string> = {
    type: t('searchModal.filterEditors.inherit.type'),
    aggregation: t('searchModal.filterEditors.inherit.aggregation'),
  };
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange((e.target.value || undefined) as InheritChoice | undefined)}
      aria-label={t('searchModal.filterEditors.inherit.ariaLabel')}
      className={className ?? 'h-7 rounded border border-zinc-300 bg-transparent px-1 text-2xs dark:border-zinc-700'}
    >
      <option value="">{t('searchModal.filterEditors.inherit.own')}</option>
      {offered.map((choice) => <option key={choice} value={choice}>{labels[choice]}</option>)}
    </select>
  );
}
