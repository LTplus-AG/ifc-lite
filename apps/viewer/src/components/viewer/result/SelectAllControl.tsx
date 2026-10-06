/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Select all" that says which "all" it means (U02, #6925): the rows loaded
 * on this page, or every result matching the filters. The second is offered
 * only after the first and only when the population is larger than the page;
 * while its keys are being retrieved the control says so, and the caller's
 * complete-population actions stay disabled (`canActOnPopulation`).
 */

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTranslation } from '@/i18n';
import { formatLocaleNumber } from '@/i18n/intlFormat';
import type { ResultSelectionControls } from './useResultSelection';

interface SelectAllControlProps {
  selection: ResultSelectionControls;
  /** Keys of the rows loaded on screen. */
  pageKeys: readonly string[];
  /** Matching population size as the engine reports it. */
  populationTotal: number;
}

export function SelectAllControl({ selection, pageKeys, populationTotal }: SelectAllControlProps) {
  const { t, locale } = useTranslation();
  const { state, dispatch, selectPopulation } = selection;
  const n = (count: number) => ({ count, countDisplay: formatLocaleNumber(locale, count) });
  const pageIsPopulation = pageKeys.length >= populationTotal;
  const all = state.selectAll;
  const clear = (
    <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={() => dispatch({ type: 'clear' })}>
      {t('resultSelection.clear')}
    </Button>
  );

  // One live region, mounted from the start and never swapped: a region that
  // appears together with its first message is not announced by every screen
  // reader. It carries the selection status only; the controls sit beside it.
  let status: ReactNode = null;
  if (all?.scope === 'population') {
    status = all.state === 'resolving' ? <><Spinner size="sm" />{t('resultSelection.resolving', n(all.total))}</>
      : all.state === 'resolved' ? t('resultSelection.populationSelected', n(all.total))
        : <span className="text-destructive">{t('resultSelection.failed')}</span>;
  } else if (all?.scope === 'page') {
    status = t('resultSelection.pageSelected', n(all.count));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-2xs">
      <output aria-live="polite" className={status ? 'inline-flex items-center gap-1.5' : 'sr-only'}>{status}</output>
      {all?.scope === 'population' && all.state === 'failed' && (
        <Button variant="outline" size="sm" className="h-6 px-2 text-2xs" onClick={selectPopulation}>{t('resultSelection.retry')}</Button>
      )}
      {all?.scope === 'page' && (
        <Button variant="outline" size="sm" className="h-6 px-2 text-2xs" onClick={selectPopulation}>
          {t('resultSelection.selectPopulation', n(populationTotal))}
        </Button>
      )}
      {!all && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-2xs"
          disabled={pageKeys.length === 0}
          onClick={() => dispatch({ type: 'selectPage', keys: pageKeys, complete: pageIsPopulation })}
        >
          {t(pageIsPopulation ? 'resultSelection.selectEverything' : 'resultSelection.selectPage', n(pageKeys.length))}
        </Button>
      )}
      {(all || state.selected.size > 0) && clear}
    </div>
  );
}
